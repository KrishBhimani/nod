import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Composio } from '@composio/core';
import Fastify from 'fastify';
import pg from 'pg';
import { createComposioProvider } from '../src/providers/composio/integrations.ts';
import { createIntegrations } from '../src/server/integrations.ts';

test(
  'adding another Gmail account uses isolated consent without changing the pinned execution account',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_consent_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    t.after(async () => {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const client = new Composio({
      apiKey: 'fixture-key-never-live',
      allowTracking: false,
      disableVersionCheck: true,
      fileUploadDirs: false,
    });
    const transport = client.getClient().toolRouter.session;
    const created: Array<{ id: string; config: Record<string, unknown> }> = [];
    const deleted: string[] = [];
    const links: Array<{ id: string; input: Record<string, unknown> }> = [];
    const configurations = new Map<string, Record<string, unknown>>([
      ['execution-session', { connected_accounts: { gmail: ['existing-account'] } }],
    ]);
    function session(id: string) {
      return {
        session_id: id,
        mcp: { type: 'http', url: `https://backend.composio.dev/tool_router/mcp/${id}` },
        config: { user_id: 'local-development', ...configurations.get(id) },
        config_version: 1,
      };
    }
    t.mock.method(transport, 'retrieve', async (id: string) => session(id));
    t.mock.method(transport, 'create', async (config: Record<string, unknown>) => {
      const id = `consent-session-${created.length + 1}`;
      configurations.set(id, config);
      created.push({ id, config });
      return session(id);
    });
    let failure: 'provider' | 'url' | undefined;
    let cleanupFailure = false;
    t.mock.method(transport, 'link', async (id: string, input: Record<string, unknown>) => {
      links.push({ id, input });
      const accounts = configurations.get(id)?.connected_accounts as Record<string, string[]>;
      if (accounts?.gmail?.length)
        throw Object.assign(
          new Error(
            "Connected account already defined for toolkit 'gmail'. Cannot create a new link when connected_accounts is set.",
          ),
          { status: 400, error: { code: 4309 } },
        );
      if (failure === 'provider') throw new Error('synthetic-private-provider-detail');
      return {
        connected_account_id: `new-account-${created.length}`,
        redirect_url:
          failure === 'url'
            ? 'https://untrusted.example/connect'
            : 'https://connect.composio.dev/link/synthetic-consent',
      };
    });
    t.mock.method(
      client.getClient(),
      'delete',
      async (path: string, options: { signal?: AbortSignal }) => {
        assert.match(path, /^\/api\/v3\.1\/tool_router\/session\//);
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(options.signal.aborted, false);
        const id = decodeURIComponent(path.split('/').at(-1)!);
        deleted.push(id);
        assert.notEqual(id, 'execution-session');
        if (cleanupFailure) throw new Error('synthetic-private-cleanup-detail');
        return { session_id: id, deleted: true };
      },
    );
    t.mock.method(client.connectedAccounts, 'delete', async () => {
      assert.fail('Consent must not remove an existing account.');
    });
    t.mock.method(transport, 'execute', async (id: string, input: Record<string, unknown>) => {
      assert.equal(id, 'execution-session');
      assert.equal(input.account, 'existing-account');
      return { data: { labels: [] }, error: null, log_id: 'synthetic-log' };
    });
    const provider = createComposioProvider({
      client,
      authConfigs: { gmail: 'custom-gmail-auth' },
    });
    const integrations = await createIntegrations(pool, {
      ownerId: 'local-development',
      provider,
      baseUrl: 'http://localhost:4310',
      wake: async () => {},
    });
    integrations.registerRoutes(app);
    const account = await pool.query<{ id: string }>(
      `INSERT INTO app_connections(owner_id,slug,account_id,provider_id,account_active,account_checked_at)
       VALUES('local-development','gmail','existing-account','composio',true,now()) RETURNING id`,
    );
    await pool.query(
      `INSERT INTO integration_sessions(owner_id,session_id,provider_id,configuration_version)
       VALUES('local-development','execution-session','composio',3)`,
    );
    const connect = () => app.inject({ method: 'POST', url: '/api/apps/gmail/connect' });
    const response = await connect();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      url: 'https://connect.composio.dev/link/synthetic-consent',
    });
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].config.connected_accounts, {});
    assert.deepEqual(created[0].config.auth_configs, { gmail: 'custom-gmail-auth' });
    assert.deepEqual(created[0].config.multi_account, {
      enable: true,
      max_accounts_per_toolkit: 10,
      require_explicit_selection: true,
    });
    assert.deepEqual(deleted, ['consent-session-1']);
    assert.equal(links[0].id, 'consent-session-1');
    const callback = new URL(String(links[0].input.callback_url));
    assert.equal(callback.pathname, '/api/apps/callback');
    assert.match(callback.searchParams.get('state')!, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual((await pool.query('SELECT session_id FROM integration_sessions')).rows, [
      { session_id: 'execution-session' },
    ]);
    assert.deepEqual(
      (
        await pool.query(
          'SELECT account_id,revoked,pending_account_id FROM app_connections WHERE id=$1',
          [account.rows[0].id],
        )
      ).rows,
      [{ account_id: 'existing-account', revoked: false, pending_account_id: null }],
    );
    assert.equal(
      (await pool.query('SELECT pending_account_id FROM app_connections WHERE account_id IS NULL'))
        .rows[0].pending_account_id,
      'new-account-1',
    );
    await integrations.execute('local-development', 'GMAIL_LIST_LABELS', {
      connectionId: account.rows[0].id,
      user_id: 'me',
    });
    for (const kind of ['provider', 'url'] as const) {
      failure = kind;
      const rejected = await connect();
      assert.equal(rejected.statusCode, 502);
      assert.deepEqual(rejected.json(), {
        error: 'The connection provider could not complete this request.',
      });
      assert.equal((await pool.query('SELECT id FROM app_connections')).rowCount, 2);
    }
    assert.deepEqual(deleted, ['consent-session-1', 'consent-session-2', 'consent-session-3']);
    failure = undefined;
    cleanupFailure = true;
    const accepted = await connect();
    assert.equal(accepted.statusCode, 200);
    assert.equal((await pool.query('SELECT id FROM app_connections')).rowCount, 3);
    assert.equal(deleted.at(-1), 'consent-session-4');
  },
);
