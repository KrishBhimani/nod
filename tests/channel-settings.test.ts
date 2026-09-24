import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { ChannelSetupFailure } from '../src/ports/channel-settings.ts';
import { createChatSdkSetupVerifier } from '../src/providers/chat-sdk/settings.ts';
import { createChatSdkTransport } from '../src/providers/chat-sdk/index.ts';
import { createChannelSettings } from '../src/server/channel-settings.ts';
import { createChannels } from '../src/server/channels.ts';
import type { MessagingTransport } from '../src/ports/messaging.ts';

const token = '987:fixture-never-live';
test('channel verifier checks the selected accounts and requires an explicit change from an existing Telegram webhook', async () => {
  const calls: string[] = [];
  let existingWebhook = '';
  const verifier = createChatSdkSetupVerifier({
    fetch: async (url, init) => {
      const path = String(url);
      calls.push(path);
      if (path.endsWith('/getMe'))
        return Response.json({
          ok: true,
          result: { id: 987, is_bot: true, first_name: 'Fixture bot', username: 'fixture_bot' },
        });
      if (path.endsWith('/getWebhookInfo'))
        return Response.json({ ok: true, result: { url: existingWebhook } });
      if (path.endsWith('/setWebhook')) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.url, 'https://webhook.example.com/api/webhooks/telegram');
        assert.deepEqual(body.allowed_updates, ['message']);
        assert.equal(body.drop_pending_updates, false);
        assert.ok(body.secret_token.length >= 32);
        return Response.json({ ok: true, result: true });
      }
      if (path.startsWith('https://graph.facebook.com/v25.0/555')) {
        assert.equal(
          new Headers(init?.headers).get('Authorization'),
          'Bearer whatsapp-fixture-token',
        );
        assert.equal(new URL(path).searchParams.has('appsecret_proof'), true);
        return Response.json({
          id: '555',
          display_phone_number: '+351 910 000 000',
          verified_name: 'Fixture business',
        });
      }
      assert.fail('Unexpected provider call');
    },
  });
  const polling = await verifier.verify('telegram', { botToken: token, allowedUserId: '123' });
  assert.equal(polling.environment.TELEGRAM_MODE, 'polling');
  assert.equal(polling.summary.accountHandle, '@fixture_bot');
  assert.equal(JSON.stringify(polling.summary).includes(token), false);
  existingWebhook = 'https://old.example.com/handler';
  await assert.rejects(
    verifier.verify('telegram', { botToken: token, allowedUserId: '123' }),
    (error) => error instanceof ChannelSetupFailure && error.reason === 'existing_webhook',
  );
  const webhook = await verifier.verify('telegram', {
    botToken: token,
    allowedUserId: '123',
    webhookUrl: 'https://webhook.example.com/api/webhooks/telegram',
  });
  assert.equal(webhook.summary.webhookStatus, 'registered');
  await assert.rejects(
    verifier.verify('telegram', {
      botToken: token,
      allowedUserId: '123',
      webhookUrl: 'https://127.0.0.1/api/webhooks/telegram',
    }),
  );
  const whatsapp = {
    accessToken: 'whatsapp-fixture-token',
    appSecret: 'a'.repeat(32),
    phoneNumberId: '555',
    allowedNumber: '351910000000',
    verifyToken: 'fixture-verification-token',
    policyConfirmed: true,
  };
  assert.equal(
    (await verifier.verify('whatsapp', whatsapp)).summary.accountName,
    'Fixture business',
  );
  await assert.rejects(verifier.verify('whatsapp', { ...whatsapp, policyConfirmed: false }));
  assert.equal(
    calls.some((url) => url.includes('sendMessage') || url.includes('/messages')),
    false,
  );
});

test(
  'channel setup encrypts secrets, returns only metadata, preserves previous configuration on verification failure and disables without retaining ciphertext',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_channel_settings_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    const key = randomBytes(32);
    let fails = false;
    let applied: Record<string, string> = {};
    let applyCount = 0;
    const options = {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      verifier: {
        verify: async () => {
          if (fails) throw new Error('secret-provider-error');
          return {
            environment: {
              TELEGRAM_ENABLED: 'true',
              TELEGRAM_BOT_TOKEN: token,
              TELEGRAM_ALLOWED_USER_ID: '123',
              TELEGRAM_WEBHOOK_SECRET_TOKEN: 'fixture-webhook-secret',
              TELEGRAM_MODE: 'polling',
            },
            summary: { provider: 'telegram' as const, enabled: true, accountName: 'Fixture bot' },
          };
        },
      },
      apply: async (environment: Record<string, string>) => {
        applied = environment;
        applyCount++;
      },
    };
    try {
      const settings = await createChannelSettings(pool, options);
      settings.registerRoutes(app);
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/channel-settings/telegram',
        payload: { botToken: token, allowedUserId: '123' },
      });
      assert.equal(saved.statusCode, 200);
      assert.equal(saved.body.includes(token), false);
      assert.equal(applied.TELEGRAM_BOT_TOKEN, token);
      const raw = (await pool.query('SELECT * FROM channel_settings')).rows[0];
      assert.equal(JSON.stringify(raw).includes(token), false);
      assert.equal(JSON.stringify(raw).includes('fixture-webhook-secret'), false);
      const status = await app.inject('/api/channel-settings');
      assert.equal(status.body.includes(token), false);
      assert.equal(status.body.includes('TELEGRAM_BOT_TOKEN'), false);
      fails = true;
      const failed = await app.inject({
        method: 'PUT',
        url: '/api/channel-settings/telegram',
        payload: { botToken: 'bad-key', allowedUserId: '123' },
      });
      assert.equal(failed.statusCode, 503);
      assert.equal(failed.body.includes('secret-provider-error'), false);
      assert.equal(applyCount, 1);
      assert.equal((await settings.environment()).TELEGRAM_BOT_TOKEN, token);
      const restored = await createChannelSettings(pool, options);
      assert.equal((await restored.environment()).TELEGRAM_BOT_TOKEN, token);
      await pool.query("UPDATE channel_settings SET provider='whatsapp'");
      await assert.rejects(settings.environment());
      await pool.query("UPDATE channel_settings SET provider='telegram'");
      assert.equal(
        (await app.inject({ method: 'DELETE', url: '/api/channel-settings/telegram' })).statusCode,
        200,
      );
      assert.deepEqual(applied, { TELEGRAM_ENABLED: 'false' });
      assert.equal(
        (await pool.query('SELECT ciphertext FROM channel_settings')).rows[0].ciphertext,
        null,
      );
      assert.deepEqual(await settings.environment(), { TELEGRAM_ENABLED: 'false' });
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'Telegram polling advances its durable offset only after accepted inbox persistence',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_channel_poll_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const offsets: number[] = [];
    const transport = createChatSdkTransport(
      pool,
      {
        TELEGRAM_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_ALLOWED_USER_ID: '123',
        TELEGRAM_WEBHOOK_SECRET_TOKEN: 'fixture-secret-long-enough',
        TELEGRAM_MODE: 'polling',
      },
      {
        fetch: async (url, init) => {
          assert.equal(String(url), `https://api.telegram.org/bot${token}/getUpdates`);
          offsets.push(JSON.parse(String(init?.body)).offset);
          return Response.json({
            ok: true,
            result:
              offsets.at(-1) === 42
                ? []
                : [
                    {
                      update_id: 41,
                      message: {
                        message_id: 8,
                        date: Math.floor(Date.now() / 1000),
                        text: 'Fixture polling request',
                        from: { id: 123, is_bot: false, first_name: 'Fixture' },
                        chat: { id: 123, type: 'private' },
                      },
                    },
                  ],
          });
        },
      },
    );
    try {
      await assert.rejects(
        transport.poll!(async () => {
          throw new Error('database fixture failure');
        }),
      );
      assert.equal((await pool.query('SELECT * FROM channel_poll_offsets')).rowCount, 0);
      let accepted = 0;
      await transport.poll!(async (message) => {
        assert.equal(message.senderId, '123');
        assert.equal(message.text, 'Fixture polling request');
        accepted++;
      });
      await transport.poll!(async () => {
        assert.fail('Already persisted update');
      });
      assert.deepEqual(offsets, [0, 0, 42]);
      assert.equal(accepted, 1);
    } finally {
      await transport.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'transport replacement waits for active delivery and applies the new owner binding to later work',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_channel_replace_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      'CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text,role text,text text,task_id uuid,attachments jsonb)',
    );
    let release: () => void = () => {};
    let started: () => void = () => {};
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const sending = new Promise<void>((done) => {
      started = done;
    });
    let closed = false;
    const transport: MessagingTransport = {
      channels: [
        {
          id: 'telegram',
          status: 'configured',
          missing: [],
          accountId: 'bot',
          allowedSenderIds: ['123'],
        },
      ],
      receive: async () => ({ status: 200, body: {} }),
      post: async () => {
        started();
        await blocked;
        return { id: 'provider-message' };
      },
      close: async () => {
        closed = true;
      },
    };
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'local-development',
      transport,
      subscribe: () => () => {},
      submit: async () => randomUUID(),
      intervalMs: 600000,
    });
    channels.registerRoutes(app);
    try {
      const task = randomUUID();
      const message = randomUUID();
      await pool.query(
        "INSERT INTO channel_inbox(source_id,provider,account_id,sender_id,thread_id,text,received_at,task_id,state) VALUES('fixture','telegram','bot','123','telegram:123','Fixture',now(),$1,'submitted')",
        [task],
      );
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,task_id,attachments) VALUES($1,'local-development','assistant','Fixture reply',$2,'[]')",
        [message, task],
      );
      const draining = channels.drain();
      await sending;
      const next: MessagingTransport = {
        ...transport,
        channels: [{ id: 'telegram', status: 'disabled', missing: [], allowedSenderIds: [] }],
        post: async () => {
          assert.fail('Disabled transport cannot send');
        },
        close: async () => {},
      };
      let swapped = false;
      const replacing = channels.replaceTransport(next).then(() => {
        swapped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(swapped, false);
      assert.equal(closed, false);
      release();
      await draining;
      await replacing;
      assert.equal(closed, true);
      assert.equal((await app.inject('/api/channels')).json().channels[0].status, 'disabled');
    } finally {
      release();
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
