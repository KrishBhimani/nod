import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { channelReply, createChannels } from '../src/server/channels.ts';
import { createChatVerification } from '../src/server/chat-verification.ts';
import { createVault } from '../src/server/vault.ts';
import { channelConfiguration, createChatSdkTransport } from '../src/providers/chat-sdk/index.ts';
import type { InboundMessage, MessagingTransport } from '../src/ports/messaging.ts';

const fixtureEnv = {
  TELEGRAM_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: '987:fixture-not-live',
  TELEGRAM_WEBHOOK_SECRET_TOKEN: 'fixture-webhook-secret-32-characters',
  TELEGRAM_ALLOWED_USER_ID: '123456',
  WHATSAPP_ENABLED: 'true',
  WHATSAPP_ACCESS_TOKEN: 'fixture-not-live',
  WHATSAPP_APP_SECRET: 'fixture-app-secret',
  WHATSAPP_PHONE_NUMBER_ID: '555000',
  WHATSAPP_VERIFY_TOKEN: 'fixture-verify-token',
  WHATSAPP_ALLOWED_NUMBER: '351910000000',
  WHATSAPP_POLICY_CONFIRMED: 'true',
};

test(
  'channel lifecycle changes roll back receipts and preserve provider retries',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const schema = `test_channel_lifecycle_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      application_name: schema,
    });
    await pool.query(`CREATE TABLE tasks(id uuid PRIMARY KEY,source_id text UNIQUE);
      CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text,role text,text text,task_id uuid,attachments jsonb DEFAULT '[]')`);
    const submitted: string[] = [];
    const verificationIds = new Set<string>();
    const taskId = randomUUID();
    function transport(accountId = 'fixture-account'): MessagingTransport {
      return {
        channels: [
          {
            id: 'telegram',
            status: 'configured',
            missing: [],
            accountId,
            allowedSenderIds: ['fixture-owner'],
          },
        ],
        receive: async (request) => ({
          status: 200,
          body: 'accepted',
          messages: [
            {
              channelId: 'telegram',
              accountId: 'fixture-account',
              senderId: 'fixture-owner',
              threadId: 'fixture-thread',
              sentAt: new Date(),
              ...JSON.parse(Buffer.from(request.body).toString('utf8')),
            },
          ],
        }),
        post: async () => {
          throw new Error('This fixture must not send a message.');
        },
        close: async () => {},
      };
    }
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'fixture-owner',
      transport: transport(),
      acceptVerification: async (text, input) => {
        if (text === '483729') {
          verificationIds.add(input.clientMessageId);
          return {
            taskId,
            messageId: input.clientMessageId,
            continued: true,
            messageText: 'Verification code sent securely.',
            verificationStatus: 'submitted',
          };
        }
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await input.persistOrdinary(client);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      submit: async (_text, sourceId, client) => {
        submitted.push(sourceId);
        const result = await client.query(
          'INSERT INTO tasks(id,source_id) VALUES($1,$2) RETURNING id',
          [randomUUID(), sourceId],
        );
        return result.rows[0].id;
      },
      subscribe: () => () => {},
      intervalMs: 600000,
    });
    channels.registerRoutes(app);
    const send = (messageId: string, text: string) =>
      app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: { 'content-type': 'application/json' },
        payload: { messageId, text },
      });
    const gate = await pool.connect();
    const gateId = Math.floor(Math.random() * 1000000000);
    await pool.query(`CREATE FUNCTION hold_fixture_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${gateId}); RETURN NEW; END $$;
      CREATE TRIGGER hold_fixture_receipt BEFORE INSERT ON channel_inbox FOR EACH ROW EXECUTE FUNCTION hold_fixture_receipt()`);
    try {
      for (const [messageId, text] of [
        ['ordinary', 'Continue the fixture task'],
        ['verification', '483729'],
        ['transaction', '2026'],
      ]) {
        const sourceId = `channel:telegram:fixture-account:${messageId}`;
        await gate.query('SELECT pg_advisory_lock($1)', [gateId]);
        const pending = send(messageId, text);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          waiting = Boolean(
            (
              await admin.query(
                "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'INSERT INTO channel_inbox%'",
                [schema],
              )
            ).rowCount,
          );
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(waiting, true, messageId);
        await channels.replaceTransport(transport('revoked-account'));
        await gate.query('SELECT pg_advisory_unlock($1)', [gateId]);
        const response = await pending;
        assert.equal(response.statusCode, 503, messageId);
        assert.doesNotMatch(response.body, /483729|Channel configuration changed/);
        await channels.drain();
        assert.equal(
          (await pool.query('SELECT 1 FROM channel_inbox WHERE source_id=$1', [sourceId])).rowCount,
          0,
          messageId,
        );
        await channels.replaceTransport(transport());
        assert.equal((await send(messageId, text)).statusCode, 200, messageId);
        await channels.drain();
        assert.equal((await send(messageId, text)).statusCode, 200, messageId);
        await channels.drain();
        assert.equal(
          submitted.filter((id) => id === sourceId).length,
          messageId === 'verification' ? 0 : 1,
          messageId,
        );
        const receipt = (
          await pool.query('SELECT text,state FROM channel_inbox WHERE source_id=$1', [sourceId])
        ).rows[0];
        assert.deepEqual(receipt, {
          text: messageId === 'verification' ? 'Verification code sent securely.' : text,
          state: 'submitted',
        });
      }
      assert.equal(verificationIds.size, 1);
    } finally {
      await gate.query('SELECT pg_advisory_unlock_all()');
      gate.release();
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'channel numeric receipt classification and actual Vault request creation serialize on the task',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const schema = `test_channel_otp_race_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      application_name: `${schema}_channel`,
    });
    const vaultPool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      application_name: `${schema}_vault`,
    });
    await pool.query(`CREATE TABLE tasks(id uuid PRIMARY KEY,owner_id text NOT NULL,status text NOT NULL,revision integer NOT NULL DEFAULT 0,channel text NOT NULL,conversation_revision integer NOT NULL DEFAULT 0);
      CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text NOT NULL,role text NOT NULL,text text NOT NULL,task_id uuid REFERENCES tasks(id),attachments jsonb NOT NULL DEFAULT '[]',reply_to_message_id uuid,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE conversations(owner_id text,channel text,revision integer,PRIMARY KEY(owner_id,channel))`);
    const keyStore = { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32, 71) };
    let injections = 0;
    const vault = await createVault(vaultPool, {
      keyStore,
      inspect: async () => ({
        url: 'https://1.1.1.1/login',
        origin: 'https://1.1.1.1',
        fields: [{ kind: 'otp', selector: '#code', label: 'Verification code' }],
        methods: [
          { id: 'credentials', kind: 'credentials', label: 'Verification code', supported: true },
        ],
      }),
      inject: async () => {
        injections++;
      },
      resume: async () => {},
      retry: async () => {},
    });
    const verification = await createChatVerification(pool, {
      ownerId: 'local-development',
      keyStore,
      submitCode: vault.submitChatCode,
      refresh() {},
    });
    const channel = `telegram:${createHash('sha256')
      .update(JSON.stringify(['fixture-account', 'local-development']))
      .digest('hex')
      .slice(0, 32)}`;
    const ordinaryTaskId = randomUUID();
    const codeTaskId = randomUUID();
    await pool.query(
      "INSERT INTO tasks(id,owner_id,status,channel) VALUES($1,'local-development','running',$2)",
      [ordinaryTaskId, channel],
    );
    let releaseReceipt!: () => void;
    const heldReceipt = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    let receiptStarted!: () => void;
    const receiptStarting = new Promise<void>((resolve) => {
      receiptStarted = resolve;
    });
    let holdOrdinary = true;
    const prepared: string[] = [];
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'local-development',
      transport: {
        channels: [
          {
            id: 'telegram',
            status: 'configured',
            missing: [],
            accountId: 'fixture-account',
            allowedSenderIds: ['local-development'],
          },
        ],
        receive: async (request) => ({
          status: 200,
          body: 'accepted',
          messages: [
            {
              channelId: 'telegram',
              accountId: 'fixture-account',
              senderId: 'local-development',
              threadId: 'fixture-thread',
              sentAt: new Date(),
              ...JSON.parse(Buffer.from(request.body).toString('utf8')),
            },
          ],
        }),
        post: async () => ({ id: 'fixture-reply' }),
        close: async () => {},
      },
      acceptVerification: (text, input) =>
        verification.accept(text, {
          ...input,
          persistOrdinary: async (client) => {
            if (holdOrdinary) {
              receiptStarted();
              await heldReceipt;
            }
            await input.persistOrdinary(client);
          },
        }),
      prepare: async (text) => {
        prepared.push(text);
        return undefined!;
      },
      submit: async () => ordinaryTaskId,
      subscribe: () => () => {},
      intervalMs: 600000,
    });
    channels.registerRoutes(app);
    vault.registerRoutes(app);
    const send = (messageId: string, text: string) =>
      app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: { 'content-type': 'application/json' },
        payload: { messageId, text },
      });
    const request = (taskId: string) =>
      vault.request(taskId, 'local-development', {
        origin: 'https://1.1.1.1',
        label: 'Fixture sign-in',
        kind: 'otp',
        passwordSelector: '#code',
      });
    async function waitForDatabaseLock(application: string) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
          [application],
        );
        if (waiting.rowCount) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.fail('Expected the fixture transaction to wait on the task boundary.');
    }
    const gate = await pool.connect();
    const gateId = Math.floor(Math.random() * 1000000000);
    try {
      const year = send('year', '2026');
      await receiptStarting;
      const laterRequest = request(ordinaryTaskId);
      await waitForDatabaseLock(`${schema}_vault`);
      assert.equal((await pool.query('SELECT * FROM credential_requests')).rowCount, 0);
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);
      releaseReceipt();
      assert.equal((await year).statusCode, 200);
      await laterRequest;
      await channels.drain();
      assert.deepEqual(prepared, ['2026']);
      assert.equal((await pool.query('SELECT text FROM channel_inbox')).rows[0].text, '2026');
      await pool.query("UPDATE tasks SET status='succeeded' WHERE id=$1", [ordinaryTaskId]);
      await pool.query(
        "INSERT INTO tasks(id,owner_id,status,channel) VALUES($1,'local-development','waiting_credentials',$2)",
        [codeTaskId, channel],
      );
      holdOrdinary = false;
      await pool.query(`CREATE FUNCTION hold_fixture_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${gateId}); RETURN NEW; END $$;
        CREATE TRIGGER hold_fixture_request BEFORE INSERT ON credential_requests FOR EACH ROW EXECUTE FUNCTION hold_fixture_request()`);
      await gate.query('SELECT pg_advisory_lock($1)', [gateId]);
      const earlierRequest = request(codeTaskId);
      await waitForDatabaseLock(`${schema}_vault`);
      const code = send('private-code', '481927');
      await waitForDatabaseLock(`${schema}_channel`);
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM channel_inbox WHERE source_id='channel:telegram:fixture-account:private-code'",
          )
        ).rowCount,
        0,
      );
      assert.equal(injections, 0);
      await gate.query('SELECT pg_advisory_unlock($1)', [gateId]);
      await earlierRequest;
      const response = await code;
      assert.equal(response.statusCode, 200, response.body);
      await channels.drain();
      assert.equal(injections, 1);
      assert.deepEqual(prepared, ['2026']);
      const privateRows = await pool.query(
        'SELECT row_to_json(i) AS row FROM channel_inbox i UNION ALL SELECT row_to_json(m) FROM messages m UNION ALL SELECT row_to_json(v) FROM chat_verification_submissions v',
      );
      assert.doesNotMatch(JSON.stringify(privateRows.rows), /481927/);
      const receipt = (
        await pool.query(
          "SELECT text,state FROM channel_inbox WHERE source_id='channel:telegram:fixture-account:private-code'",
        )
      ).rows[0];
      assert.deepEqual(receipt, { text: 'Verification code sent securely.', state: 'submitted' });
    } finally {
      releaseReceipt();
      await gate.query('SELECT pg_advisory_unlock_all()');
      gate.release();
      await app.close();
      await vaultPool.end();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'channel verification stays private before inbox persistence and fences duplicate delivery across restart',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_channel_codes_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(`CREATE TABLE tasks(id uuid PRIMARY KEY,source_id text UNIQUE);
      CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text,role text,text text,task_id uuid,attachments jsonb DEFAULT '[]')`);
    const taskId = randomUUID();
    await pool.query('INSERT INTO tasks(id) VALUES($1)', [taskId]);
    const accepted: Array<{ clientMessageId: string; channel: string }> = [];
    const prepared: string[] = [];
    const sent: Array<{ channelId: string; accountId: string; threadId: string; text: string }> =
      [];
    let injections = 0;
    let beginHeld!: () => void;
    let releaseHeld!: () => void;
    const heldStarted = new Promise<void>((resolve) => {
      beginHeld = resolve;
    });
    const heldReleased = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    function transport(accountId = 'fixture-account'): MessagingTransport {
      return {
        channels: ['telegram', 'whatsapp'].map((id) => ({
          id,
          status: 'configured',
          missing: [],
          accountId,
          allowedSenderIds: ['fixture-owner'],
        })),
        receive: async (request) => {
          const input = JSON.parse(Buffer.from(request.body).toString('utf8'));
          return {
            status: 200,
            body: 'accepted',
            messages: [
              {
                channelId: request.channelId,
                accountId: 'fixture-account',
                senderId: 'fixture-owner',
                threadId: 'fixture-thread',
                ...input,
                sentAt: new Date(),
              },
            ],
          };
        },
        post: async (message) => {
          sent.push(message);
          return { id: `fixture-reply-${sent.length}` };
        },
        close: async () => {},
      };
    }
    async function open() {
      const app = Fastify();
      const channels = await createChannels(pool, {
        ownerId: 'fixture-owner',
        transport: transport(),
        intervalMs: 600000,
        subscribe: () => () => {},
        acceptVerification: async (text, input) => {
          accepted.push(input);
          if (text === '111111')
            throw Object.assign(new Error('Ambiguous fixture code 111111.'), { statusCode: 409 });
          if (text === '222222') throw new Error('Provider failed with code 222222.');
          if (text !== '483729' && text !== '123456') {
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              await input.persistOrdinary(client);
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
            return;
          }
          if (text === '123456') {
            beginHeld();
            await heldReleased;
          }
          const stored = await pool.query(
            "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,'fixture-owner','user','Verification code sent securely.',$2) ON CONFLICT(id) DO NOTHING",
            [input.clientMessageId, taskId],
          );
          if (stored.rowCount) injections++;
          return {
            taskId,
            messageId: input.clientMessageId,
            continued: true,
            messageText: 'Verification code sent securely.',
            verificationStatus: 'submitted',
          };
        },
        prepare: async (text) => {
          prepared.push(text);
          return undefined!;
        },
        submit: async (_text, sourceId, client) => {
          const result = await client.query(
            'INSERT INTO tasks(id,source_id) VALUES($1,$2) RETURNING id',
            [randomUUID(), sourceId],
          );
          return result.rows[0].id;
        },
      });
      channels.registerRoutes(app);
      return { app, channels };
    }
    let fixture = await open();
    const send = (messageId: string, text: string, provider = 'telegram', extra = {}) =>
      fixture.app.inject({
        method: 'POST',
        url: `/api/webhooks/${provider}`,
        headers: { 'content-type': 'application/json' },
        payload: { messageId, text, ...extra },
      });
    try {
      await send('foreign', '483729', 'telegram', { senderId: 'someone-else' });
      await send('foreign-account', '483729', 'telegram', { accountId: 'another-account' });
      assert.equal(accepted.length, 0);
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);

      await pool.query(
        "ALTER TABLE channel_inbox ADD CONSTRAINT fixture_insert_failure CHECK(provider <> 'telegram')",
      );
      const interrupted = await send('private-code', '483729');
      assert.equal(interrupted.statusCode, 503);
      assert.doesNotMatch(interrupted.body, /483729/);
      assert.equal(injections, 1);
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);
      await fixture.app.close();
      await pool.query('ALTER TABLE channel_inbox DROP CONSTRAINT fixture_insert_failure');
      fixture = await open();
      const retried = await Promise.all([
        send('private-code', '483729'),
        send('private-code', '483729'),
      ]);
      assert.ok(retried.every((response) => response.statusCode === 200));
      await fixture.channels.drain();
      assert.equal(injections, 1);
      assert.equal(new Set(accepted.map((input) => input.clientMessageId)).size, 1);
      const row = (await pool.query('SELECT * FROM channel_inbox')).rows[0];
      assert.equal(row.text, 'Verification code sent securely.');
      assert.equal(row.state, 'submitted');
      assert.equal(row.task_id, taskId);
      assert.equal(row.message_id, accepted[0].clientMessageId);
      assert.match(accepted[0].channel, /^telegram:[a-f0-9]{32}$/);
      assert.deepEqual(prepared, []);
      const calls = accepted.length;
      await send('private-code', 'changed duplicate body');
      assert.equal(accepted.length, calls);

      assert.equal((await send('private-code', '483729', 'whatsapp')).statusCode, 200);
      assert.match(accepted.at(-1)!.channel, /^whatsapp:[a-f0-9]{32}$/);
      assert.notEqual(accepted.at(-1)!.clientMessageId, accepted[0].clientMessageId);
      assert.equal(injections, 2);

      const ambiguous = await send('ambiguous-code', '111111');
      assert.equal(ambiguous.statusCode, 200);
      assert.doesNotMatch(ambiguous.body, /111111|Ambiguous fixture/);
      await fixture.channels.drain();
      assert.deepEqual(sent, [
        {
          channelId: 'telegram',
          accountId: 'fixture-account',
          threadId: 'fixture-thread',
          text: 'The code could not be matched to a sign-in. Open the corresponding sign-in conversation in Sidekick web chat to continue.',
        },
      ]);
      const guidance = (
        await pool.query(
          "SELECT i.text,i.state,i.task_id,m.role,m.task_id AS reply_task_id FROM channel_inbox i JOIN channel_outbox o USING(source_id) JOIN messages m ON m.id=o.message_id WHERE i.source_id='channel:telegram:fixture-account:ambiguous-code'",
        )
      ).rows[0];
      assert.deepEqual(guidance, {
        text: 'Verification code not applied.',
        state: 'discarded',
        task_id: null,
        role: 'assistant',
        reply_task_id: null,
      });
      await fixture.app.close();
      fixture = await open();
      const acceptedBeforeDuplicate = accepted.length;
      await Promise.all([
        send('ambiguous-code', '111111'),
        send('ambiguous-code', 'changed duplicate body'),
      ]);
      await fixture.channels.drain();
      assert.equal(accepted.length, acceptedBeforeDuplicate);
      assert.equal(sent.length, 1);
      const unavailable = await send('unavailable-code', '222222');
      assert.equal(unavailable.statusCode, 503);
      assert.doesNotMatch(unavailable.body, /222222|Provider failed/);
      await fixture.channels.drain();
      const privateRows = (await pool.query('SELECT text FROM channel_inbox')).rows;
      assert.equal(privateRows.length, 3);
      assert.doesNotMatch(JSON.stringify(privateRows), /483729|111111|222222/);
      assert.deepEqual(prepared, []);

      assert.equal((await send('ordinary-number', '2026')).statusCode, 200);
      await fixture.channels.drain();
      assert.deepEqual(prepared, ['2026']);
      assert.equal(
        (
          await pool.query(
            "SELECT text FROM channel_inbox WHERE source_id='channel:telegram:fixture-account:ordinary-number'",
          )
        ).rows[0].text,
        '2026',
      );

      const held = send('revoked-code', '123456');
      await Promise.race([
        heldStarted,
        held.then(() => {
          throw new Error('Expected pending verification.');
        }),
      ]);
      await fixture.channels.replaceTransport(transport('new-account'));
      releaseHeld();
      assert.equal((await held).statusCode, 503);
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM channel_inbox WHERE source_id='channel:telegram:fixture-account:revoked-code'",
          )
        ).rowCount,
        0,
      );
    } finally {
      releaseHeld();
      await fixture.app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'verification guidance is atomic, private, and retains channel delivery guards across restart',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_channel_guidance_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(`CREATE TABLE tasks(id uuid PRIMARY KEY,source_id text UNIQUE);
      CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text,role text,text text,task_id uuid,attachments jsonb DEFAULT '[]')`);
    const sent: Array<{ channelId: string; accountId: string; threadId: string; text: string }> =
      [];
    const polled: InboundMessage[] = [];
    let consumed = 0;
    let verificationCalls = 0;
    let failSend = false;
    async function open({
      ownerId = 'fixture-owner',
      accountId = 'fixture-account',
      senderId = 'fixture-sender',
    } = {}) {
      const app = Fastify();
      const channels = await createChannels(pool, {
        ownerId,
        transport: {
          channels: ['telegram', 'whatsapp'].map((id) => ({
            id,
            status: 'configured',
            missing: [],
            accountId,
            allowedSenderIds: [senderId],
            ...(id === 'whatsapp' ? { replyWindowMs: 86400000 } : {}),
          })),
          receive: async (request) => {
            const body = JSON.parse(Buffer.from(request.body).toString('utf8'));
            return {
              status: 200,
              body: 'accepted',
              messages: [inbound(body.messageId, request.channelId)],
            };
          },
          poll: async (accept) => {
            while (polled.length) {
              await accept(polled[0]!);
              polled.shift();
              consumed++;
            }
          },
          post: async (message) => {
            sent.push(message);
            if (failSend) throw new Error('Uncertain fixture delivery.');
            return { id: `fixture-message-${sent.length}` };
          },
          close: async () => {},
        },
        acceptVerification: async () => {
          verificationCalls++;
          throw Object.assign(new Error('Private conflict containing 111111.'), {
            statusCode: 409,
          });
        },
        prepare: async () => {
          throw new Error('Verification must not reach the router.');
        },
        submit: async () => {
          throw new Error('Verification must not create a task.');
        },
        subscribe: () => () => {},
        intervalMs: 600000,
      });
      channels.registerRoutes(app);
      return { app, channels };
    }
    function inbound(messageId: string, channelId = 'telegram'): InboundMessage {
      return {
        channelId,
        accountId: 'fixture-account',
        senderId: 'fixture-sender',
        messageId,
        threadId: `fixture-thread-${messageId}`,
        text: '111111',
        sentAt: new Date(),
      };
    }
    let fixture = await open();
    const send = (messageId: string, provider = 'telegram') =>
      fixture.app.inject({
        method: 'POST',
        url: `/api/webhooks/${provider}`,
        headers: { 'content-type': 'application/json' },
        payload: { messageId },
      });
    try {
      await pool.query(
        'ALTER TABLE channel_outbox ADD CONSTRAINT fixture_outbox_failure CHECK(false)',
      );
      const failed = await send('atomic-retry');
      assert.equal(failed.statusCode, 503);
      assert.doesNotMatch(failed.body, /111111|Private conflict|fixture_outbox_failure/);
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);
      assert.equal((await pool.query('SELECT * FROM messages')).rowCount, 0);
      assert.equal((await pool.query('SELECT * FROM channel_outbox')).rowCount, 0);

      polled.push(inbound('polled-retry'));
      await fixture.channels.drain();
      assert.equal(consumed, 0);
      assert.equal(polled.length, 1);
      assert.equal(sent.length, 0);
      await pool.query('ALTER TABLE channel_outbox DROP CONSTRAINT fixture_outbox_failure');
      await Promise.all([send('atomic-retry'), send('atomic-retry')]);
      await fixture.channels.drain();
      assert.equal(consumed, 1);
      assert.equal(polled.length, 0);
      assert.equal(sent.length, 2);
      assert.equal((await pool.query('SELECT * FROM tasks')).rowCount, 0);
      const persisted = (
        await pool.query(
          'SELECT i.text,i.state,i.message_id,m.id,m.task_id,m.owner_id,m.role,o.state AS delivery_state FROM channel_inbox i JOIN channel_outbox o USING(source_id) JOIN messages m ON m.id=o.message_id',
        )
      ).rows;
      assert.equal(persisted.length, 2);
      assert.ok(persisted.every((row) => row.state === 'discarded' && row.task_id === null));
      assert.ok(persisted.every((row) => row.delivery_state === 'sent'));
      assert.doesNotMatch(JSON.stringify(persisted), /111111|Private conflict/);
      assert.deepEqual(
        new Set(sent.map((message) => message.threadId)),
        new Set(['fixture-thread-atomic-retry', 'fixture-thread-polled-retry']),
      );
      const calls = verificationCalls;
      await fixture.app.close();
      fixture = await open();
      await send('atomic-retry');
      polled.push(inbound('polled-retry'));
      await fixture.channels.drain();
      assert.equal(verificationCalls, calls);
      assert.equal(sent.length, 2);

      failSend = true;
      await send('uncertain');
      await fixture.channels.drain();
      assert.equal(sent.length, 3);
      await fixture.app.close();
      failSend = false;
      fixture = await open();
      await send('uncertain');
      await fixture.channels.drain();
      assert.equal(sent.length, 3);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT state,reason FROM channel_outbox WHERE source_id='channel:telegram:fixture-account:uncertain'",
          )
        ).rows[0],
        { state: 'uncertain', reason: 'send_not_confirmed' },
      );

      await send('expired', 'whatsapp');
      await fixture.channels.drain();
      await fixture.app.close();
      await pool.query(
        "UPDATE channel_inbox SET received_at=now()-interval '2 days' WHERE provider='whatsapp'; UPDATE channel_outbox SET state='pending' WHERE source_id='channel:whatsapp:fixture-account:expired'",
      );
      fixture = await open();
      const beforeExpired = sent.length;
      await fixture.channels.drain();
      assert.equal(sent.length, beforeExpired);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT state,reason FROM channel_outbox WHERE source_id='channel:whatsapp:fixture-account:expired'",
          )
        ).rows[0],
        { state: 'blocked', reason: 'reply_window_closed' },
      );

      for (const change of [
        { ownerId: 'different-owner', reason: 'message_owner_changed' },
        { accountId: 'different-account', reason: 'channel_access_changed' },
        { senderId: 'different-sender', reason: 'channel_access_changed' },
      ]) {
        await fixture.app.close();
        await pool.query(
          "UPDATE channel_outbox SET state='pending',reason=NULL WHERE source_id='channel:telegram:fixture-account:atomic-retry'",
        );
        fixture = await open(change);
        const beforeGuard: number = sent.length;
        await fixture.channels.drain();
        assert.equal(sent.length, beforeGuard);
        assert.deepEqual(
          (
            await pool.query(
              "SELECT state,reason FROM channel_outbox WHERE source_id='channel:telegram:fixture-account:atomic-retry'",
            )
          ).rows[0],
          { state: 'blocked', reason: change.reason },
        );
      }
    } finally {
      await fixture.app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('channels stay disabled without explicit enablement and require a single owner and WhatsApp eligibility review', () => {
  assert.deepEqual(
    channelConfiguration({}).map((channel) => channel.status),
    ['disabled', 'disabled'],
  );
  const missing = channelConfiguration({
    TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '987:fixture-not-live',
    WHATSAPP_ENABLED: 'true',
  });
  assert.ok(missing[0].missing.includes('TELEGRAM_ALLOWED_USER_ID'));
  assert.ok(missing[0].missing.includes('TELEGRAM_WEBHOOK_SECRET_TOKEN'));
  assert.ok(missing[1].missing.includes('WHATSAPP_POLICY_CONFIRMED'));
  assert.deepEqual(
    channelConfiguration(fixtureEnv).map((channel) => channel.status),
    ['configured', 'configured'],
  );
  assert.equal(
    JSON.stringify(channelConfiguration(fixtureEnv)).includes('fixture-not-live'),
    false,
  );
  assert.equal(
    channelConfiguration({ ...fixtureEnv, TELEGRAM_WEBHOOK_SECRET_TOKEN: 'short' })[0].status,
    'setup_required',
  );
});

test('channel replies keep secure credential and approval links in the local app', () => {
  const reply = channelReply(
    'Continue [Add credentials](/credentials/secret-id?token=secret-token) and [Approve](http://localhost:4310/approvals/private-id). Read https://example.com/docs.',
    true,
  );
  assert.equal(reply.includes('secret-token'), false);
  assert.equal(reply.includes('private-id'), false);
  assert.match(reply, /Open Sidekick on your Mac/);
  assert.match(reply, /https:\/\/example.com\/docs/);
  assert.match(reply, /Attachments are available/);
  const imageReply = channelReply(
    '[Image](http://localhost:4310/api/artifacts/private-file)',
    false,
    true,
  );
  assert.equal(imageReply, 'Attached file.');
});

test(
  'a webhook received during an outbound send is submitted before the active drain finishes',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_channels_overlap_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(`CREATE TABLE tasks(id uuid PRIMARY KEY,source_id text UNIQUE);
    CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text,role text,text text,task_id uuid,attachments jsonb DEFAULT '[]')`);
    let releaseSend = () => {};
    let markSendStarted = () => {};
    const sendReleased = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    let sends = 0;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://api.telegram.org/bot987:fixture-not-live/getMe')
        return Response.json({
          ok: true,
          result: { id: 987, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' },
        });
      if (url.startsWith('https://api.telegram.org/bot987:fixture-not-live/send')) {
        sends++;
        markSendStarted();
        await sendReleased;
        return Response.json({
          ok: true,
          result: {
            message_id: 100,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 123456, type: 'private' },
            text: 'Fixture reply',
          },
        });
      }
      throw new Error('Unexpected fixture provider call.');
    });
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'local-development',
      transport: createChatSdkTransport(pool, { ...fixtureEnv, WHATSAPP_ENABLED: 'false' }),
      subscribe: () => () => {},
      intervalMs: 600000,
      submit: async (_text, sourceId, client) => {
        const result = await client.query(
          'INSERT INTO tasks(id,source_id) VALUES($1,$2) RETURNING id',
          [randomUUID(), sourceId],
        );
        return result.rows[0].id as string;
      },
    });
    channels.registerRoutes(app);
    const send = (id: number) =>
      app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': fixtureEnv.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        },
        payload: {
          update_id: id,
          message: {
            message_id: id,
            date: Math.floor(Date.now() / 1000),
            text: `Fixture request ${id}`,
            from: { id: 123456, is_bot: false, first_name: 'Fixture' },
            chat: { id: 123456, type: 'private' },
          },
        },
      });
    try {
      assert.equal((await send(1)).statusCode, 200);
      await channels.drain();
      const task = (await pool.query('SELECT id FROM tasks')).rows[0];
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,'local-development','assistant','Fixture reply',$2)",
        [randomUUID(), task.id],
      );
      const activeDrain = channels.drain();
      await Promise.race([
        sendStarted,
        activeDrain.then(() => {
          throw new Error('The fixture reply did not reach the provider transport.');
        }),
      ]);
      assert.equal((await send(2)).statusCode, 200);
      assert.equal((await pool.query('SELECT * FROM tasks')).rowCount, 1);
      releaseSend();
      await activeDrain;
      assert.equal((await pool.query('SELECT * FROM tasks')).rowCount, 2);
      assert.equal(
        (await pool.query("SELECT * FROM channel_inbox WHERE state='pending'")).rowCount,
        0,
      );
      assert.equal(sends, 1);
    } finally {
      releaseSend();
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'Chat SDK channel fixture authenticates owner messages, commits task dedupe, and routes only task replies',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_channels_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(`CREATE TABLE tasks(id uuid PRIMARY KEY,source_id text UNIQUE);
    CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text,role text,text text,task_id uuid,attachments jsonb DEFAULT '[]')`);
    const sent: { provider: string; body: Record<string, unknown> }[] = [];
    let providerCalls = 0;
    let failSend = false;
    let failSubmit = false;
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        providerCalls++;
        const url = input instanceof Request ? input.url : String(input);
        const body =
          typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        if (url === 'https://api.telegram.org/bot987:fixture-not-live/getMe')
          return Response.json({
            ok: true,
            result: { id: 987, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' },
          });
        if (url.startsWith('https://api.telegram.org/bot987:fixture-not-live/send')) {
          sent.push({ provider: 'telegram', body });
          if (failSend) throw new Error('Fixture transport interrupted after possible acceptance.');
          return Response.json({
            ok: true,
            result: {
              message_id: sent.length + 100,
              date: Math.floor(Date.now() / 1000),
              chat: { id: 123456, type: 'private' },
              text: 'Fixture reply',
            },
          });
        }
        if (/^https:\/\/graph\.facebook\.com\/v\d+\.0\/555000\/messages$/.test(url)) {
          sent.push({ provider: 'whatsapp', body });
          return Response.json({ messages: [{ id: `wamid.fixture-out-${sent.length}` }] });
        }
        throw new Error('Unexpected fixture provider call.');
      },
    );
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'local-development',
      transport: createChatSdkTransport(pool, fixtureEnv),
      subscribe: () => () => {},
      intervalMs: 600000,
      submit: async (_text, sourceId, client) => {
        const result = await client.query(
          'INSERT INTO tasks(id,source_id) VALUES($1,$2) ON CONFLICT(source_id) DO UPDATE SET source_id=EXCLUDED.source_id RETURNING id',
          [randomUUID(), sourceId],
        );
        if (failSubmit) throw new Error('Fixture task queue unavailable.');
        return result.rows[0].id as string;
      },
    });
    channels.registerRoutes(app);
    const telegramPayload = (id: number, from = 123456, type = 'private') => ({
      update_id: id,
      message: {
        message_id: id,
        date: Math.floor(Date.now() / 1000),
        text: 'Help with a fixture task',
        from: { id: from, is_bot: false, first_name: 'Fixture' },
        chat: { id: from, type },
      },
    });
    const whatsappPayload = (
      id: string,
      from = '351910000000',
      phone = '555000',
      timestamp = Math.floor(Date.now() / 1000),
    ) => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: phone },
                messages: [
                  {
                    id,
                    from,
                    timestamp: String(timestamp),
                    type: 'text',
                    text: { body: 'A WhatsApp fixture request' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const sendTelegram = (payload: unknown, secret = fixtureEnv.TELEGRAM_WEBHOOK_SECRET_TOKEN) =>
      app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        payload: JSON.stringify(payload),
      });
    const sendWhatsApp = (payload: unknown, valid = true) => {
      const body = JSON.stringify(payload);
      const signature = `sha256=${createHmac('sha256', fixtureEnv.WHATSAPP_APP_SECRET).update(body).digest('hex')}`;
      return app.inject({
        method: 'POST',
        url: '/api/webhooks/whatsapp',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': valid ? signature : 'sha256=invalid',
        },
        payload: body,
      });
    };
    const addReply = async (sourceId: string, text = 'The fixture task is done.') => {
      const row = (
        await pool.query('SELECT task_id FROM channel_inbox WHERE source_id=$1', [sourceId])
      ).rows[0];
      const id = randomUUID();
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,'local-development','assistant',$2,$3)",
        [id, text, row.task_id],
      );
      return id;
    };
    try {
      assert.equal((await sendTelegram(telegramPayload(1), 'invalid')).statusCode, 401);
      assert.equal((await sendWhatsApp(whatsappPayload('wamid.bad'), false)).statusCode, 401);
      await sendTelegram(telegramPayload(2, 456789));
      await sendTelegram(telegramPayload(3, 123456, 'group'));
      await sendWhatsApp(whatsappPayload('wamid.other-user', '351920000000'));
      await sendWhatsApp(whatsappPayload('wamid.other-business', undefined, '999000'));
      await channels.drain();
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);
      assert.equal(providerCalls, 0);
      assert.equal(
        (
          await app.inject(
            '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123',
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject(
            '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=fixture-verify-token&hub.challenge=123',
          )
        ).body,
        '123',
      );

      failSubmit = true;
      await sendTelegram(telegramPayload(10));
      await channels.drain();
      assert.equal((await pool.query('SELECT * FROM tasks')).rowCount, 0);
      assert.equal((await pool.query('SELECT state FROM channel_inbox')).rows[0].state, 'pending');
      failSubmit = false;
      await channels.drain();
      await Promise.all([sendTelegram(telegramPayload(10)), sendTelegram(telegramPayload(10))]);
      await sendWhatsApp(whatsappPayload('wamid.good'));
      await sendWhatsApp(whatsappPayload('wamid.good'));
      await channels.drain();
      assert.equal((await pool.query('SELECT * FROM tasks')).rowCount, 2);
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 2);
      await addReply(
        'channel:telegram:987:123456:10',
        'Finish [securely](/credentials/private-token).',
      );
      await addReply('channel:whatsapp:555000:wamid.good');
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,'local-development','assistant','Unrelated web-only reply',$2)",
        [randomUUID(), randomUUID()],
      );
      await channels.drain();
      assert.equal(sent.length, 2);
      assert.equal(sent.find((message) => message.provider === 'telegram')?.body.chat_id, '123456');
      assert.equal(
        sent.find((message) => message.provider === 'whatsapp')?.body.to,
        '351910000000',
      );
      assert.equal(JSON.stringify(sent).includes('private-token'), false);
      assert.equal(JSON.stringify(sent).includes('Unrelated web-only'), false);
      await channels.drain();
      assert.equal(sent.length, 2);

      await sendWhatsApp(
        whatsappPayload('wamid.old', undefined, undefined, Math.floor(Date.now() / 1000) - 172800),
      );
      await channels.drain();
      await pool.query(
        "UPDATE channel_inbox SET received_at=now()-interval '2 days' WHERE provider='whatsapp'",
      );
      const expiredId = await addReply('channel:whatsapp:555000:wamid.old');
      await channels.drain();
      assert.deepEqual(
        (
          await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
            expiredId,
          ])
        ).rows[0],
        { state: 'blocked', reason: 'reply_window_closed' },
      );
      assert.equal(sent.length, 2);

      failSend = true;
      const uncertainId = await addReply('channel:telegram:987:123456:10');
      await channels.drain();
      assert.equal(
        (await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [uncertainId]))
          .rows[0].state,
        'uncertain',
      );
      const attempts = sent.length;
      await channels.drain();
      assert.equal(sent.length, attempts);
      const status = (await app.inject('/api/channels')).json();
      assert.equal(status.channels[0].status, 'configured');
      assert.equal(JSON.stringify(status).includes('fixture-app-secret'), false);
      assert.equal(JSON.stringify(status).includes('allowedSenderIds'), false);
      assert.equal(JSON.stringify(status).includes('accountId'), false);
      await pool.query("UPDATE channel_outbox SET state='sending' WHERE message_id=$1", [
        uncertainId,
      ]);
      const revokedId = await addReply('channel:telegram:987:123456:10');
      await app.close();
      const restarted = await createChannels(pool, {
        ownerId: 'local-development',
        transport: createChatSdkTransport(pool, {
          ...fixtureEnv,
          TELEGRAM_ALLOWED_USER_ID: '999999',
        }),
        subscribe: () => () => {},
        intervalMs: 600000,
        submit: async () => {
          throw new Error('No new task should be submitted.');
        },
      });
      try {
        await restarted.drain();
        assert.deepEqual(
          (
            await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
              uncertainId,
            ])
          ).rows[0],
          { state: 'uncertain', reason: 'interrupted_send' },
        );
        assert.deepEqual(
          (
            await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
              revokedId,
            ])
          ).rows[0],
          { state: 'blocked', reason: 'channel_access_changed' },
        );
        assert.equal(sent.length, attempts);
      } finally {
        await restarted.close();
      }
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
