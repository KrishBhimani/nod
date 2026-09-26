import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

const { hostedEnvironment, readHostedEnvironment } = await import(
  new URL('../scripts/start-hosted.mjs', import.meta.url).href
);
const { webhookRoute, createWebhookRelay } = await import(
  new URL('../scripts/webhook-relay.mjs', import.meta.url).href
);
const values = () => ({
  DATABASE_URL: 'postgresql://fixture:synthetic@localhost:54331/hosted',
  SIDEKICK_MASTER_KEY: randomBytes(32).toString('base64'),
  BETTER_AUTH_SECRET: 'synthetic-auth-secret-with-32-characters',
  GOOGLE_CLIENT_ID: 'synthetic-client',
  GOOGLE_CLIENT_SECRET: 'synthetic-google-secret',
  E2B_API_KEY: 'synthetic-e2b-key',
  E2B_BROWSER_TEMPLATE: 'fixture-browser',
  E2B_WORKSPACE_TEMPLATE: 'fixture-workspace',
});

test('hosted development isolates process, dotenv, data and server configuration', () => {
  const environment = hostedEnvironment(values(), {
    root: '/fixture',
    envFile: '/fixture/chosen.env',
    inherited: {
      PATH: '/bin',
      DATABASE_URL: 'private-normal-app',
      OPENAI_API_KEY: 'private-old-provider',
      SIDEKICK_MODE: 'local',
      NODE_OPTIONS: '--private',
    },
  });
  assert.equal(environment.SIDEKICK_MODE, 'gateway');
  assert.equal(environment.SIDEKICK_PUBLIC_URL, 'http://localhost:4330');
  assert.equal(environment.SIDEKICK_BIND_HOST, '127.0.0.1');
  assert.equal(environment.PORT, '4330');
  assert.equal(environment.SIDEKICK_DATA_ROOT, '/fixture/.local/hosted');
  assert.equal(environment.DOTENV_CONFIG_PATH, '/fixture/chosen.env');
  assert.equal(environment.PATH, '/bin');
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.OBJECT_STORAGE_PROVIDER, 'postgres');
  assert.equal(environment.COMPUTER_PROVIDER, 'e2b');
});

test('hosted launcher refuses production, shared local database and invalid configuration without printing values', () => {
  assert.throws(
    () => hostedEnvironment({ GOOGLE_CLIENT_SECRET: 'synthetic-private-value' }),
    (error) => {
      assert.match((error as Error).message, /Missing configuration: DATABASE_URL/);
      assert.doesNotMatch((error as Error).message, /synthetic-private-value/);
      return true;
    },
  );
  for (const [key, value] of [
    ['SIDEKICK_ENVIRONMENT', 'production'],
    ['SIDEKICK_ENVIRONMENT', 'PRODUCTION'],
    ['DATABASE_URL', 'postgresql://fixture:synthetic-private-password@127.0.0.1:54329/old'],
    ['SIDEKICK_MASTER_KEY', 'synthetic-private-invalid-key'],
    ['BETTER_AUTH_SECRET', 'short-private-key'],
    ['PORT', '4320'],
    ['SIDEKICK_PUBLIC_URL', 'https://private.example.test'],
    ['SIDEKICK_RUNTIME_URL', 'http://sidekick.runtime'],
    ['COMPUTER_PROVIDER', 'docker'],
    ['SIDEKICK_WEBHOOK_ORIGIN', 'https://private.example.test/path?secret=private'],
    ['SIDEKICK_MAX_USERS', '401'],
  ])
    assert.throws(() => hostedEnvironment({ ...values(), [key]: value }), {
      message: `Invalid configuration: ${key}.`,
    });
});

test('hosted environment files warn only for actual insecure permissions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-hosted-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'private.env');
  await writeFile(
    file,
    Object.entries(values())
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    { mode: 0o600 },
  );
  const warnings: string[] = [];
  await readHostedEnvironment(file, { warn: (message: string) => warnings.push(message) });
  assert.equal(warnings.length, 0);
  if (process.platform !== 'win32') {
    await chmod(file, 0o644);
    await readHostedEnvironment(file, { warn: (message: string) => warnings.push(message) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /permissions to 600/);
    assert.doesNotMatch(warnings[0], /synthetic/);
  }
});

test('webhook relay allowlist excludes application, authentication, encoded and normalized paths', () => {
  const token = 'a'.repeat(43);
  for (const path of [
    '/api/session',
    '/api/login',
    '/api/internal/channels/claim',
    '/api/state',
    '/',
    '/api/%77ebhooks/composio',
    '/api/webhooks/composio/../composio',
    '//api/webhooks/composio',
    '/api/webhooks/composio#private',
    '/api/webhooks/telegram/not-a-token',
  ])
    assert.equal(webhookRoute('POST', path), false, path);
  assert.equal(webhookRoute('POST', '/api/webhooks/composio'), true);
  assert.equal(webhookRoute('GET', '/api/webhooks/composio'), false);
  assert.equal(webhookRoute('POST', `/api/webhooks/telegram/${token}`), true);
  assert.equal(webhookRoute('GET', `/api/webhooks/telegram/${token}`), false);
  assert.equal(webhookRoute('GET', `/api/webhooks/whatsapp/${token}?hub.challenge=123`), true);
  for (const target of [
    'https://public.example.test',
    'http://localhost:4320',
    'http://localhost:4318',
    'http://localhost:4330/private',
    'http://user:secret@localhost:4330',
  ])
    assert.throws(() => createWebhookRelay({ target }));
});

test('webhook relay forwards raw bodies and only signature headers without following redirects or setting cookies', async (t) => {
  const calls: Request[] = [];
  const server = createWebhookRelay({
    fetch: async (url: URL, init: RequestInit) => {
      assert.equal(init.redirect, 'manual');
      calls.push(new Request(url, init));
      return new Response('fixture response', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'set-cookie': 'private=fixture',
          location: 'https://private.example.test',
          'cache-control': 'public',
        },
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bytes = Buffer.from(' { "synthetic" : "évent" } ');
  const response = await fetch(`${origin}/api/webhooks/composio`, {
    method: 'POST',
    body: bytes,
    headers: {
      'content-type': 'application/json',
      'webhook-signature': 'fixture-signature',
      cookie: 'private-cookie',
      authorization: 'Bearer private',
      'x-sidekick-owner': 'forged',
      origin: 'https://foreign.example.test',
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'fixture response');
  assert.equal(calls[0].url, 'http://localhost:4330/api/webhooks/composio');
  assert.deepEqual(Buffer.from(await calls[0].arrayBuffer()), bytes);
  assert.equal(calls[0].headers.get('webhook-signature'), 'fixture-signature');
  for (const key of ['cookie', 'authorization', 'x-sidekick-owner', 'origin'])
    assert.equal(calls[0].headers.get(key), null);
  assert.equal((await fetch(`${origin}/api/session`)).status, 404);
  assert.equal(
    (await fetch(`${origin}/api/webhooks/composio`, { method: 'POST', body: 'x'.repeat(262_145) }))
      .status,
    413,
  );
  assert.equal(calls.length, 1);
});
