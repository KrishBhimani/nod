import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { channelWebhookToken, createHostedWebhooks } from '../src/server/hosted-webhooks.ts';
import type { IntegrationProvider } from '../src/ports/integrations.ts';
import type { TenantRuntimeHost } from '../src/ports/tenant-runtime.ts';

function fixture() {
  const masterKey = randomBytes(32);
  const environment = 'development';
  const owners = [randomUUID(), randomUUID()];
  const calls: {
    ownerId: string;
    request: Request;
    access: Parameters<TenantRuntimeHost['fetch']>[2];
  }[] = [];
  const verified: { body: unknown; headers: Record<string, string | string[] | undefined> }[] = [];
  let eventOwner: string = owners[0];
  const integrations: Pick<IntegrationProvider, 'verifyWebhook' | 'webhooksConfigured'> = {
    webhooksConfigured: true,
    async verifyWebhook(body, headers) {
      verified.push({ body, headers });
      if (headers['webhook-signature'] !== 'synthetic-valid-signature')
        throw new Error('Synthetic private provider detail');
      return {
        id: 'fixture-event',
        ownerId: eventOwner,
        service: 'gmail',
        accountId: 'fixture-account',
        subscriptionId: 'fixture-subscription',
        trigger: 'fixture-trigger',
        data: {},
      };
    },
  };
  const handle = createHostedWebhooks({
    masterKey,
    environment,
    integrations,
    listOwners: async () => owners,
    hasOwner: async (owner) => owners.includes(owner as (typeof owners)[number]),
    runtimes: {
      async fetch(ownerId, request, access) {
        calls.push({ ownerId, request, access });
        return Response.json({ ok: true });
      },
      async close() {},
    },
  });
  const path = (
    ownerId = owners[0],
    provider: 'telegram' | 'whatsapp' = 'telegram',
    env = environment,
  ) => `/api/webhooks/${provider}/${channelWebhookToken(masterKey, env, ownerId, provider)}`;
  const request = (path: string, body = '{"synthetic":"event"}', headers: HeadersInit = {}) =>
    new Request(`https://sidekick.example.test${path}`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
    });
  return {
    handle,
    integrations,
    owners,
    calls,
    verified,
    request,
    path,
    eventOwner: (owner: string) => {
      eventOwner = owner;
    },
  };
}

test('hosted integration routing accepts only the verified owner and preserves raw signed bytes', async () => {
  const f = fixture();
  const body = ' { "ownerId" : "untrusted", "data": [1, 2] } ';
  const response = await f.handle(
    f.request(`/api/webhooks/composio?ownerId=${f.owners[1]}`, body, {
      'webhook-signature': 'synthetic-valid-signature',
      'webhook-id': 'fixture-id',
      'webhook-timestamp': '123456',
      'x-sidekick-owner': f.owners[1],
      'x-sidekick-runtime': 'forged',
      cookie: 'private-cookie',
      authorization: 'Bearer private',
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(f.calls[0].ownerId, f.owners[0]);
  assert.deepEqual(f.calls[0].access, { developer: false, kind: 'webhook' });
  assert.equal(f.verified[0].body, body);
  assert.equal(await f.calls[0].request.text(), body);
  for (const header of ['cookie', 'authorization', 'x-sidekick-owner', 'x-sidekick-runtime']) {
    assert.equal(f.verified[0].headers[header], undefined);
    assert.equal(f.calls[0].request.headers.get(header), null);
  }
  assert.equal(f.calls[0].request.headers.get('webhook-signature'), 'synthetic-valid-signature');
});

test('hosted webhook failures and unknown owners never start a runtime', async () => {
  const f = fixture();
  const invalid = await f.handle(f.request('/api/webhooks/composio'));
  assert.equal(invalid.status, 401);
  assert.deepEqual(await invalid.json(), { error: 'Invalid webhook signature or payload.' });
  f.integrations.webhooksConfigured = false;
  assert.equal((await f.handle(f.request('/api/webhooks/composio'))).status, 503);
  f.integrations.webhooksConfigured = true;
  f.eventOwner(randomUUID());
  assert.equal(
    (
      await f.handle(
        f.request('/api/webhooks/composio', '{}', {
          'webhook-signature': 'synthetic-valid-signature',
        }),
      )
    ).status,
    202,
  );
  f.eventOwner('untrusted-owner');
  assert.equal(
    (
      await f.handle(
        f.request('/api/webhooks/composio', '{}', {
          'webhook-signature': 'synthetic-valid-signature',
        }),
      )
    ).status,
    401,
  );
  const verifications = f.verified.length;
  assert.equal(
    (await f.handle(f.request('/api/webhooks/composio', 'x'.repeat(262_145)))).status,
    413,
  );
  assert.equal(f.verified.length, verifications);
  assert.equal(f.calls.length, 0);
});

test('channel webhook capabilities bind provider, deployment and owner before actor dispatch', async () => {
  const f = fixture();
  for (const owner of f.owners) {
    const body = JSON.stringify({ accountId: 'untrusted', ownerId: f.owners[0] });
    assert.equal(
      (
        await f.handle(
          f.request(`${f.path(owner)}?ownerId=${f.owners[1]}`, body, {
            'x-telegram-bot-api-secret-token': 'synthetic-telegram-secret',
          }),
        )
      ).status,
      200,
    );
    const call = f.calls.at(-1)!;
    assert.equal(call.ownerId, owner);
    assert.equal(new URL(call.request.url).pathname, '/api/webhooks/telegram');
    assert.equal(
      call.request.headers.get('x-telegram-bot-api-secret-token'),
      'synthetic-telegram-secret',
    );
    assert.equal(await call.request.text(), body);
  }
  for (const path of [
    f.path(f.owners[0], 'telegram', 'production'),
    f.path().replace('/telegram/', '/whatsapp/'),
    f.path(randomUUID()),
  ])
    assert.equal((await f.handle(f.request(path))).status, 202);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.handle(f.request('/api/webhooks/telegram/not-a-token'))).status, 404);
  assert.equal(
    (await f.handle(new Request(`https://sidekick.example.test${f.path()}`))).status,
    404,
  );
});

test('WhatsApp verification keeps its exact query and read-only method within the owned actor', async () => {
  const f = fixture();
  const query = '?hub.mode=subscribe&hub.verify_token=synthetic%2Ftoken&hub.challenge=12345';
  const response = await f.handle(
    new Request(`https://sidekick.example.test${f.path(f.owners[1], 'whatsapp')}${query}`),
  );
  assert.equal(response.status, 200);
  assert.equal(f.calls[0].ownerId, f.owners[1]);
  assert.equal(f.calls[0].request.method, 'GET');
  assert.equal(new URL(f.calls[0].request.url).search, query);
  assert.equal(new URL(f.calls[0].request.url).pathname, '/api/webhooks/whatsapp');
  assert.deepEqual(f.calls[0].access, { developer: false, kind: 'webhook' });
});
