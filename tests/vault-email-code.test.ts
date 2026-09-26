import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type { LoginInspection } from '../src/ports/computer.ts';
import { createVault } from '../src/server/vault.ts';

const owner = 'local-development';
const origin = 'https://app20.toconline.pt';
const username = 'owner@example.com';
const code = '381742';
const input = { origin, label: 'Fixture login', kind: 'password' as const };
const otpInput = { ...input, kind: 'otp' as const };
function inspection(kind: 'password' | 'otp'): LoginInspection {
  return {
    origin,
    url: `${origin}/login`,
    fields: [{ kind, selector: `#${kind}`, label: kind }],
    methods: [{ id: 'credentials', kind: 'credentials', label: 'Sign in', supported: true }],
    submitSelector: '#submit',
    ...(kind === 'otp' ? { emailCode: { recipient: username, length: 6 } } : {}),
  };
}

test(
  'automatic email codes use a recent selected account once and recheck task, page and mailbox before fill',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `test_vault_email_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      "CREATE TABLE tasks(id text PRIMARY KEY,owner_id text NOT NULL,status text NOT NULL DEFAULT 'running',revision integer NOT NULL DEFAULT 0)",
    );
    const app = Fastify();
    t.after(async () => {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const pages = new Map<string, LoginInspection>();
    const injected: Array<{ taskId: string; code?: string }> = [];
    let read = 0;
    let lookup: (() => Promise<void>) | undefined;
    let available = true;
    let reject = false;
    let resultCode: string | undefined = code;
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => randomKey },
      inspect: async (id) => pages.get(id)!,
      inject: async (value) => {
        injected.push({ taskId: value.taskId, code: value.code });
        if (value.kind === 'password') pages.set(value.taskId, inspection('otp'));
        return { status: reject && value.kind === 'otp' ? 'rejected' : 'submitted' };
      },
      resume: async (id) => {
        await pool.query("UPDATE tasks SET revision=revision+1,status='running' WHERE id=$1", [id]);
      },
      retry: async () => {},
      emailCode: async (request, signal) => {
        read++;
        assert.equal(request.recipient, username);
        assert.equal(request.origin, origin);
        assert.equal(request.length, 6);
        assert.ok(request.after > Date.now() - 35_000);
        assert.ok(request.before <= Date.now());
        assert.equal(signal.aborted, false);
        await lookup?.();
        return resultCode ? { code: resultCode, current: async () => available } : undefined;
      },
    });
    const randomKey = randomBytes(32);
    vault.registerRoutes(app);
    const saved = (
      await app.inject({
        method: 'POST',
        url: '/api/vault',
        payload: { ...input, kind: 'login', username, password: 'fixture-private-password' },
      })
    ).json();
    assert.ok(saved.id);
    const start = async (id: string) => {
      await pool.query('INSERT INTO tasks(id,owner_id) VALUES($1,$2)', [id, owner]);
      pages.set(id, inspection('password'));
      await vault.fillSaved(id, owner, saved.id, input);
      assert.equal(pages.get(id)?.fields[0]?.kind, 'otp');
    };
    const fill = (id: string) => vault.fillEmailCode(id, owner, otpInput);
    await start('success');
    assert.equal(await fill('success'), true);
    assert.equal(await fill('success'), false);
    assert.equal(read, 1);
    assert.equal(injected.filter((value) => value.code).length, 1);
    await start('simultaneous');
    assert.deepEqual((await Promise.all([fill('simultaneous'), fill('simultaneous')])).sort(), [
      false,
      true,
    ]);
    assert.equal(read, 2);
    for (const [id, change] of [
      [
        'wrong-recipient',
        async (id: string) => {
          pages.get(id)!.emailCode!.recipient = 'other@example.com';
        },
      ],
      [
        'no-metadata',
        async (id: string) => {
          delete pages.get(id)!.emailCode;
        },
      ],
      [
        'wrong-origin',
        async (id: string) => {
          pages.get(id)!.origin = 'https://evil.com';
        },
      ],
      [
        'legacy',
        async (id: string) => {
          await pool.query(
            'UPDATE credential_account_selections SET credential_entered_at=NULL WHERE task_id=$1',
            [id],
          );
        },
      ],
      [
        'old-auth',
        async (id: string) => {
          await pool.query(
            "UPDATE credential_account_selections SET credential_entered_at=now()-interval '6 minutes' WHERE task_id=$1",
            [id],
          );
        },
      ],
      [
        'cancelled',
        async (id: string) => {
          await pool.query("UPDATE tasks SET status='cancelled',revision=revision+1 WHERE id=$1", [
            id,
          ]);
        },
      ],
    ] as const) {
      await start(id);
      await change(id);
      assert.equal(await fill(id), false, id);
      assert.equal(read, 2, id);
    }
    await start('wrong-owner');
    assert.equal(await vault.fillEmailCode('wrong-owner', 'other', otpInput), false);
    assert.equal(read, 2);
    for (const [id, change] of [
      [
        'late-cancel',
        async (id: string) => {
          await pool.query("UPDATE tasks SET status='cancelled',revision=revision+1 WHERE id=$1", [
            id,
          ]);
        },
      ],
      [
        'late-page',
        async (id: string) => {
          pages.get(id)!.emailCode!.recipient = 'other@example.com';
        },
      ],
      [
        'late-revision',
        async (id: string) => {
          await pool.query('UPDATE tasks SET revision=revision+1 WHERE id=$1', [id]);
        },
      ],
      [
        'late-expiry',
        async (id: string) => {
          await pool.query(
            'UPDATE credential_account_selections SET expires_at=now() WHERE task_id=$1',
            [id],
          );
        },
      ],
    ] as const) {
      await start(id);
      lookup = () => change(id);
      assert.equal(await fill(id), false, id);
      assert.equal(
        injected.some((value) => value.taskId === id && value.code),
        false,
        id,
      );
    }
    lookup = undefined;
    await start('revoked');
    available = false;
    assert.equal(await fill('revoked'), false);
    available = true;
    await start('missing');
    resultCode = undefined;
    assert.equal(await fill('missing'), false);
    resultCode = '3817';
    await start('wrong-length');
    assert.equal(await fill('wrong-length'), false);
    resultCode = code;
    await start('rejected');
    reject = true;
    assert.equal(await fill('rejected'), false);
    assert.equal(await fill('rejected'), false);
    reject = false;
    await pool.query('INSERT INTO tasks(id,owner_id) VALUES($1,$2)', ['manual-password', owner]);
    pages.set('manual-password', inspection('password'));
    const manual = await vault.request('manual-password', owner, input);
    await pool.query("UPDATE tasks SET status='waiting_credentials' WHERE id='manual-password'");
    const readsBeforePassword = read;
    assert.equal(await fill('manual-password'), false);
    assert.equal(read, readsBeforePassword);
    const submitted = await app.inject({
      method: 'POST',
      url: manual.url.replace('/vault/', '/api/credential-requests/'),
      payload: {
        label: 'Manually entered fixture',
        username,
        password: 'fixture-private-password',
      },
    });
    assert.equal(submitted.statusCode, 200);
    assert.equal(
      (
        await pool.query(
          "SELECT blocked FROM credential_account_selections WHERE task_id='manual-password'",
        )
      ).rows[0]?.blocked,
      true,
    );
    assert.equal(await fill('manual-password'), true);
    await start('provider-error');
    lookup = async () => {
      throw new Error('provider-private-mail 381742');
    };
    assert.equal(await fill('provider-error'), false);
    lookup = undefined;
    await start('entry-removed');
    lookup = async () => {
      await pool.query('DELETE FROM vault_entries WHERE id=$1', [saved.id]);
    };
    assert.equal(await fill('entry-removed'), false);
    const persisted = JSON.stringify([
      (await pool.query('SELECT * FROM credential_requests')).rows,
      (await pool.query('SELECT * FROM credential_account_selections')).rows,
      (await pool.query('SELECT * FROM credential_autofill_attempts')).rows,
    ]);
    for (const secret of [code, username, 'fixture-private-password', 'provider-private-mail'])
      assert.equal(persisted.includes(secret), false);
  },
);

test(
  'chat codes consume the exact pending owned request and rejected codes rotate without plaintext storage',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `test_chat_code_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      "CREATE TABLE tasks(id text PRIMARY KEY,owner_id text NOT NULL,status text NOT NULL DEFAULT 'running',revision integer NOT NULL DEFAULT 0)",
    );
    await pool.query('INSERT INTO tasks(id,owner_id) VALUES($1,$2),($3,$2)', [
      'chat',
      owner,
      'other',
    ]);
    const app = Fastify();
    t.after(async () => {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    let injected = 0;
    let reject = true;
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => randomBytes(32) },
      inspect: async () => inspection('otp'),
      inject: async (input) => {
        injected++;
        assert.equal(input.code, code);
        return { status: reject ? 'rejected' : 'submitted' };
      },
      resume: async (id) => {
        await pool.query("UPDATE tasks SET status='running',revision=revision+1 WHERE id=$1", [id]);
      },
      retry: async () => {},
    });
    vault.registerRoutes(app);
    await vault.request('chat', owner, otpInput);
    await pool.query("UPDATE tasks SET status='waiting_credentials' WHERE id='chat'");
    const pending = async () =>
      (
        await pool.query(
          "SELECT id FROM credential_requests WHERE task_id='chat' AND status='pending' ORDER BY id",
        )
      ).rows.map((row) => row.id as string);
    const requestId = (await pending())[0];
    assert.deepEqual(await vault.submitChatCode('other-owner', 'chat', code, requestId), {
      status: 'unavailable',
    });
    assert.deepEqual(await vault.submitChatCode(owner, 'other', code, requestId), {
      status: 'unavailable',
    });
    assert.deepEqual(await vault.submitChatCode(owner, 'chat', code, 'stale-request'), {
      status: 'unavailable',
    });
    assert.deepEqual(await vault.submitChatCode(owner, 'chat', 'my code 381742', requestId), {
      status: 'invalid',
    });
    assert.deepEqual(await vault.submitChatCode(owner, 'chat', '3817', requestId), {
      status: 'unavailable',
    });
    assert.equal(injected, 0);
    assert.deepEqual(await vault.submitChatCode(owner, 'chat', code, requestId), {
      status: 'rejected',
    });
    const retryId = (await pending())[0];
    assert.notEqual(retryId, requestId);
    assert.deepEqual(await vault.submitChatCode(owner, 'chat', code, requestId), {
      status: 'unavailable',
    });
    reject = false;
    assert.deepEqual(await vault.submitChatCode(owner, 'chat', code, retryId), {
      status: 'submitted',
    });
    assert.deepEqual(await vault.submitChatCode(owner, 'chat', code, retryId), {
      status: 'unavailable',
    });
    assert.equal(injected, 2);
    const persisted = JSON.stringify((await pool.query('SELECT * FROM credential_requests')).rows);
    for (const secret of [code, username, 'emailCode'])
      assert.equal(persisted.includes(secret), false);
  },
);
