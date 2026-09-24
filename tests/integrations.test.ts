import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { IntegrationProvider, IntegrationSession } from '../src/ports/integrations.ts';
import Fastify from 'fastify';
import pg from 'pg';
import { createIntegrations, eventOverview } from '../src/server/integrations.ts';

function fakeProvider(session: IntegrationSession): IntegrationProvider {
  return {
    id: 'fixture',
    configured: true,
    webhooksConfigured: true,
    supportsSubscriptions: ['gmail', 'googlecalendar'],
    createSession: async () => session,
    restoreSession: async () => session,
    deleteSession: async () => {},
    inspectAccount: async () => ({ active: true, service: 'gmail' }),
    deleteAccount: async () => {},
    subscribe: async () => ({ id: 'ti-fixture' }),
    unsubscribe: async () => {},
    parseCallback: (raw) => {
      const query = raw as Record<string, string>;
      return { state: query.state, accountId: query.account_ref, success: query.outcome === 'ok' };
    },
    matchesSubscription: (service, trigger) =>
      service === 'gmail' && trigger === 'fixture-inbox-update',
    verifyWebhook: async (body, headers) => {
      if (headers['x-fixture-valid'] !== 'yes') throw new Error('Fixture rejected the signature.');
      return JSON.parse(String(body));
    },
  };
}

test('notification summaries exclude message bodies, tokens, and unbounded provider payloads', () => {
  const summary = eventOverview('gmail', 'GMAIL_NEW_GMAIL_MESSAGE', {
    subject: `Login code 123456 ${'x'.repeat(3000)}`,
    sender: 'person@example.com',
    message_text: 'private body',
    access_token: 'provider-secret',
    payload: { password: 'another-secret' },
  });
  assert.match(summary, /untrusted event data/);
  assert.match(summary, /person@example.com/);
  for (const excluded of ['123456', 'private body', 'provider-secret', 'another-secret'])
    assert.equal(summary.includes(excluded), false);
  assert.ok(summary.length < 1000);
});

test(
  'integration policy accepts verified events, rejects cross-account events, deduplicates, and gates writes',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_composio_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    let executed = 0;
    const delivered: string[] = [];
    const session: IntegrationSession = {
      id: 'fixture-session',
      authorize: async () => ({ accountId: 'ca-fixture', url: 'https://fixture.example/connect' }),
      execute: async () => {
        executed++;
        return { successful: true, data: { messages: [] } };
      },
      search: async () => ({
        tools: { GMAIL_SEND_EMAIL: { inputSchema: { type: 'object' } } },
        suggestions: [{ useCase: 'Send email', primaryToolSlugs: ['GMAIL_SEND_EMAIL'] }],
      }),
    };
    const provider = fakeProvider(session);
    const integrations = await createIntegrations(pool, {
      provider,
      baseUrl: 'http://localhost:4310',
      wake: async (prompt, id) => {
        delivered.push(id);
        assert.equal(prompt.includes('provider-secret'), false);
      },
    });
    integrations.registerRoutes(app);
    const event = {
      id: 'event-fixture-1',
      ownerId: 'local-development',
      service: 'gmail',
      accountId: 'ca-fixture',
      subscriptionId: 'ti-fixture',
      trigger: 'fixture-inbox-update',
      data: {
        subject: 'Meeting request',
        sender: 'person@example.com',
        access_token: 'provider-secret',
      },
    };
    async function send(value: unknown, invalid = false) {
      return app.inject({
        method: 'POST',
        url: '/api/webhooks/fixture',
        payload: JSON.stringify(value),
        headers: { 'content-type': 'application/json', 'x-fixture-valid': invalid ? 'no' : 'yes' },
      });
    }
    try {
      await pool.query(
        "INSERT INTO app_connections (owner_id,slug,account_id,trigger_id,triggers_enabled,provider_id) VALUES ('local-development','gmail','ca-fixture','ti-fixture',true,'fixture')",
      );
      const invalid = await send(event, true);
      assert.equal(invalid.statusCode, 401);
      assert.equal((await send({ ...event, ownerId: 'another-user' })).statusCode, 202);
      assert.equal((await send({ ...event, accountId: 'another-account' })).statusCode, 202);
      assert.equal((await pool.query('SELECT * FROM integration_events')).rowCount, 0);
      assert.equal((await send(event)).statusCode, 202);
      assert.equal((await send(event)).statusCode, 202);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          (await pool.query("SELECT * FROM integration_events WHERE state = 'delivered'"))
            .rowCount === 1
        )
          break;
        await delay(10);
      }
      assert.deepEqual(delivered, ['fixture:event-fixture-1']);
      assert.equal((await pool.query('SELECT * FROM integration_events')).rowCount, 1);
      const result = await integrations.execute('local-development', 'GMAIL_SEND_EMAIL', {
        recipient_email: 'test@example.com',
        subject: 'Fixture',
      });
      assert.deepEqual(result, {
        requiresApproval: true,
        action: 'GMAIL_SEND_EMAIL',
        args: { recipient_email: 'test@example.com', subject: 'Fixture' },
      });
      assert.equal(executed, 0);
      await integrations.execute('local-development', 'GMAIL_FETCH_EMAILS', { max_results: 5 });
      assert.equal(executed, 1);
      await integrations.executeApproved('local-development', 'GMAIL_SEND_EMAIL', {
        recipient_email: 'fixture@example.com',
      });
      assert.equal(executed, 2);
      await assert.rejects(integrations.execute('another-user', 'GMAIL_FETCH_EMAILS', {}));
      await assert.rejects(
        integrations.executeApproved('local-development', 'COMPOSIO_MULTI_EXECUTE_TOOL', {}),
      );
      await assert.rejects(
        integrations.executeApproved('local-development', 'GITHUB_CREATE_ISSUE', {}),
      );
      const search = await integrations.execute('local-development', 'SEARCH_TOOLS', {
        query: 'Send an email',
      });
      assert.equal(JSON.stringify(search).includes('do-not-expose'), false);
      t.mock.method(session, 'search', async () => {
        throw new Error('raw-provider-secret and internal setup details');
      });
      await assert.rejects(
        integrations.execute('local-development', 'SEARCH_TOOLS', { query: 'List Gmail labels' }),
        { message: 'Google tool search is unavailable. Try again later.', statusCode: 502 },
      );
      await pool.query(
        "INSERT INTO integration_events (id,owner_id,summary,slug,account_id,trigger_id,provider_id) VALUES ('event-queued-before-disconnect','local-development','Obsolete event','gmail','ca-fixture','ti-fixture','fixture')",
      );
      await pool.query(
        "INSERT INTO integration_events (id,owner_id,summary,slug,account_id,trigger_id,provider_id,state,claimed_at) VALUES ('event-processing-before-disconnect','local-development','Interrupted event','gmail','ca-fixture','ti-fixture','fixture','processing',now()-interval '10 minutes')",
      );
      await pool.query(
        "UPDATE app_connections SET revoked = true, triggers_enabled = false WHERE slug = 'gmail'",
      );
      await integrations.drain();
      assert.equal(
        (
          await pool.query(
            "SELECT state FROM integration_events WHERE id = 'event-queued-before-disconnect'",
          )
        ).rows[0].state,
        'discarded',
      );
      assert.equal(
        (
          await pool.query(
            "SELECT state FROM integration_events WHERE id = 'event-processing-before-disconnect'",
          )
        ).rows[0].state,
        'discarded',
      );
      assert.equal(delivered.length, 1);
      await assert.rejects(
        integrations.executeApproved('local-development', 'GMAIL_SEND_EMAIL', {}),
      );
      assert.equal((await send({ ...event, id: 'event-after-disconnect' })).statusCode, 202);
      assert.equal((await pool.query('SELECT * FROM integration_events')).rowCount, 3);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'connection callback requires its saved attempt and a provider-verified active account',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_composio_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    let callback = '';
    let providerStatus = 'INITIATED';
    const session: IntegrationSession = {
      id: 'fixture-session',
      authorize: async (_service, callbackUrl) => {
        callback = callbackUrl;
        return { accountId: 'ca-fixture', url: 'https://fixture.example/connect' };
      },
      execute: async () => ({}),
      search: async () => ({ tools: {}, suggestions: [] }),
    };
    const provider = fakeProvider(session);
    provider.inspectAccount = async () => ({
      active: providerStatus === 'ACTIVE',
      service: 'gmail',
    });
    const app = Fastify();
    const integrations = await createIntegrations(pool, {
      provider,
      baseUrl: 'http://localhost:4310',
      wake: async () => {},
    });
    integrations.registerRoutes(app);
    try {
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/connections/gmail/connect' })).statusCode,
        200,
      );
      const url = new URL(callback);
      url.searchParams.set('outcome', 'ok');
      url.searchParams.set('account_ref', 'ca-other-user');
      assert.equal((await app.inject({ url: `${url.pathname}${url.search}` })).statusCode, 409);
      url.searchParams.set('account_ref', 'ca-fixture');
      assert.equal((await app.inject({ url: `${url.pathname}${url.search}` })).statusCode, 409);
      providerStatus = 'ACTIVE';
      assert.equal((await app.inject({ url: `${url.pathname}${url.search}` })).statusCode, 302);
      assert.equal((await app.inject({ url: `${url.pathname}${url.search}` })).statusCode, 409);
      const connection = (await integrations.list()).find((item) => item.slug === 'gmail');
      assert.equal(connection?.status, 'connected');
      assert.equal(connection?.triggersEnabled, false);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'legacy integration references migrate intact and a different provider cannot use them',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_integrations_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    let app = Fastify();
    let restored = '';
    let executions = 0;
    const session: IntegrationSession = {
      id: 'legacy-session',
      authorize: async () => ({ accountId: 'ca-new', url: 'https://fixture.example/connect' }),
      execute: async () => {
        executions++;
        return {};
      },
      search: async () => ({ tools: {}, suggestions: [] }),
    };
    const provider = fakeProvider(session);
    provider.id = 'composio';
    provider.restoreSession = async (id) => {
      restored = id;
      return session;
    };
    let replacementApp: ReturnType<typeof Fastify> | undefined;
    try {
      const original = await createIntegrations(pool, {
        provider,
        baseUrl: 'http://localhost:4310',
        wake: async () => {},
      });
      original.registerRoutes(app);
      await pool.query(
        "INSERT INTO app_connections(owner_id,slug,account_id,provider_id) VALUES('local-development','gmail','legacy-account','composio')",
      );
      await pool.query(
        "INSERT INTO integration_sessions(owner_id,session_id,provider_id) VALUES('local-development','legacy-session','composio')",
      );
      await pool.query(
        "INSERT INTO integration_events(id,owner_id,summary,state,provider_id) VALUES('composio:legacy-event','local-development','Legacy delivered event','delivered','composio')",
      );
      await app.close();
      await pool.query(
        'ALTER TABLE integration_sessions RENAME TO composio_sessions; ALTER TABLE integration_events RENAME TO composio_events; ALTER TABLE app_connections DROP COLUMN provider_id; ALTER TABLE composio_sessions DROP COLUMN provider_id; ALTER TABLE composio_events DROP COLUMN provider_id',
      );
      app = Fastify();
      const migrated = await createIntegrations(pool, {
        provider,
        baseUrl: 'http://localhost:4310',
        wake: async () => {},
      });
      migrated.registerRoutes(app);
      await migrated.execute('local-development', 'GMAIL_FETCH_EMAILS', {});
      assert.equal(restored, 'legacy-session');
      assert.equal(executions, 1);
      assert.equal(
        (
          await pool.query(
            "SELECT provider_id FROM integration_events WHERE id='composio:legacy-event'",
          )
        ).rows[0].provider_id,
        'composio',
      );
      const replacement = await createIntegrations(pool, {
        provider: fakeProvider(session),
        baseUrl: 'http://localhost:4310',
        wake: async () => {},
      });
      replacementApp = Fastify();
      replacement.registerRoutes(replacementApp);
      await assert.rejects(replacement.execute('local-development', 'GMAIL_FETCH_EMAILS', {}));
      assert.equal(
        (await replacementApp.inject({ method: 'POST', url: '/api/connections/gmail/connect' }))
          .statusCode,
        409,
      );
      assert.equal(executions, 1);
    } finally {
      await replacementApp?.close();
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
