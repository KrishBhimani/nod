import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Composio } from '@composio/core';
import Fastify from 'fastify';
import pg from 'pg';
import { createIntegrations, eventOverview } from '../src/server/integrations.ts';

test('notification summaries exclude message bodies, tokens, and unbounded provider payloads', () => {
  const summary = eventOverview('gmail', 'GMAIL_NEW_GMAIL_MESSAGE', {
    subject: `Login code 123456 ${'x'.repeat(3000)}`, sender: 'person@example.com',
    message_text: 'private body', access_token: 'provider-secret', payload: { password: 'another-secret' },
  });
  assert.match(summary, /untrusted event data/);
  assert.match(summary, /person@example.com/);
  for (const excluded of ['123456', 'private body', 'provider-secret', 'another-secret']) assert.equal(summary.includes(excluded), false);
  assert.ok(summary.length < 1000);
});

test('Composio fixture verifies signed events, rejects cross-account events, deduplicates, and gates writes', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const schema = `test_composio_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const client = new Composio({ apiKey: 'fixture-key-not-live', allowTracking: false, fileUploadDirs: false });
  const app = Fastify();
  let executed = 0;
  const delivered: string[] = [];
  t.mock.method(client.sessions, 'create', async () => ({
    sessionId: 'fixture-session',
    execute: async () => { executed++; return { successful: true, data: { messages: [] } }; },
    search: async () => ({ toolSchemas: { GMAIL_SEND_EMAIL: { inputSchema: { type: 'object' } } }, results: [{ useCase: 'Send email', primaryToolSlugs: ['GMAIL_SEND_EMAIL'] }], session: { id: 'do-not-expose' } }),
  }));
  const integrations = await createIntegrations(pool, {
    client, webhookSecret: 'fixture-signing-secret',
    wake: async (prompt, id) => { delivered.push(id); assert.equal(prompt.includes('provider-secret'), false); },
  });
  integrations.registerRoutes(app);
  const event = {
    id: 'event-fixture-1', type: 'composio.trigger.message', timestamp: new Date().toISOString(),
    metadata: { log_id: 'log-fixture', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', trigger_id: 'ti-fixture', connected_account_id: 'ca-fixture', auth_config_id: 'ac-fixture', user_id: 'local-development' },
    data: { subject: 'Meeting request', sender: 'person@example.com', access_token: 'provider-secret' },
  };
  function signed(body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
    const id = 'delivery-fixture';
    const signature = createHmac('sha256', 'fixture-signing-secret').update(`${id}.${timestamp}.${body}`).digest('base64');
    return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
  }
  async function send(value: unknown, headerOverride?: Record<string, string>) {
    const payload = JSON.stringify(value);
    return app.inject({ method: 'POST', url: '/api/webhooks/composio', payload, headers: headerOverride ?? signed(payload) });
  }
  try {
    await pool.query("INSERT INTO app_connections (owner_id,slug,account_id,trigger_id,triggers_enabled) VALUES ('local-development','gmail','ca-fixture','ti-fixture',true)");
    const invalid = await send(event, { ...signed(JSON.stringify(event)), 'webhook-signature': 'v1,invalid' });
    assert.equal(invalid.statusCode, 401);
    assert.equal((await send(event, signed(JSON.stringify(event), String(Math.floor(Date.now() / 1000) - 600)))).statusCode, 401);
    assert.equal((await send({ ...event, metadata: { ...event.metadata, user_id: 'another-user' } })).statusCode, 202);
    assert.equal((await send({ ...event, metadata: { ...event.metadata, connected_account_id: 'another-account' } })).statusCode, 202);
    assert.equal((await pool.query('SELECT * FROM composio_events')).rowCount, 0);
    assert.equal((await send(event)).statusCode, 202);
    assert.equal((await send(event)).statusCode, 202);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await pool.query("SELECT * FROM composio_events WHERE state = 'delivered'")).rowCount === 1) break;
      await delay(10);
    }
    assert.deepEqual(delivered, ['composio:event-fixture-1']);
    assert.equal((await pool.query('SELECT * FROM composio_events')).rowCount, 1);
    const result = await integrations.execute('local-development', 'GMAIL_SEND_EMAIL', { recipient_email: 'test@example.com', subject: 'Fixture' });
    assert.deepEqual(result, { requiresApproval: true, action: 'GMAIL_SEND_EMAIL', args: { recipient_email: 'test@example.com', subject: 'Fixture' } });
    assert.equal(executed, 0);
    await integrations.execute('local-development', 'GMAIL_FETCH_EMAILS', { max_results: 5 });
    assert.equal(executed, 1);
    await integrations.executeApproved('local-development', 'GMAIL_SEND_EMAIL', { recipient_email: 'fixture@example.com' });
    assert.equal(executed, 2);
    await assert.rejects(integrations.execute('another-user', 'GMAIL_FETCH_EMAILS', {}));
    await assert.rejects(integrations.executeApproved('local-development', 'COMPOSIO_MULTI_EXECUTE_TOOL', {}));
    await assert.rejects(integrations.executeApproved('local-development', 'GITHUB_CREATE_ISSUE', {}));
    const search = await integrations.execute('local-development', 'SEARCH_TOOLS', { query: 'Send an email' });
    assert.equal(JSON.stringify(search).includes('do-not-expose'), false);
    await pool.query("INSERT INTO composio_events (id,owner_id,summary,slug,account_id,trigger_id) VALUES ('event-queued-before-disconnect','local-development','Obsolete event','gmail','ca-fixture','ti-fixture')");
    await pool.query("UPDATE app_connections SET revoked = true, triggers_enabled = false WHERE slug = 'gmail'");
    await integrations.drain();
    assert.equal((await pool.query("SELECT state FROM composio_events WHERE id = 'event-queued-before-disconnect'")).rows[0].state, 'discarded');
    assert.equal(delivered.length, 1);
    await assert.rejects(integrations.executeApproved('local-development', 'GMAIL_SEND_EMAIL', {}));
    assert.equal((await send({ ...event, id: 'event-after-disconnect' })).statusCode, 202);
    assert.equal((await pool.query('SELECT * FROM composio_events')).rowCount, 2);
  } finally {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('Composio callback requires its saved attempt and a provider-verified active account', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const schema = `test_composio_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const client = new Composio({ apiKey: 'fixture-key-not-live', allowTracking: false });
  let callback = '';
  let providerStatus = 'INITIATED';
  t.mock.method(client.sessions, 'create', async () => ({ sessionId: 'fixture-session', authorize: async (_slug: string, options: { callbackUrl: string }) => {
    callback = options.callbackUrl;
    return { id: 'ca-fixture', redirectUrl: 'https://connect.composio.dev/link/fixture' };
  } }));
  t.mock.method(client.sessions, 'delete', async () => ({}));
  t.mock.method(client.connectedAccounts, 'get', async () => ({ status: providerStatus, isDisabled: false, toolkit: { slug: 'gmail' } }));
  const app = Fastify();
  const integrations = await createIntegrations(pool, { client, wake: async () => {} });
  integrations.registerRoutes(app);
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/connections/gmail/connect' })).statusCode, 200);
    const url = new URL(callback);
    url.searchParams.set('status', 'success');
    url.searchParams.set('connected_account_id', 'ca-other-user');
    assert.equal((await app.inject({ url: `${url.pathname}${url.search}` })).statusCode, 409);
    url.searchParams.set('connected_account_id', 'ca-fixture');
    assert.equal((await app.inject({ url: `${url.pathname}${url.search}` })).statusCode, 409);
    providerStatus = 'ACTIVE';
    assert.equal((await app.inject({ url: `${url.pathname}${url.search}` })).statusCode, 302);
    assert.equal((await app.inject({ url: `${url.pathname}${url.search}` })).statusCode, 409);
    const connection = (await integrations.list()).find(item => item.slug === 'gmail');
    assert.equal(connection?.status, 'connected');
    assert.equal(connection?.triggersEnabled, false);
  } finally {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
