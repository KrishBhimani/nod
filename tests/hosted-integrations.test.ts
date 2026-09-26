import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { createIntegrations } from '../src/server/integrations.ts';
import { createChannelSettings } from '../src/server/channel-settings.ts';
import { createChatSdkSetupVerifier } from '../src/providers/chat-sdk/settings.ts';
import type { IntegrationProvider } from '../src/ports/integrations.ts';
import type { ChannelAccountRegistry } from '../src/ports/channel-settings.ts';

async function database() {
  const schema = 'test_hosted_integrations_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  return {
    pool,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

test(
  'hosted app consent returns to its owned screen and tenant event workers cannot consume each other',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = await database();
    const apps = [Fastify(), Fastify()];
    const owners = ['owner-one', 'owner-two'];
    const callbacks = new Map<string, string>();
    const accounts = new Map<string, string>();
    const delivered = new Map<string, string[]>();
    let inspectCount = 0;
    const provider: IntegrationProvider = {
      id: 'fixture',
      configured: true,
      webhooksConfigured: true,
      supportsSubscriptions: ['gmail'],
      async createSession(owner) {
        return {
          id: 'session-' + owner,
          authorize: async (_service, callback) => {
            const accountId = randomUUID();
            accounts.set(accountId, owner);
            callbacks.set(owner, callback + '&account=' + accountId + '&success=true');
            return { accountId, url: 'https://provider.example/consent' };
          },
          execute: async () => ({}),
          search: async () => ({ tools: {}, suggestions: [] }),
        };
      },
      restoreSession: async () => {
        throw new Error();
      },
      deleteSession: async () => {},
      deleteAccount: async () => {},
      inspectAccount: async (id, owner) => {
        inspectCount++;
        assert.equal(accounts.get(id), owner);
        return { active: true, service: 'gmail' };
      },
      parseCallback: (input) => {
        const query = input as Record<string, string>;
        return { state: query.state, accountId: query.account, success: query.success === 'true' };
      },
      subscribe: async (_owner, _service, account) => ({ id: 'trigger-' + account }),
      unsubscribe: async () => {},
      verifyWebhook: async (body) => JSON.parse(String(body)),
      matchesSubscription: () => true,
    };
    const services = [];
    try {
      for (const [index, ownerId] of owners.entries()) {
        delivered.set(ownerId, []);
        const service = await createIntegrations(db.pool, {
          ownerId,
          provider,
          baseUrl: 'https://sidekick.example',
          wake: async (_text, id) => {
            delivered.get(ownerId)!.push(id);
          },
        });
        service.registerRoutes(apps[index]);
        services.push(service);
      }
      assert.equal(
        (
          await apps[0].inject({
            method: 'POST',
            url: '/api/apps/gmail/connect',
            payload: { returnTo: 'https://foreign.example' },
          })
        ).statusCode,
        400,
      );
      assert.equal(callbacks.size, 0);
      assert.equal(
        (
          await apps[0].inject({
            method: 'POST',
            url: '/api/apps/gmail/connect',
            payload: { returnTo: 'onboarding' },
          })
        ).statusCode,
        200,
      );
      const callback = new URL(callbacks.get(owners[0])!);
      const before = inspectCount;
      assert.equal(
        (await apps[1].inject(callback.pathname + callback.search)).headers.location,
        '/apps?connection=expired',
      );
      assert.equal(inspectCount, before);
      assert.equal(
        (await apps[0].inject(callback.pathname + callback.search)).headers.location,
        '/onboarding?connection=connected',
      );
      await assert.rejects(services[1].list(owners[0]), { statusCode: 403 });
      assert.equal(
        (await services[1].list()).some((connection) => connection.status === 'connected'),
        false,
      );
      await apps[1].inject({
        method: 'POST',
        url: '/api/apps/gmail/connect',
        payload: { returnTo: 'apps' },
      });
      const second = new URL(callbacks.get(owners[1])!);
      assert.equal(
        (await apps[1].inject(second.pathname + second.search)).headers.location,
        '/apps?connection=connected',
      );
      for (const [account, owner] of accounts) {
        await db.pool.query(
          'INSERT INTO integration_events(id,owner_id,summary,slug,account_id,trigger_id,provider_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            'event-' + owner,
            owner,
            'Synthetic event',
            'gmail',
            account,
            'trigger-' + account,
            'fixture',
          ],
        );
      }
      await services[0].drain();
      assert.deepEqual(delivered.get(owners[0]), ['event-' + owners[0]]);
      assert.deepEqual(delivered.get(owners[1]), []);
      assert.equal(
        (await db.pool.query('SELECT state FROM integration_events WHERE owner_id=$1', [owners[1]]))
          .rows[0].state,
        'queued',
      );
      await services[1].drain();
      assert.deepEqual(delivered.get(owners[1]), ['event-' + owners[1]]);
      await apps[0].inject({
        method: 'POST',
        url: '/api/apps/gmail/connect',
        payload: { returnTo: 'onboarding' },
      });
      const cancelled = new URL(callbacks.get(owners[0])!);
      cancelled.searchParams.set('success', 'false');
      assert.equal(
        (await apps[0].inject(cancelled.pathname + cancelled.search)).headers.location,
        '/onboarding?connection=cancelled',
      );
      await apps[0].inject({
        method: 'POST',
        url: '/api/apps/gmail/connect',
        payload: { returnTo: 'onboarding' },
      });
      const expired = new URL(callbacks.get(owners[0])!);
      await db.pool.query(
        "UPDATE app_connections SET callback_expires=now()-interval '1 minute' WHERE owner_id=$1 AND callback_hash IS NOT NULL",
        [owners[0]],
      );
      assert.equal(
        (await apps[0].inject(expired.pathname + expired.search)).headers.location,
        '/onboarding?connection=expired',
      );
    } finally {
      await Promise.all(apps.map((app) => app.close()));
      await db.close();
    }
  },
);

test(
  'hosted Telegram setup reserves one bot owner, uses fixed tenant webhook paths and binds ciphertext to its owner',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = await database();
    const key = randomBytes(32);
    const claims = new Map<string, string>();
    const registrations: string[] = [];
    const registry: ChannelAccountRegistry = {
      async claim(input) {
        const owner = claims.get(input.accountId);
        if (owner && owner !== input.ownerId) return false;
        claims.set(input.accountId, input.ownerId);
        return true;
      },
      async release(input) {
        if (claims.get(input.accountId) === input.ownerId) claims.delete(input.accountId);
      },
    };
    const apps = [Fastify(), Fastify()];
    const settings = [];
    try {
      for (const [index, ownerId] of ['owner-one', 'owner-two'].entries()) {
        const webhookUrl =
          'https://sidekick.example/api/webhooks/telegram/' + String(index + 1).repeat(43);
        const verifier = createChatSdkSetupVerifier({
          webhookUrl: () => webhookUrl,
          fetch: async (url, options) => {
            const value = String(url);
            if (value.endsWith('/getMe'))
              return Response.json({
                ok: true,
                result: {
                  id: Number(value.match(/bot(\d+):/)![1]),
                  is_bot: true,
                  first_name: 'Synthetic bot',
                  username: 'synthetic_bot',
                },
              });
            if (value.endsWith('/getWebhookInfo'))
              return Response.json({ ok: true, result: { url: '' } });
            assert.ok(value.endsWith('/setWebhook'));
            const input = JSON.parse(String(options?.body));
            assert.equal(input.url, webhookUrl);
            assert.equal(input.drop_pending_updates, false);
            registrations.push(input.url);
            return Response.json({ ok: true, result: true });
          },
        });
        const service = await createChannelSettings(db.pool, {
          ownerId,
          accounts: registry,
          keyStore: { id: 'fixture', configured: true, getKey: async () => key },
          verifier,
          apply: async () => {},
        });
        service.registerRoutes(apps[index]);
        settings.push(service);
      }
      const save = (index: number, token: string, extra = {}) =>
        apps[index].inject({
          method: 'PUT',
          url: '/api/channel-settings/telegram',
          payload: { botToken: token, allowedUserId: '123', ...extra },
        });
      assert.equal(
        (
          await save(0, '987:synthetic_token', {
            webhookUrl: 'https://foreign.example/api/webhooks/telegram',
          })
        ).statusCode,
        400,
      );
      assert.equal(registrations.length, 0);
      assert.equal((await save(0, '987:synthetic_token')).statusCode, 200);
      assert.equal((await save(1, '987:synthetic_token')).statusCode, 400);
      assert.equal(registrations.length, 1);
      assert.equal(claims.get('987'), 'owner-one');
      assert.equal((await settings[1].status()).channels.length, 0);
      assert.equal((await save(1, '988:synthetic_token')).statusCode, 200);
      await db.pool.query(
        "UPDATE channel_settings SET ciphertext=(SELECT ciphertext FROM channel_settings WHERE owner_id='owner-one' AND provider='telegram') WHERE owner_id='owner-two' AND provider='telegram'",
      );
      await assert.rejects(settings[1].environment());
      await apps[0].inject({ method: 'DELETE', url: '/api/channel-settings/telegram' });
      assert.equal(claims.has('987'), false);
    } finally {
      await Promise.all(apps.map((app) => app.close()));
      await db.close();
    }
  },
);
