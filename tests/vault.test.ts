import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { requestCredentials } from './vault-fixture.ts';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import {
  credentialOrigin,
  createVault,
  openCredential,
  sealCredential,
} from '../src/server/vault.ts';

async function seedTurns(pool: pg.Pool) {
  await pool.query(
    'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
  );
  await pool.query(
    "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text)",
  );
  const threads = new Map<string, string>();
  const turn = async (owner = 'local-development') => {
    let threadId = threads.get(owner);
    if (!threadId) {
      threadId = randomUUID();
      threads.set(owner, threadId);
      await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [threadId, owner]);
    }
    const turnId = randomUUID();
    await pool.query('INSERT INTO turns(id,owner_id,thread_id) VALUES($1,$2,$3)', [
      turnId,
      owner,
      threadId,
    ]);
    return { threadId, turnId };
  };
  const archive = async (owner = 'local-development') => {
    await pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [threads.get(owner)]);
    threads.delete(owner);
  };
  return { turn, archive };
}

test('vault encryption binds the secret to its record, owner, and exact origin', () => {
  const key = randomBytes(32);
  const entry = { id: randomUUID(), owner_id: 'local-development', origin: 'https://example.com' };
  const secret = { username: 'private@example.com', password: 'do-not-print-this-password' };
  const ciphertext = sealCredential(key, entry, secret);
  assert.equal(ciphertext.includes(secret.password), false);
  assert.deepEqual(openCredential(key, { ...entry, ciphertext }), secret);
  for (const replacement of [
    { id: randomUUID() },
    { owner_id: 'another-owner' },
    { origin: 'https://other.example.com' },
  ]) {
    assert.throws(() => openCredential(key, { ...entry, ...replacement, ciphertext }));
  }
  const damaged = Buffer.from(ciphertext, 'base64');
  damaged[damaged.length - 1] ^= 1;
  assert.throws(() => openCredential(key, { ...entry, ciphertext: damaged.toString('base64') }));
  assert.throws(() => openCredential(randomBytes(32), { ...entry, ciphertext }));
});

test('vault accepts exact HTTPS origins and explicit local development origins', () => {
  assert.equal(credentialOrigin('https://EXAMPLE.com:443/'), 'https://example.com');
  assert.equal(credentialOrigin('http://127.0.0.1:4310'), 'http://127.0.0.1:4310');
  for (const invalid of [
    'http://example.com',
    'file:///tmp/a',
    'https://user:password@example.com',
    'https://example.com/login',
    'https://example.com?key=secret',
    'https://example.com/#fragment',
  ]) {
    assert.throws(() => credentialOrigin(invalid));
  }
});

test(
  'vault stores only encrypted secrets, isolates requests, consumes once, and resumes after injection',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    const fixtureKey = randomBytes(32);
    const { turn } = await seedTurns(pool);
    const other = await turn('other-user');
    const task1 = await turn();
    const task2 = await turn();
    const expiredTask = await turn();
    let injected = 0;
    let resumed = 0;
    let complete: () => void = () => {};
    let started: () => void = () => {};
    const injectionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const injectionComplete = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => fixtureKey },
      retry: async () => {},
      inject: async (input) => {
        assert.equal(input.origin, 'https://example.com');
        assert.equal(input.password, 'secret-password');
        injected++;
        started();
        await injectionComplete;
      },
      resume: async () => {
        resumed++;
      },
    });
    vault.registerRoutes(app);
    try {
      const input = {
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password' as const,
        passwordSelector: '#password',
      };
      const hidden = await requestCredentials(vault, pool, other, 'other-user', input);
      assert.equal(
        (
          await app.inject({
            url: hidden.url.replace('/vault/', '/api/credential-requests/'),
          })
        ).statusCode,
        404,
      );
      const result = await requestCredentials(vault, pool, task1, 'local-development', input);
      const url = result.url.replace('/vault/', '/api/credential-requests/');
      const form = await app.inject({ url });
      assert.equal(form.statusCode, 200);
      assert.equal(form.headers['cache-control'], 'no-store');
      const first = app.inject({
        method: 'POST',
        url,
        payload: {
          label: 'Fixture login',
          username: 'person@example.com',
          password: 'secret-password',
        },
      });
      await injectionStarted;
      assert.equal(resumed, 0);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { label: 'Fixture login', password: 'second-secret' },
          })
        ).statusCode,
        409,
      );
      complete();
      assert.equal((await first).statusCode, 200);
      assert.equal(injected, 1);
      assert.equal(resumed, 1);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { label: 'Fixture login', password: 'secret-password' },
          })
        ).statusCode,
        409,
      );
      const metadata = await app.inject({ url: '/api/vault' });
      assert.equal(metadata.json().length, 1);
      assert.equal(metadata.body.includes('secret-password'), false);
      assert.equal(metadata.body.includes('person@example.com'), true);
      assert.equal(JSON.stringify(await vault.list()).includes('person@example.com'), false);
      const stored = await pool.query('SELECT * FROM vault_entries');
      assert.equal(JSON.stringify(stored.rows).includes('secret-password'), false);
      await assert.rejects(vault.fillSaved(task2, 'another-owner', stored.rows[0].id, input));
      await assert.rejects(
        vault.fillSaved(task2, 'local-development', stored.rows[0].id, {
          ...input,
          origin: 'https://other.example.com',
        }),
      );
      await vault.fillSaved(task2, 'local-development', stored.rows[0].id, input);
      assert.equal(injected, 2);
      assert.equal(resumed, 1);
      await assert.rejects(
        vault.fillSaved(task2, 'local-development', stored.rows[0].id, input),
        /fresh credentials/,
      );
      await pool.query("UPDATE turns SET status='running',waiting_reason=NULL WHERE id=$1", [
        task1.turnId,
      ]);
      await assert.rejects(
        vault.fillSaved(task1, 'local-development', stored.rows[0].id, input),
        /fresh credentials/,
      );
      assert.equal(injected, 2);
      const requests = await pool.query('SELECT * FROM credential_requests');
      assert.equal(JSON.stringify(requests.rows).includes('secret-password'), false);
      assert.equal(JSON.stringify(requests.rows).includes(result.url.split('/').at(-1)!), false);
      const expired = await requestCredentials(
        vault,
        pool,
        expiredTask,
        'local-development',
        input,
      );
      await pool.query(
        "UPDATE credential_requests SET expires_at = now() - interval '1 second' WHERE turn_id = $1",
        [expiredTask.turnId],
      );
      const expiredUrl = expired.url.replace('/vault/', '/api/credential-requests/');
      assert.equal((await app.inject({ url: expiredUrl })).json().status, 'expired');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: expiredUrl,
            payload: { label: 'Fixture login', password: 'expired-secret' },
          })
        ).statusCode,
        409,
      );
    } finally {
      complete();
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'OTP failures return safe errors, allow fresh input, and never persist the code',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    const fixtureKey = randomBytes(32);
    const { turn } = await seedTurns(pool);
    const otpTask = await turn();
    let calls = 0;
    let resumeAttempts = 0;
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => fixtureKey },
      retry: async () => {},
      inject: async (input) => {
        calls++;
        if (calls === 1) throw new Error(`Provider leaked ${input.code}`);
      },
      resume: async () => {
        resumeAttempts++;
        if (resumeAttempts === 1) throw new Error('Queue temporarily unavailable');
      },
    });
    vault.registerRoutes(app);
    try {
      const request = await requestCredentials(vault, pool, otpTask, 'local-development', {
        origin: 'https://example.com',
        label: 'Verification',
        kind: 'otp',
        passwordSelector: '#code',
      });
      const url = request.url.replace('/vault/', '/api/credential-requests/');
      const failed = await app.inject({ method: 'POST', url, payload: { code: '123456' } });
      assert.equal(failed.statusCode, 502);
      assert.equal(failed.body.includes('123456'), false);
      assert.equal((await app.inject({ url })).json().status, 'pending');
      assert.equal(
        (await app.inject({ method: 'POST', url, payload: { code: '789012' } })).statusCode,
        200,
      );
      assert.equal(
        (await pool.query('SELECT * FROM credential_requests WHERE resume_pending = true'))
          .rowCount,
        1,
      );
      await vault.resumePending();
      assert.equal(
        (await pool.query('SELECT * FROM credential_requests WHERE resume_pending = true'))
          .rowCount,
        0,
      );
      assert.equal(calls, 2);
      assert.equal((await pool.query('SELECT * FROM vault_entries')).rowCount, 0);
      assert.equal(
        JSON.stringify((await pool.query('SELECT * FROM credential_requests')).rows).includes(
          '789012',
        ),
        false,
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'failed autofill requires fresh input and interrupted forms recover after restart',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    let app = Fastify();
    const fixtureKey = randomBytes(32);
    const { turn } = await seedTurns(pool);
    const taskRetry = await turn();
    const taskInterrupted = await turn();
    let attempts = 0;
    const options = {
      keyStore: { id: 'fixture', configured: true, getKey: async () => fixtureKey },
      retry: async () => {},
      inject: async () => {
        attempts++;
        if (attempts === 1) throw new Error('Synthetic injection failure');
      },
      resume: async () => {},
    };
    const vault = await createVault(pool, options);
    vault.registerRoutes(app);
    try {
      const saved = await app.inject({
        method: 'POST',
        url: '/api/vault',
        payload: {
          label: 'Example',
          origin: 'https://example.com',
          username: 'person',
          password: 'old-password',
        },
      });
      const input = {
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password' as const,
        passwordSelector: '#password',
      };
      await assert.rejects(vault.fillSaved(taskRetry, 'local-development', saved.json().id, input));
      await assert.rejects(
        vault.fillSaved(taskRetry, 'local-development', saved.json().id, input),
        /fresh credentials/,
      );
      assert.equal(attempts, 1);
      const retry = await requestCredentials(vault, pool, taskRetry, 'local-development', input);
      const response = await app.inject({
        method: 'POST',
        url: retry.url.replace('/vault/', '/api/credential-requests/'),
        payload: { label: 'Fixture login', username: 'person', password: 'replacement-password' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(attempts, 2);
      const interrupted = await requestCredentials(
        vault,
        pool,
        taskInterrupted,
        'local-development',
        input,
      );
      await pool.query("UPDATE credential_requests SET status = 'processing' WHERE turn_id = $1", [
        taskInterrupted.turnId,
      ]);
      await app.close();
      app = Fastify();
      const restarted = await createVault(pool, options);
      restarted.registerRoutes(app);
      const url = interrupted.url.replace('/vault/', '/api/credential-requests/');
      assert.equal((await app.inject({ url })).json().status, 'pending');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { label: 'Fixture login', password: 'fresh-after-restart' },
          })
        ).statusCode,
        200,
      );
      assert.equal(attempts, 3);
      await pool.query("UPDATE turns SET status='running',waiting_reason=NULL WHERE id=$1", [
        taskInterrupted.turnId,
      ]);
      await assert.rejects(
        restarted.fillSaved(taskInterrupted, 'local-development', saved.json().id, input),
        /fresh credentials/,
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'credential retry restarts only pending expired forms and stale forms never inject',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const { turn, archive } = await seedTurns(pool);
    const task1 = await turn();
    const task2 = await turn();
    const app = Fastify();
    const key = randomBytes(32);
    let injected = 0;
    let keyReads = 0;
    const retried: string[] = [];
    let failInjection = false;
    const vault = await createVault(pool, {
      keyStore: {
        id: 'fixture',
        configured: true,
        getKey: async () => {
          keyReads++;
          return key;
        },
      },
      inject: async () => {
        injected++;
        if (failInjection) throw new Error('Synthetic browser failure');
      },
      resume: async () => {},
      retry: async (turnId) => {
        retried.push(turnId);
      },
    });
    vault.registerRoutes(app);
    try {
      const input = {
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password' as const,
        passwordSelector: '#password',
      };
      const request = await requestCredentials(vault, pool, task1, 'local-development', input);
      const url = request.url.replace('/vault/', '/api/credential-requests/');
      assert.equal((await app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 409);
      await pool.query(
        "UPDATE credential_requests SET expires_at=now()-interval '1 second' WHERE turn_id=$1",
        [task1.turnId],
      );
      assert.equal((await app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 200);
      assert.deepEqual(retried, [task1.turnId]);
      assert.equal(injected, 0);
      assert.equal(keyReads, 0);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { label: 'Fixture login', password: 'stale-secret' },
          })
        ).statusCode,
        409,
      );
      await pool.query("UPDATE turns SET status='running',waiting_reason=NULL WHERE id=$1", [
        task1.turnId,
      ]);
      const fresh = await requestCredentials(vault, pool, task1, 'local-development', input);
      const freshUrl = fresh.url.replace('/vault/', '/api/credential-requests/');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { label: 'Fixture login', password: 'stale-secret' },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: freshUrl,
            payload: { label: 'Fixture login', password: 'fresh-secret' },
          })
        ).statusCode,
        200,
      );
      assert.equal(injected, 1);
      assert.equal(
        (await app.inject({ method: 'POST', url: `${freshUrl}/retry` })).statusCode,
        409,
      );
      const entry = (await vault.list())[0];
      await pool.query("UPDATE turns SET status='running',waiting_reason=NULL WHERE id=$1", [
        task1.turnId,
      ]);
      await assert.rejects(
        vault.fillSaved(task1, 'local-development', entry.id, input),
        /fresh credentials/,
      );
      const archived = await requestCredentials(vault, pool, task2, 'local-development', input);
      await archive();
      const archivedUrl = archived.url.replace('/vault/', '/api/credential-requests/');
      assert.equal((await app.inject({ url: archivedUrl })).json().status, 'expired');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: archivedUrl,
            payload: { label: 'Fixture login', password: 'archived-secret' },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: `${archivedUrl}/retry` })).statusCode,
        409,
      );
      await assert.rejects(
        vault.request(task2, 'local-development', input),
        /no longer request credentials/,
      );
      assert.equal(injected, 1);
      failInjection = true;
      const taskRetry = await turn();
      const failed = await requestCredentials(vault, pool, taskRetry, 'local-development', input);
      const failedUrl = failed.url.replace('/vault/', '/api/credential-requests/');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: failedUrl,
            payload: { label: 'Fixture login', password: 'failed-secret' },
          })
        ).statusCode,
        502,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: `${failedUrl}/retry` })).statusCode,
        200,
      );
      assert.deepEqual(retried, [task1.turnId, taskRetry.turnId]);
      assert.equal(injected, 2);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'an expired credential link restarts the credential step only once',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const { turn } = await seedTurns(pool);
    const task = await turn();
    const app = Fastify();
    const retried: string[] = [];
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => randomBytes(32) },
      inject: async () => {},
      resume: async () => {},
      retry: async (turnId) => {
        retried.push(turnId);
      },
    });
    vault.registerRoutes(app);
    try {
      const request = await requestCredentials(vault, pool, task, 'local-development', {
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password',
        passwordSelector: '#password',
      });
      const url = request.url.replace('/vault/', '/api/credential-requests/');
      await pool.query(
        "UPDATE credential_requests SET expires_at=now()-interval '1 second' WHERE turn_id=$1",
        [task.turnId],
      );
      const concurrent = await Promise.all([
        app.inject({ method: 'POST', url: `${url}/retry` }),
        app.inject({ method: 'POST', url: `${url}/retry` }),
      ]);
      assert.deepEqual(concurrent.map((result) => result.statusCode).sort(), [200, 409]);
      assert.equal((await app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 409);
      assert.deepEqual(retried, [task.turnId]);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'legacy task credential forms expire without retry, injection or changing saved entries',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await seedTurns(pool);
    await pool.query(
      `CREATE TABLE credential_requests(id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, task_id text NOT NULL, owner_id text NOT NULL,
       origin text NOT NULL, label text NOT NULL, kind text NOT NULL, status text NOT NULL DEFAULT 'pending', selectors jsonb NOT NULL,
       expires_at timestamptz NOT NULL, resume_pending boolean NOT NULL DEFAULT false, task_revision integer NOT NULL DEFAULT 0,
       failed_at timestamptz, inspection jsonb)`,
    );
    const token = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO credential_requests(id,token_hash,task_id,owner_id,origin,label,kind,selectors,expires_at,resume_pending,task_revision,inspection)
       VALUES($1,$2,'legacy-task','local-development','https://example.com','Fixture','password',$3,now()+interval '10 minutes',true,3,'{}')`,
      [
        randomUUID(),
        createHash('sha256').update(token).digest('hex'),
        JSON.stringify({
          origin: 'https://example.com',
          label: 'Fixture',
          kind: 'password',
          passwordSelector: '#password',
        }),
      ],
    );
    const app = Fastify();
    const key = randomBytes(32);
    let retried = 0;
    let injected = 0;
    let resumed = 0;
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      inject: async () => {
        injected++;
      },
      resume: async () => {
        resumed++;
      },
      retry: async () => {
        retried++;
      },
    });
    vault.registerRoutes(app);
    try {
      const saved = await app.inject({
        method: 'POST',
        url: '/api/vault',
        payload: {
          label: 'Fixture',
          origin: 'https://example.com',
          username: 'person',
          password: 'legacy-secret',
        },
      });
      const encrypted = (
        await pool.query('SELECT ciphertext FROM vault_entries WHERE id=$1', [saved.json().id])
      ).rows[0].ciphertext;
      const legacy = (
        await pool.query(
          "SELECT expires_at<=now() AS expired,resume_pending FROM credential_requests WHERE task_id='legacy-task'",
        )
      ).rows[0];
      assert.deepEqual(legacy, { expired: true, resume_pending: false });
      const url = `/api/credential-requests/${token}`;
      assert.equal((await app.inject({ url })).json().status, 'expired');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { label: 'Fixture login', password: 'do-not-inject' },
          })
        ).statusCode,
        409,
      );
      assert.equal((await app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 409);
      await vault.resumePending();
      assert.deepEqual({ retried, injected, resumed }, { retried: 0, injected: 0, resumed: 0 });
      assert.equal(
        (await pool.query('SELECT ciphertext FROM vault_entries WHERE id=$1', [saved.json().id]))
          .rows[0].ciphertext,
        encrypted,
      );
      assert.equal(
        openCredential(
          key,
          (await pool.query('SELECT * FROM vault_entries WHERE id=$1', [saved.json().id])).rows[0],
        ).password,
        'legacy-secret',
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
