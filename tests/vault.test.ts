import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import {
  credentialOrigin,
  createVault,
  openCredential,
  sealCredential,
} from '../src/server/vault.ts';

async function seedTasks(pool: pg.Pool) {
  await pool.query(
    "CREATE TABLE tasks(id text PRIMARY KEY,owner_id text NOT NULL,revision integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'waiting_credentials')",
  );
  for (const id of [
    'task-1',
    'task-2',
    'expired-task',
    'otp-task',
    'task-retry',
    'task-interrupted',
  ]) {
    await pool.query("INSERT INTO tasks(id,owner_id) VALUES($1,'local-development')", [id]);
  }
  await pool.query("INSERT INTO tasks(id,owner_id) VALUES('other-task','other-user')");
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
    await seedTasks(pool);
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
      const hidden = await vault.request('other-task', 'other-user', input);
      assert.equal(
        (
          await app.inject({
            url: hidden.url.replace('/vault/', '/api/credential-requests/'),
          })
        ).statusCode,
        404,
      );
      const result = await vault.request('task-1', 'local-development', input);
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
      await assert.rejects(vault.fillSaved('task-2', 'another-owner', stored.rows[0].id, input));
      await assert.rejects(
        vault.fillSaved('task-2', 'local-development', stored.rows[0].id, {
          ...input,
          origin: 'https://other.example.com',
        }),
      );
      await vault.fillSaved('task-2', 'local-development', stored.rows[0].id, input);
      assert.equal(injected, 2);
      assert.equal(resumed, 1);
      await assert.rejects(
        vault.fillSaved('task-2', 'local-development', stored.rows[0].id, input),
        /fresh credentials/,
      );
      await assert.rejects(
        vault.fillSaved('task-1', 'local-development', stored.rows[0].id, input),
        /fresh credentials/,
      );
      assert.equal(injected, 2);
      const requests = await pool.query('SELECT * FROM credential_requests');
      assert.equal(JSON.stringify(requests.rows).includes('secret-password'), false);
      assert.equal(JSON.stringify(requests.rows).includes(result.url.split('/').at(-1)!), false);
      const expired = await vault.request('expired-task', 'local-development', input);
      await pool.query(
        "UPDATE credential_requests SET expires_at = now() - interval '1 second' WHERE task_id = 'expired-task'",
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
    await seedTasks(pool);
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
      const request = await vault.request('otp-task', 'local-development', {
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
    await seedTasks(pool);
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
      await assert.rejects(
        vault.fillSaved('task-retry', 'local-development', saved.json().id, input),
      );
      await assert.rejects(
        vault.fillSaved('task-retry', 'local-development', saved.json().id, input),
        /fresh credentials/,
      );
      assert.equal(attempts, 1);
      const retry = await vault.request('task-retry', 'local-development', input);
      const response = await app.inject({
        method: 'POST',
        url: retry.url.replace('/vault/', '/api/credential-requests/'),
        payload: { label: 'Fixture login', username: 'person', password: 'replacement-password' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(attempts, 2);
      const interrupted = await vault.request('task-interrupted', 'local-development', input);
      await pool.query(
        "UPDATE credential_requests SET status = 'processing' WHERE task_id = 'task-interrupted'",
      );
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
      await assert.rejects(
        restarted.fillSaved('task-interrupted', 'local-development', saved.json().id, input),
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
  'credential retry advances only the current waiting step and stale forms never inject',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await seedTasks(pool);
    const app = Fastify();
    const key = randomBytes(32);
    let injected = 0;
    let keyReads = 0;
    let retries = 0;
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
      retry: async (taskId, revision) => {
        const result = await pool.query(
          "UPDATE tasks SET revision=revision+1,status='queued' WHERE id=$1 AND revision=$2 AND status='waiting_credentials'",
          [taskId, revision],
        );
        if (!result.rowCount) throw Object.assign(new Error('Not current'), { statusCode: 409 });
        retries++;
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
      const request = await vault.request('task-1', 'local-development', input);
      const url = request.url.replace('/vault/', '/api/credential-requests/');
      assert.equal((await app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 409);
      await pool.query(
        "UPDATE credential_requests SET expires_at=now()-interval '1 second' WHERE task_id='task-1'",
      );
      const retried = await Promise.all([
        app.inject({ method: 'POST', url: `${url}/retry` }),
        app.inject({ method: 'POST', url: `${url}/retry` }),
      ]);
      assert.deepEqual(retried.map((result) => result.statusCode).sort(), [200, 409]);
      assert.equal(retries, 1);
      assert.equal(injected, 0);
      assert.equal(keyReads, 0);
      assert.equal((await app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 409);
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
      await pool.query("UPDATE tasks SET status='waiting_credentials' WHERE id='task-1'");
      const fresh = await vault.request('task-1', 'local-development', input);
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
      await assert.rejects(
        vault.fillSaved('task-1', 'local-development', entry.id, input),
        /fresh credentials/,
      );
      const cancelled = await vault.request('task-2', 'local-development', input);
      await pool.query("UPDATE tasks SET status='cancelled' WHERE id='task-2'");
      const cancelledUrl = cancelled.url.replace('/vault/', '/api/credential-requests/');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: cancelledUrl,
            payload: { label: 'Fixture login', password: 'cancelled-secret' },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: `${cancelledUrl}/retry` })).statusCode,
        409,
      );
      assert.equal(injected, 1);
      failInjection = true;
      const failed = await vault.request('task-retry', 'local-development', input);
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
      assert.equal(retries, 2);
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
  'legacy credential forms expire for safe retry without changing encrypted saved entries',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await seedTasks(pool);
    let app = Fastify();
    const key = randomBytes(32);
    let retriedRevision = -1;
    let injected = 0;
    const options = {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      inject: async () => {
        injected++;
      },
      resume: async () => {},
      retry: async (_taskId: string, revision: number) => {
        retriedRevision = revision;
      },
    };
    const original = await createVault(pool, options);
    original.registerRoutes(app);
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
      const request = await original.request('task-1', 'local-development', {
        origin: 'https://example.com',
        label: 'Fixture',
        kind: 'password',
        passwordSelector: '#password',
      });
      await pool.query('ALTER TABLE credential_requests DROP COLUMN task_revision');
      await pool.query("UPDATE tasks SET revision=3 WHERE id='task-1'");
      await app.close();
      app = Fastify();
      const migrated = await createVault(pool, options);
      migrated.registerRoutes(app);
      const url = request.url.replace('/vault/', '/api/credential-requests/');
      const expiry = (
        await pool.query(
          'SELECT expires_at,expires_at<=now() AS expired FROM credential_requests WHERE task_id=$1',
          ['task-1'],
        )
      ).rows[0];
      assert.equal(expiry.expired, true);
      const clock = t.mock.method(
        Date,
        'now',
        () => new Date(expiry.expires_at).getTime() - 60_000,
      );
      try {
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
      } finally {
        clock.mock.restore();
      }
      assert.equal((await app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 200);
      assert.equal(retriedRevision, 3);
      assert.equal(injected, 0);
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
