import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import {
  createRuntimeVerifier,
  deriveRuntimeSecret,
  registerRuntimeAccess,
  signRuntimeRequest,
} from '../src/server/runtime-auth.ts';

const ownerId = randomUUID();
const master = randomBytes(32);
const secret = deriveRuntimeSecret(master, 'development', ownerId);
const context = { secret, ownerId, environment: 'development', generation: '1' };
const signed = (overrides: Partial<Parameters<typeof signRuntimeRequest>[0]> = {}) =>
  signRuntimeRequest({
    ...context,
    method: 'GET',
    target: '/api/state',
    body: new Uint8Array(),
    developer: false,
    ...overrides,
  });

test('runtime signatures bind owner, deployment, generation, method and full target', () => {
  const token = signed();
  for (const changed of [
    { ownerId: randomUUID() },
    { environment: 'production' },
    { generation: '2' },
    { secret: deriveRuntimeSecret(master, 'development', randomUUID()) },
  ])
    assert.equal(
      createRuntimeVerifier({ ...context, ...changed }).verify(token, 'GET', '/api/state'),
      null,
    );
  assert.equal(createRuntimeVerifier(context).verify(token, 'POST', '/api/state'), null);
  assert.equal(createRuntimeVerifier(context).verify(token, 'GET', '/api/state?owner=other'), null);
  assert.equal(createRuntimeVerifier(context).verify(token, 'GET', '/api/state')?.ownerId, ownerId);
});

test('runtime authentication rejects replay, expiration, malformed and future envelopes', () => {
  const now = Date.now();
  const verifier = createRuntimeVerifier({ ...context, now: () => now });
  const token = signed({ now });
  assert.ok(verifier.verify(token, 'GET', '/api/state'));
  assert.equal(verifier.verify(token, 'GET', '/api/state'), null);
  assert.equal(verifier.verify(signed({ now: now - 30_001 }), 'GET', '/api/state'), null);
  assert.ok(verifier.verify(signed({ now: now + 4999 }), 'GET', '/api/state'));
  assert.equal(verifier.verify(signed({ now: now + 5001 }), 'GET', '/api/state'), null);
  for (const invalid of ['', 'a.b', 'a.b.c', token.replace(/.$/, '!'), ['a'], undefined])
    assert.equal(verifier.verify(invalid, 'GET', '/api/state'), null);
});

test('private processor rejects spoofed identity, changed bodies and ordinary computer access', async () => {
  const app = Fastify();
  registerRuntimeAccess(app, context);
  let calls = 0;
  app.post('/api/messages', async (request) => {
    calls++;
    return request.body;
  });
  app.get('/api/browser/screen', async () => ({ image: 'private' }));
  try {
    const payload = JSON.stringify({ text: 'hello' });
    const token = signed({ method: 'POST', target: '/api/messages', body: Buffer.from(payload) });
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/messages',
          headers: { 'x-sidekick-owner': ownerId },
          payload: { text: 'hello' },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/messages',
          headers: { 'content-type': 'application/json', 'x-sidekick-runtime': token },
          payload: JSON.stringify({ text: 'changed' }),
        })
      ).statusCode,
      401,
    );
    assert.equal(calls, 0);
    const success = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: {
        'content-type': 'application/json',
        'x-sidekick-runtime': signed({
          method: 'POST',
          target: '/api/messages',
          body: Buffer.from(payload),
        }),
      },
      payload,
    });
    assert.equal(success.statusCode, 200);
    assert.equal(calls, 1);
    assert.equal(
      (
        await app.inject({
          url: '/api/browser/screen',
          headers: { 'x-sidekick-runtime': signed({ target: '/api/browser/screen' }) },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/browser/screen',
          headers: {
            'x-sidekick-runtime': signed({ target: '/api/browser/screen', developer: true }),
          },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});

test('webhook and wake envelopes cannot authorize ordinary API calls', async () => {
  const app = Fastify();
  registerRuntimeAccess(app, context);
  app.post('/api/webhooks/telegram', async () => ({ ok: true }));
  app.get('/api/state', async () => ({ ok: true }));
  try {
    for (const kind of ['webhook', 'wake'] as const)
      assert.equal(
        (
          await app.inject({
            url: '/api/state',
            headers: { 'x-sidekick-runtime': signed({ kind }) },
          })
        ).statusCode,
        403,
      );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/webhooks/telegram',
          headers: {
            'x-sidekick-runtime': signed({ method: 'POST', target: '/api/webhooks/telegram' }),
          },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});

test('runtime policy rejects encoded and normalized capability paths even with a valid signature', async () => {
  const app = Fastify();
  registerRuntimeAccess(app, context);
  let calls = 0;
  app.all('/api/*', async () => {
    calls++;
    return { ok: true };
  });
  try {
    for (const path of [
      '/api/%62rowser/screen',
      '/api/%69nspector/screen',
      '/api/%72untime/lease',
      '/api/%77ebhooks/telegram',
      '/api/state/../browser/screen',
      '/api//browser/screen',
      '/api/browser%2fscreen',
    ]) {
      const result = await app.inject({
        url: path,
        headers: { 'x-sidekick-runtime': signed({ target: path }) },
      });
      assert.ok([400, 401].includes(result.statusCode), `${path}: ${result.statusCode}`);
    }
    assert.equal(calls, 0);
    const safe = await app.inject({
      url: '/api/state?cursor=synthetic%2Fvalue',
      headers: { 'x-sidekick-runtime': signed({ target: '/api/state?cursor=synthetic%2Fvalue' }) },
    });
    assert.equal(safe.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('only wake signatures can call the exact POST wake and lease routes', async () => {
  const app = Fastify();
  registerRuntimeAccess(app, context);
  let calls = 0;
  app.all('/api/*', async () => {
    calls++;
    return { ok: true };
  });
  try {
    for (const path of ['/api/runtime/wake', '/api/runtime/lease']) {
      for (const kind of ['user', 'webhook'] as const) {
        const result = await app.inject({
          method: 'POST',
          url: path,
          headers: { 'x-sidekick-runtime': signed({ target: path, method: 'POST', kind }) },
        });
        assert.equal(result.statusCode, 403);
      }
      assert.equal(
        (
          await app.inject({
            url: path,
            headers: { 'x-sidekick-runtime': signed({ target: path, kind: 'wake' }) },
          })
        ).statusCode,
        403,
      );
    }
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/runtime/other',
          headers: {
            'x-sidekick-runtime': signed({
              target: '/api/runtime/other',
              method: 'POST',
              kind: 'wake',
            }),
          },
        })
      ).statusCode,
      403,
    );
    assert.equal(calls, 0);
    for (const path of ['/api/runtime/wake', '/api/runtime/lease']) {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: path,
            headers: {
              'x-sidekick-runtime': signed({ target: path, method: 'POST', kind: 'wake' }),
            },
          })
        ).statusCode,
        200,
      );
    }
    assert.equal(calls, 2);
  } finally {
    await app.close();
  }
});
