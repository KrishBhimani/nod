import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createChatVerification } from '../src/server/chat-verification.ts';

test(
  'chat verification intercepts owned codes before message routing and plaintext persistence',
  {
    skip: !process.env.TEST_DATABASE_URL,
    timeout: 30_000,
  },
  async (t) => {
    const schema = `test_chat_codes_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { ownerId, port, configuration } = await import('../src/server/config.ts');
    await db.initializeDatabase();
    await tasks.initializeTaskSchema();
    await db.pool.query(`CREATE TABLE credential_requests (
    id text PRIMARY KEY,task_id text NOT NULL,owner_id text NOT NULL,kind text NOT NULL,
    status text NOT NULL DEFAULT 'pending',task_revision integer NOT NULL DEFAULT 0,
    expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
  )`);
    const ordinary: string[] = [];
    const injected: Array<{ owner: string; taskId: string; code: string; requestId: string }> = [];
    let outcome: 'submitted' | 'rejected' | 'unavailable' = 'submitted';
    let hold: Promise<void> | undefined;
    let started: (() => void) | undefined;
    let throwPrivateError = false;
    const verification = await createChatVerification(db.pool, {
      ownerId,
      keyStore: { getKey: async () => Buffer.alloc(32, 61) },
      refresh() {},
      async submitCode(owner, taskId, code, requestId) {
        injected.push({ owner, taskId, code, requestId });
        started?.();
        await hold;
        if (throwPrivateError) throw new Error(`Untrusted website echoed ${code}`);
        if (outcome === 'submitted') {
          await db.pool.query("UPDATE credential_requests SET status='filled' WHERE id=$1", [
            requestId,
          ]);
          await db.pool.query("UPDATE tasks SET status='running',revision=revision+1 WHERE id=$1", [
            taskId,
          ]);
        }
        return { status: outcome };
      },
    });
    const app = await createApp({
      verification,
      configuration: () => ({ ...configuration(), llmReady: true }),
      submitMessage: async (text, _attachments, input) => {
        ordinary.push(text);
        return { taskId: randomUUID(), continued: false, messageId: input?.clientMessageId };
      },
    });
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    const send = (text: string, extra: Record<string, unknown> = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/messages',
        headers,
        payload: { text, clientMessageId: randomUUID(), conversationRevision: 0, ...extra },
      });
    async function seed(
      options: {
        owner?: string;
        channel?: string;
        status?: string;
        kind?: string;
        revision?: number;
        requestRevision?: number;
        expired?: boolean;
        generation?: number;
      } = {},
    ) {
      const taskId = randomUUID();
      const requestId = randomUUID();
      const messageId = randomUUID();
      await db.pool.query(
        `INSERT INTO tasks(id,owner_id,title,prompt,status,channel,revision,conversation_revision)
      VALUES($1,$2,'Sign in','Sign in',$3,$4,$5,$6)`,
        [
          taskId,
          options.owner ?? ownerId,
          options.status ?? 'waiting_credentials',
          options.channel ?? 'web',
          options.revision ?? 0,
          options.generation ?? 0,
        ],
      );
      await db.pool.query(
        `INSERT INTO credential_requests(id,task_id,owner_id,kind,task_revision,expires_at)
      VALUES($1,$2,$3,$4,$5,now()+$6::interval)`,
        [
          requestId,
          taskId,
          options.owner ?? ownerId,
          options.kind ?? 'otp',
          options.requestRevision ?? 0,
          options.expired ? '-1 minute' : '10 minutes',
        ],
      );
      await db.pool.query(
        "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,$2,'assistant','Reply with the verification code.',$3)",
        [messageId, options.owner ?? ownerId, taskId],
      );
      return { taskId, requestId, messageId };
    }
    async function reset() {
      await db.pool.query(
        'DELETE FROM chat_verification_submissions; DELETE FROM messages; DELETE FROM credential_requests; DELETE FROM tasks; DELETE FROM conversations',
      );
      ordinary.length = 0;
      injected.length = 0;
      outcome = 'submitted';
      hold = undefined;
      started = undefined;
      throwPrivateError = false;
    }
    try {
      await t.test(
        'an exact code bypasses ordinary routing and saves only a masked acknowledgement',
        async () => {
          await reset();
          const request = await seed();
          const before = (await app.inject({ url: '/api/state', headers })).json();
          assert.equal(before.verificationRequests[0].id, request.requestId);
          assert.deepEqual(Object.keys(before.verificationRequests[0]).sort(), [
            'expiresAt',
            'id',
            'taskId',
          ]);
          const response = await send(' 739126 ', { verificationRequestId: request.requestId });
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.json().messageText, 'Verification code sent securely.');
          assert.equal(response.json().verificationStatus, 'submitted');
          assert.deepEqual(injected, [
            {
              owner: ownerId,
              taskId: request.taskId,
              code: '739126',
              requestId: request.requestId,
            },
          ]);
          assert.deepEqual(ordinary, []);
          const state = (await app.inject({ url: '/api/state', headers })).json();
          assert.equal(state.verificationRequests.length, 0);
          assert.doesNotMatch(JSON.stringify(state), /739126/);
          const persisted = await db.pool.query(
            'SELECT row_to_json(m) AS row FROM messages m UNION ALL SELECT row_to_json(v) FROM chat_verification_submissions v',
          );
          assert.doesNotMatch(JSON.stringify(persisted.rows), /739126/);
          assert.equal((await db.pool.query('SELECT * FROM pending_task_inputs')).rowCount, 0);
          assert.equal((await db.pool.query('SELECT * FROM inspector_records')).rowCount, 0);
        },
      );
      await t.test(
        'duplicates during and after injection do not replay a code or fall through after request consumption',
        async () => {
          await reset();
          const request = await seed();
          const clientMessageId = randomUUID();
          let release!: () => void;
          hold = new Promise<void>((resolve) => {
            release = resolve;
          });
          const entering = new Promise<void>((resolve) => {
            started = resolve;
          });
          const first = send('834725', { clientMessageId });
          await entering;
          const duplicate = await send('834725', { clientMessageId });
          assert.equal(duplicate.statusCode, 200, duplicate.body);
          assert.equal(duplicate.json().verificationStatus, 'pending');
          assert.equal(duplicate.json().messageText, 'Verification code received securely.');
          const pendingReceipt = (
            await db.pool.query('SELECT text FROM messages WHERE id=$1', [clientMessageId])
          ).rows[0];
          assert.equal(pendingReceipt.text, 'Verification code received securely.');
          assert.equal(injected.length, 1);
          release();
          assert.equal((await first).statusCode, 200);
          const after = await send('834725', {
            clientMessageId,
            verificationRequestId: request.requestId,
          });
          assert.equal(after.statusCode, 200, after.body);
          assert.equal(after.json().verificationStatus, 'submitted');
          assert.equal(injected.length, 1);
          assert.deepEqual(ordinary, []);
          assert.equal(
            (await db.pool.query("SELECT * FROM messages WHERE role='user'")).rowCount,
            1,
          );
        },
      );
      await t.test('multiple waits require an explicit owned reply or request target', async () => {
        await reset();
        const first = await seed();
        const second = await seed();
        const ambiguous = await send('473826');
        assert.equal(ambiguous.statusCode, 409);
        assert.match(ambiguous.json().error, /More than one sign-in/);
        assert.deepEqual(ordinary, []);
        assert.equal(injected.length, 0);
        assert.equal((await db.pool.query("SELECT * FROM messages WHERE role='user'")).rowCount, 0);
        assert.equal(
          (await send('473826', { replyToMessageId: second.messageId })).statusCode,
          200,
        );
        assert.equal(injected[0]?.requestId, second.requestId);
        assert.equal((await verification.pending())[0]?.id, first.requestId);
      });
      await t.test(
        'code-shaped attachments and forced messages cannot bypass an OTP wait',
        async () => {
          for (const extra of [{ attachmentIds: [randomUUID()] }, { forceNew: true }]) {
            await reset();
            await seed();
            const response = await send('578231', extra);
            assert.equal(response.statusCode, 409, response.body);
            assert.match(response.json().error, /code by itself/);
            assert.deepEqual(ordinary, []);
            assert.equal(injected.length, 0);
            assert.equal(
              (await db.pool.query("SELECT * FROM messages WHERE role='user'")).rowCount,
              0,
            );
          }
          await reset();
          assert.equal((await send('2026', { forceNew: true })).statusCode, 200);
          assert.deepEqual(ordinary, ['2026']);
        },
      );
      await t.test(
        'changed retry codes conflict and keyed receipts remain exact across service restart',
        async () => {
          await reset();
          const request = await seed();
          const clientMessageId = randomUUID();
          let release!: () => void;
          hold = new Promise<void>((resolve) => {
            release = resolve;
          });
          const entering = new Promise<void>((resolve) => {
            started = resolve;
          });
          const first = send('481925', { clientMessageId });
          await entering;
          assert.equal((await send('591826', { clientMessageId })).statusCode, 409);
          assert.equal((await send('481925', { clientMessageId, forceNew: true })).statusCode, 409);
          release();
          assert.equal((await first).statusCode, 200);
          const restarted = await createChatVerification(db.pool, {
            ownerId,
            keyStore: { getKey: async () => Buffer.alloc(32, 61) },
            refresh() {},
            submitCode: async () => {
              throw new Error('A duplicate must not inject again.');
            },
          });
          const retry = await restarted.accept('481925', { clientMessageId });
          assert.equal(retry?.verificationStatus, 'submitted');
          await assert.rejects(restarted.accept('591826', { clientMessageId }), /already in use/);
          const stored = await db.pool.query(
            'SELECT code_fingerprint FROM chat_verification_submissions',
          );
          assert.match(stored.rows[0].code_fingerprint, /^[a-f0-9]{64}$/);
          assert.doesNotMatch(JSON.stringify(stored.rows), /481925|591826/);
          await db.pool.query('UPDATE chat_verification_submissions SET code_fingerprint=NULL');
          await assert.rejects(
            restarted.accept('481925', {
              clientMessageId,
              verificationRequestId: request.requestId,
            }),
            /already in use/,
          );
          assert.equal(injected.length, 1);
          assert.deepEqual(ordinary, []);
        },
      );
      await t.test(
        'in-flight duplicate status remains pending before a later rejection',
        async () => {
          await reset();
          await seed();
          outcome = 'rejected';
          const clientMessageId = randomUUID();
          let release!: () => void;
          hold = new Promise<void>((resolve) => {
            release = resolve;
          });
          const entering = new Promise<void>((resolve) => {
            started = resolve;
          });
          const first = send('739821', { clientMessageId });
          await entering;
          const duplicate = await send('739821', { clientMessageId });
          assert.equal(duplicate.json().verificationStatus, 'pending');
          release();
          assert.equal((await first).json().verificationStatus, 'rejected');
          assert.equal(
            (await send('739821', { clientMessageId })).json().verificationStatus,
            'rejected',
          );
          assert.equal(injected.length, 1);
        },
      );
      await t.test(
        'ordinary numeric messages and receipts do not require a Vault key',
        async () => {
          await reset();
          let keyReads = 0;
          const unavailable = await createChatVerification(db.pool, {
            ownerId,
            keyStore: {
              getKey: async () => {
                keyReads += 1;
                throw new Error('Private key failure.');
              },
            },
            refresh() {},
            submitCode: async () => {
              throw new Error('No injection expected.');
            },
          });
          const unavailableApp = await createApp({
            verification: unavailable,
            configuration: () => ({ ...configuration(), llmReady: true }),
            submitMessage: async (text, _attachments, input) => {
              ordinary.push(text);
              return { taskId: randomUUID(), continued: false, messageId: input?.clientMessageId };
            },
          });
          const ordinarySend = (text: string, extra: Record<string, unknown> = {}) =>
            unavailableApp.inject({
              method: 'POST',
              url: '/api/messages',
              headers,
              payload: { text, clientMessageId: randomUUID(), ...extra },
            });
          try {
            for (const text of ['2026', '12345', '123456', '1234567', '12345678']) {
              const response = await ordinarySend(text);
              assert.equal(response.statusCode, 200, response.body);
            }
            assert.equal((await ordinarySend('2027', { forceNew: true })).statusCode, 200);
            await seed();
            const other = await seed({ kind: 'password', status: 'running' });
            assert.equal(
              (await ordinarySend('2048', { replyToMessageId: other.messageId })).statusCode,
              200,
            );
            const receiptId = randomUUID();
            assert.equal(
              await unavailable.accept('6060', {
                clientMessageId: receiptId,
                taskId: other.taskId,
                persistOrdinary: async (client) => {
                  await client.query(
                    "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,$2,'user','6060',$3)",
                    [receiptId, ownerId, other.taskId],
                  );
                },
              }),
              undefined,
            );
            assert.equal(
              (await ordinarySend('6060', { clientMessageId: receiptId })).statusCode,
              200,
            );
            assert.equal(keyReads, 0);
            assert.deepEqual(ordinary, [
              '2026',
              '12345',
              '123456',
              '1234567',
              '12345678',
              '2027',
              '2048',
              '6060',
            ]);
            assert.equal(injected.length, 0);
            assert.equal(
              (await db.pool.query('SELECT text FROM messages WHERE id=$1', [receiptId])).rows[0]
                .text,
              '6060',
            );
            assert.equal(
              (await db.pool.query('SELECT * FROM chat_verification_submissions')).rowCount,
              0,
            );
          } finally {
            await unavailableApp.close();
          }
        },
      );
      await t.test(
        'an unavailable fingerprint key never routes pending codes or replays receipts',
        async () => {
          await reset();
          await seed();
          let keyReads = 0;
          const unavailable = await createChatVerification(db.pool, {
            ownerId,
            keyStore: {
              getKey: async () => {
                keyReads += 1;
                throw new Error('Private key failure.');
              },
            },
            refresh() {},
            submitCode: async () => {
              throw new Error('No injection expected.');
            },
          });
          const clientMessageId = randomUUID();
          const assertUnavailable = () =>
            assert.rejects(
              unavailable.accept('482753', {
                clientMessageId,
                persistOrdinary: async () => {
                  throw new Error('No ordinary persistence expected.');
                },
              }),
              (error: unknown) => {
                assert.equal((error as { statusCode: number }).statusCode, 503);
                assert.doesNotMatch(String(error), /482753|Private key failure/);
                return true;
              },
            );
          await assertUnavailable();
          assert.equal(keyReads, 1);
          assert.equal(injected.length, 0);
          assert.equal(
            (await db.pool.query("SELECT * FROM messages WHERE role='user'")).rowCount,
            0,
          );
          assert.equal(
            (await db.pool.query('SELECT * FROM chat_verification_submissions')).rowCount,
            0,
          );
          assert.equal(
            (await verification.accept('482753', { clientMessageId }))?.verificationStatus,
            'submitted',
          );
          await assertUnavailable();
          assert.equal(keyReads, 2);
          assert.equal(injected.length, 1);
          assert.deepEqual(ordinary, []);
          assert.equal(
            (await db.pool.query('SELECT * FROM chat_verification_submissions')).rowCount,
            1,
          );
          assert.equal(
            (await db.pool.query('SELECT text FROM messages WHERE id=$1', [clientMessageId]))
              .rows[0].text,
            'Verification code sent securely.',
          );
        },
      );
      await t.test(
        'ordinary numeric messages and replies to other work remain ordinary',
        async () => {
          await reset();
          assert.equal((await send('2026')).statusCode, 200);
          await seed();
          const other = await seed({ kind: 'password', status: 'running' });
          assert.equal((await send('2048', { replyToMessageId: other.messageId })).statusCode, 200);
          assert.equal((await send('123')).statusCode, 200);
          assert.equal((await send('Use 456789 for the report')).statusCode, 200);
          assert.deepEqual(ordinary, ['2026', '2048', '123', 'Use 456789 for the report']);
          assert.equal(injected.length, 0);
        },
      );
      await t.test(
        'foreign, other-channel, stale, expired and cancelled requests cannot accept a code',
        async () => {
          for (const options of [
            { owner: 'someone-else' },
            { channel: 'telegram:other' },
            { revision: 1 },
            { expired: true },
            { status: 'cancelled' },
            { generation: 1 },
            { kind: 'password' },
          ]) {
            await reset();
            const request = await seed(options);
            assert.deepEqual(await verification.pending(), []);
            const response = await send('761924', { verificationRequestId: request.requestId });
            assert.equal(response.statusCode, 409, JSON.stringify(options));
            assert.deepEqual(ordinary, []);
            assert.equal(injected.length, 0);
          }
        },
      );
      await t.test(
        'early and expired code replies cannot fall through before or after a credential wait',
        async () => {
          for (const options of [{ status: 'running' }, { expired: true }]) {
            await reset();
            await seed(options);
            const response = await send('892647');
            assert.equal(response.statusCode, 409, response.body);
            assert.equal(injected.length, 0);
            assert.deepEqual(ordinary, []);
            assert.equal(
              (await db.pool.query("SELECT * FROM messages WHERE role='user'")).rowCount,
              0,
            );
          }
        },
      );
      await t.test(
        'reset fences and invalid explicit code input never persist or route plaintext',
        async () => {
          await reset();
          const request = await seed();
          await db.pool.query(
            "INSERT INTO conversations(owner_id,channel,revision) VALUES($1,'web',1)",
            [ownerId],
          );
          assert.equal(
            (await send('582491', { verificationRequestId: request.requestId })).statusCode,
            409,
          );
          assert.equal(
            (
              await send('my password', {
                verificationRequestId: request.requestId,
                conversationRevision: 1,
              })
            ).statusCode,
            409,
          );
          assert.deepEqual(ordinary, []);
          assert.equal(injected.length, 0);
          assert.equal(
            (await db.pool.query("SELECT * FROM messages WHERE role='user'")).rowCount,
            0,
          );
        },
      );
      await t.test(
        'website rejection and private transport failure give fixed retry copy without code disclosure',
        async () => {
          for (const failure of ['rejected', 'error'] as const) {
            await reset();
            const request = await seed();
            outcome = 'rejected';
            throwPrivateError = failure === 'error';
            const response = await send('926147', { verificationRequestId: request.requestId });
            assert.equal(response.statusCode, 200, response.body);
            assert.equal(
              response.json().verificationStatus,
              failure === 'error' ? 'unavailable' : 'rejected',
            );
            const state = (await app.inject({ url: '/api/state', headers })).json();
            assert.doesNotMatch(JSON.stringify(state), /926147|Untrusted website/);
            assert.match(state.messages.at(-1).text, /fresh|ready/);
            assert.deepEqual(ordinary, []);
          }
        },
      );
    } finally {
      await app.close();
      await db.pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
