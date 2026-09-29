import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type { LoginInspection } from '../src/ports/computer.ts';
import { createVault } from '../src/server/vault.ts';
import type { TurnRef } from '../src/server/thread.ts';

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

async function seedTurns(pool: pg.Pool) {
  await pool.query(
    'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
  );
  await pool.query(
    "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running')",
  );
  let threadId = '';
  const tasks = new Map<string, TurnRef>();
  const archive = async () => {
    if (threadId) await pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [threadId]);
    threadId = randomUUID();
    await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [threadId, owner]);
  };
  await archive();
  const start = async (name: string, resumeOf?: string) => {
    const turn = { threadId, turnId: randomUUID() };
    await pool.query(
      'INSERT INTO turns(id,owner_id,thread_id,source,source_id) VALUES($1,$2,$3,$4,$5)',
      [
        turn.turnId,
        owner,
        turn.threadId,
        resumeOf ? 'resume' : 'user',
        resumeOf ? `credentials:${resumeOf}` : null,
      ],
    );
    tasks.set(name, turn);
    return turn;
  };
  const resume = async (turnId: string) => {
    const name = [...tasks].find(([, value]) => value.turnId === turnId)?.[0];
    if (!name) return;
    await pool.query("UPDATE turns SET status='waiting' WHERE id=$1 AND status='running'", [
      turnId,
    ]);
    await start(name, turnId);
  };
  return { task: (name: string) => tasks.get(name)!, start, resume, archive };
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
    const turns = await seedTurns(pool);
    const { task } = turns;
    const app = Fastify();
    t.after(async () => {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const pages = new Map<string, LoginInspection>();
    const injected: Array<{ threadId: string; code?: string }> = [];
    let read = 0;
    let lookup: (() => Promise<void>) | undefined;
    let available = true;
    let reject = false;
    let resultCode: string | undefined = code;
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => randomKey },
      inspect: async (id) => pages.get(id)!,
      inject: async (value) => {
        injected.push({ threadId: value.threadId, code: value.code });
        if (value.kind === 'password') pages.set(value.threadId, inspection('otp'));
        return { status: reject && value.kind === 'otp' ? 'rejected' : 'submitted' };
      },
      resume: turns.resume,
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
    const page = (id: string) => pages.get(task(id).threadId)!;
    const start = async (id: string) => {
      const turn = await turns.start(id);
      pages.set(turn.threadId, inspection('password'));
      await vault.fillSaved(turn, owner, saved.id, input);
      assert.equal(page(id).fields[0]?.kind, 'otp');
    };
    const fill = (id: string) => vault.fillEmailCode(task(id), owner, otpInput);
    const root = (id: string) => task(id).turnId;
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
          page(id).emailCode!.recipient = 'other@example.com';
        },
      ],
      [
        'no-metadata',
        async (id: string) => {
          delete page(id).emailCode;
        },
      ],
      [
        'wrong-origin',
        async (id: string) => {
          page(id).origin = 'https://evil.com';
        },
      ],
      [
        'legacy',
        async (id: string) => {
          await pool.query(
            'UPDATE credential_account_selections SET credential_entered_at=NULL WHERE root_turn_id=$1',
            [root(id)],
          );
        },
      ],
      [
        'old-auth',
        async (id: string) => {
          await pool.query(
            "UPDATE credential_account_selections SET credential_entered_at=now()-interval '6 minutes' WHERE root_turn_id=$1",
            [root(id)],
          );
        },
      ],
      [
        'cancelled',
        async (id: string) => {
          await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [task(id).turnId]);
        },
      ],
    ] as const) {
      await start(id);
      await change(id);
      assert.equal(await fill(id), false, id);
      assert.equal(read, 2, id);
    }
    await start('wrong-owner');
    assert.equal(await vault.fillEmailCode(task('wrong-owner'), 'other', otpInput), false);
    assert.equal(read, 2);
    for (const [id, change] of [
      [
        'late-cancel',
        async (id: string) => {
          await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [task(id).turnId]);
        },
      ],
      [
        'late-page',
        async (id: string) => {
          page(id).emailCode!.recipient = 'other@example.com';
        },
      ],
      [
        'late-archive',
        async () => {
          await turns.archive();
        },
      ],
      [
        'late-expiry',
        async (id: string) => {
          await pool.query(
            'UPDATE credential_account_selections SET expires_at=now() WHERE root_turn_id=$1',
            [root(id)],
          );
        },
      ],
    ] as const) {
      await start(id);
      lookup = () => change(id);
      const codes = injected.filter((value) => value.code).length;
      assert.equal(await fill(id), false, id);
      assert.equal(injected.filter((value) => value.code).length, codes, id);
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
    const manualTurn = await turns.start('manual-password');
    pages.set(manualTurn.threadId, inspection('password'));
    const manual = await vault.request(manualTurn, owner, input);
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
          'SELECT blocked FROM credential_account_selections WHERE root_turn_id=$1',
          [manualTurn.turnId],
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
    const turns = await seedTurns(pool);
    const chat = await turns.start('chat');
    const other = await turns.start('other');
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
      resume: turns.resume,
      retry: async () => {},
    });
    vault.registerRoutes(app);
    await vault.request(chat, owner, otpInput);
    const pending = async () =>
      (
        await pool.query(
          "SELECT id FROM credential_requests WHERE turn_id=$1 AND status='pending' ORDER BY id",
          [chat.turnId],
        )
      ).rows.map((row) => row.id as string);
    const requestId = (await pending())[0];
    assert.deepEqual(await vault.submitChatCode('other-owner', chat.turnId, code, requestId), {
      status: 'unavailable',
    });
    assert.deepEqual(await vault.submitChatCode(owner, other.turnId, code, requestId), {
      status: 'unavailable',
    });
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, code, 'stale-request'), {
      status: 'unavailable',
    });
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, 'my code 381742', requestId), {
      status: 'invalid',
    });
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, '3817', requestId), {
      status: 'unavailable',
    });
    assert.equal(injected, 0);
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, code, requestId), {
      status: 'rejected',
    });
    const retryId = (await pending())[0];
    assert.notEqual(retryId, requestId);
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, code, requestId), {
      status: 'unavailable',
    });
    reject = false;
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, code, retryId), {
      status: 'submitted',
    });
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, code, retryId), {
      status: 'unavailable',
    });
    assert.equal(injected, 2);
    const persisted = JSON.stringify((await pool.query('SELECT * FROM credential_requests')).rows);
    for (const secret of [code, username, 'emailCode'])
      assert.equal(persisted.includes(secret), false);
  },
);
