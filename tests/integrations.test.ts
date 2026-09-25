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
        args: {
          recipient_email: 'test@example.com',
          subject: 'Fixture',
          connectionId: (await integrations.list()).find((row) => row.slug === 'gmail')
            ?.connectionId,
        },
      });
      assert.equal(executed, 0);
      await integrations.execute('local-development', 'GMAIL_FETCH_EMAILS', { max_results: 5 });
      assert.equal(executed, 1);
      await integrations.executeApproved('local-development', 'GMAIL_SEND_EMAIL', {
        recipient_email: 'fixture@example.com',
        connectionId: (await integrations.list()).find((row) => row.slug === 'gmail')?.connectionId,
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
        { message: 'App tool search is unavailable. Try again later.', statusCode: 502 },
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
        (await app.inject({ method: 'POST', url: '/api/apps/gmail/connect' })).statusCode,
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
      assert.equal(connection?.triggersEnabled, true);
      assert.equal(connection?.triggersActive, true);
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
        "INSERT INTO integration_sessions(owner_id,session_id,provider_id,configuration_version) VALUES('local-development','legacy-session','composio',3)",
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
        (await replacementApp.inject({ method: 'POST', url: '/api/apps/gmail/connect' }))
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

test(
  'multiple Google accounts keep independent identity, approvals, subscriptions and revocation',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_accounts_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    let attempt = 0;
    const callbacks: string[] = [];
    const executions: Array<{ action: string; args: Record<string, unknown>; accountId?: string }> =
      [];
    const subscriptions: string[] = [];
    const deleted: string[] = [];
    const accountSets: unknown[] = [];
    const session: IntegrationSession = {
      id: 'fixture-session',
      authorize: async (_service, callback) => {
        callbacks.push(callback);
        return { accountId: `account-${++attempt}`, url: 'https://fixture.example/connect' };
      },
      search: async () => ({ tools: {}, suggestions: [] }),
      execute: async (action, args, accountId) => {
        executions.push({ action, args, accountId });
        return { data: { labels: [] } };
      },
    };
    const provider = fakeProvider(session);
    provider.createSession = async (_owner, accounts) => {
      accountSets.push(accounts);
      return session;
    };
    provider.inspectAccount = async (id) => ({
      active: true,
      service: 'gmail',
      accountName: id === 'account-1' ? 'Personal account' : 'Work account',
      accountEmail: `${id}@example.com`,
    });
    provider.subscribe = async (_owner, _service, accountId) => {
      subscriptions.push(accountId);
      return { id: `trigger-${accountId}` };
    };
    provider.deleteAccount = async (id) => {
      deleted.push(id);
    };
    const delivered: string[] = [];
    const integrations = await createIntegrations(pool, {
      provider,
      baseUrl: 'http://localhost:4310',
      wake: async (prompt) => {
        delivered.push(prompt);
      },
    });
    integrations.registerRoutes(app);
    async function connect() {
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/apps/gmail/connect' })).statusCode,
        200,
      );
      const callback = new URL(callbacks.at(-1)!);
      callback.searchParams.set('account_ref', `account-${attempt}`);
      callback.searchParams.set('outcome', 'ok');
      assert.equal(
        (await app.inject({ url: `${callback.pathname}${callback.search}` })).statusCode,
        302,
      );
    }
    try {
      await connect();
      await connect();
      const accounts = (await integrations.list()).filter((row) => row.slug === 'gmail');
      assert.equal(accounts.length, 2);
      const first = accounts.find((row) => row.accountId === 'account-1')!;
      const second = accounts.find((row) => row.accountId === 'account-2')!;
      assert.equal(first.accountEmail, 'account-1@example.com');
      assert.equal(second.accountName, 'Work account');
      assert.equal(first.triggerStatus, 'active');
      assert.equal(second.triggerStatus, 'active');
      assert.deepEqual(subscriptions, ['account-1', 'account-2']);
      await assert.rejects(integrations.execute('local-development', 'GMAIL_LIST_LABELS', {}), {
        statusCode: 409,
      });
      await integrations.execute('local-development', 'GMAIL_LIST_LABELS', {
        connectionId: second.connectionId,
        user_id: 'me',
      });
      assert.deepEqual(executions, [
        { action: 'GMAIL_LIST_LABELS', args: { user_id: 'me' }, accountId: 'account-2' },
      ]);
      assert.deepEqual(accountSets.at(-1), { gmail: ['account-1', 'account-2'] });
      const approval = await integrations.execute('local-development', 'GMAIL_SEND_EMAIL', {
        connectionId: first.connectionId,
        subject: 'Fixture',
      });
      assert.deepEqual(approval, {
        requiresApproval: true,
        action: 'GMAIL_SEND_EMAIL',
        args: { connectionId: first.connectionId, subject: 'Fixture' },
      });
      assert.equal(executions.length, 1);
      const search = (await integrations.execute('local-development', 'SEARCH_TOOLS', {
        query: 'List Gmail labels',
      })) as { accounts: Array<{ connectionId: string }> };
      assert.deepEqual(
        new Set(search.accounts.map((row) => row.connectionId)),
        new Set([first.connectionId, second.connectionId]),
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/apps/gmail/disconnect' })).statusCode,
        409,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/apps/googlecalendar/accounts/${second.connectionId}/disconnect`,
          })
        ).statusCode,
        404,
      );
      const foreign = (
        await pool.query<{ id: string }>(
          "INSERT INTO app_connections(owner_id,slug,account_id,provider_id) VALUES('another-owner','gmail','foreign-account','fixture') RETURNING id",
        )
      ).rows[0].id;
      await assert.rejects(
        integrations.execute('local-development', 'GMAIL_LIST_LABELS', { connectionId: foreign }),
        { statusCode: 404 },
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/apps/gmail/accounts/${foreign}/disconnect`,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/apps/gmail/accounts/${first.connectionId}/triggers`,
            payload: { enabled: false },
          })
        ).statusCode,
        409,
      );
      const afterToggle = (await integrations.list()).filter((row) => row.slug === 'gmail');
      assert.equal(
        afterToggle.find((row) => row.connectionId === first.connectionId)?.triggerStatus,
        'active',
      );
      assert.equal(
        afterToggle.find((row) => row.connectionId === second.connectionId)?.triggerStatus,
        'active',
      );
      const event = {
        id: 'second-account-event',
        ownerId: 'local-development',
        service: 'gmail',
        accountId: 'account-2',
        subscriptionId: 'trigger-account-2',
        trigger: 'fixture-inbox-update',
        data: { subject: 'Fixture update' },
      };
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/webhooks/fixture',
        payload: JSON.stringify(event),
        headers: { 'content-type': 'application/json', 'x-fixture-valid': 'yes' },
      });
      assert.equal(accepted.statusCode, 202);
      for (let index = 0; index < 30 && !delivered.length; index++) await delay(10);
      assert.equal(delivered.length, 1);
      assert.ok(delivered[0].includes(second.connectionId!));
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/apps/gmail/accounts/${first.connectionId}/disconnect`,
          })
        ).statusCode,
        200,
      );
      assert.deepEqual(deleted, ['account-1']);
      assert.equal((await integrations.list()).filter((row) => row.slug === 'gmail').length, 1);
      await assert.rejects(
        integrations.executeApproved('local-development', 'GMAIL_SEND_EMAIL', {
          connectionId: first.connectionId,
        }),
        { statusCode: 404 },
      );
      for (const connectionId of [undefined, 'invalid-account-reference']) {
        await assert.rejects(
          integrations.validateApproval('local-development', 'GMAIL_SEND_EMAIL', {
            ...(connectionId === undefined ? {} : { connectionId }),
          }),
          { statusCode: 409 },
        );
        await assert.rejects(
          integrations.executeApproved('local-development', 'GMAIL_SEND_EMAIL', {
            subject: 'Legacy pending approval',
            ...(connectionId === undefined ? {} : { connectionId }),
          }),
          {
            statusCode: 409,
            message:
              'This approval does not identify its connected account. Request a new approval.',
          },
        );
      }
      assert.equal(executions.length, 1);
      await integrations.execute('local-development', 'GMAIL_LIST_LABELS', {});
      assert.equal(executions.at(-1)?.accountId, 'account-2');
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'single-account migration preserves active accounts and pending consent while default watches wait for webhook configuration',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_account_migration_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    try {
      await pool.query(`CREATE TABLE app_connections(owner_id text NOT NULL,slug text NOT NULL,account_id text,pending_account_id text,callback_hash text,callback_expires timestamptz,trigger_id text,triggers_enabled boolean NOT NULL DEFAULT false,revoked boolean NOT NULL DEFAULT false,PRIMARY KEY(owner_id,slug));
      INSERT INTO app_connections(owner_id,slug,account_id,pending_account_id,callback_hash,callback_expires) VALUES('local-development','gmail','existing-account','pending-account','pending-hash',now()+interval '10 minutes');`);
      const session: IntegrationSession = {
        id: 'fixture-session',
        authorize: async () => ({ accountId: 'unused', url: 'https://fixture.example' }),
        search: async () => ({ tools: {}, suggestions: [] }),
        execute: async () => ({}),
      };
      const provider = fakeProvider(session);
      provider.id = 'composio';
      provider.webhooksConfigured = false;
      provider.subscribe = async () => {
        assert.fail('No watch without a signed webhook');
      };
      const integrations = await createIntegrations(pool, {
        provider,
        baseUrl: 'http://localhost:4310',
        wake: async () => {},
      });
      integrations.registerRoutes(app);
      const migrated = await pool.query(
        'SELECT * FROM app_connections ORDER BY account_id NULLS LAST',
      );
      assert.equal(migrated.rowCount, 2);
      assert.equal(migrated.rows[0].account_id, 'existing-account');
      assert.equal(migrated.rows[0].pending_account_id, null);
      assert.equal(migrated.rows[1].pending_account_id, 'pending-account');
      assert.equal(migrated.rows[1].callback_hash, 'pending-hash');
      await integrations.syncWatches();
      const gmail = (await integrations.list()).find((row) => row.slug === 'gmail')!;
      assert.equal(gmail.triggersEnabled, true);
      assert.equal(gmail.triggersActive, false);
      assert.equal(gmail.triggerStatus, 'unavailable');
      const uuid = gmail.connectionId;
      const restarted = await createIntegrations(pool, {
        provider,
        baseUrl: 'http://localhost:4310',
        wake: async () => {},
      });
      const secondApp = Fastify();
      restarted.registerRoutes(secondApp);
      try {
        assert.equal((await pool.query('SELECT * FROM app_connections')).rowCount, 2);
        assert.equal(
          (await restarted.list()).find((row) => row.slug === 'gmail')?.connectionId,
          uuid,
        );
      } finally {
        await secondApp.close();
      }
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
