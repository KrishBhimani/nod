import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Fastify from 'fastify';
import {
  registerRuntimeAccess,
  signRuntimeRequest,
  type RuntimeClaims,
} from '../src/server/runtime-auth.ts';
import { createTenantDrain, registerTenantDrain } from '../src/server/tenant-drain.ts';
import { createWorkAdmission, createWorkConsumers } from '../src/server/work-admission.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const app = Fastify();
  const identity = {
    secret: randomBytes(32).toString('base64url'),
    ownerId: randomUUID(),
    environment: 'development',
    generation: '7',
  };
  const admission = createWorkAdmission();
  const consumers = createWorkConsumers();
  const drain = createTenantDrain({ admission, consumers });
  registerRuntimeAccess(app, identity);
  registerTenantDrain(app, { admission, drain, generation: identity.generation });
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 503;
    reply.code(status).send({ error: 'The request could not be completed.' });
  });
  app.post('/api/runtime/lease', async () => ({ ok: true }));
  const headers = (path: string, body: string, kind: RuntimeClaims['kind'] = 'user') => ({
    'content-type': 'application/json',
    'x-sidekick-runtime': signRuntimeRequest({
      ...identity,
      method: 'POST',
      target: path,
      body: Buffer.from(body),
      developer: false,
      kind,
    }),
  });
  const request = (path: string, body: unknown = {}, kind: RuntimeClaims['kind'] = 'user') => {
    const payload = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: path,
      payload,
      headers: headers(path, payload, kind),
    });
  };
  return { app, identity, admission, consumers, drain, headers, request };
}

test('signed deployment drain waits for admitted HTTP work, blocks new work and preserves lease renewal', async () => {
  const f = fixture();
  const started = gate();
  const finish = gate();
  let effects = 0;
  f.app.post('/api/work', async () => {
    effects++;
    started.resolve();
    await finish.promise;
    return { ok: true };
  });
  const input = { nonce: randomUUID(), targetRelease: 'b'.repeat(40), deadline: Date.now() + 1000 };
  try {
    const working = f.request('/api/work');
    await started.promise;
    const preparing = f.request('/api/runtime/drain', input, 'deployment');
    let received = false;
    void preparing.then(() => {
      received = true;
    });
    await delay(10);
    assert.equal(received, false);
    assert.equal(f.admission.pending, 1);
    assert.equal((await f.request('/api/work')).statusCode, 503);
    assert.equal(effects, 1);
    assert.equal((await f.request('/api/runtime/lease', {}, 'wake')).statusCode, 200);
    assert.equal((await f.request('/api/runtime/resume', input, 'user')).statusCode, 403);
    finish.resolve();
    assert.equal((await working).statusCode, 200);
    const receipt = await preparing;
    assert.equal(receipt.statusCode, 200, receipt.body);
    assert.deepEqual(receipt.json(), {
      ok: true,
      nonce: input.nonce,
      targetRelease: input.targetRelease,
      generation: '7',
      drained: true,
    });
    assert.equal(f.admission.pending, 0);
    assert.equal(
      (await f.request('/api/runtime/resume', { ...input, nonce: randomUUID() }, 'deployment'))
        .statusCode,
      409,
    );
    assert.equal((await f.request('/api/runtime/resume', input, 'deployment')).statusCode, 200);
    assert.equal((await f.request('/api/work')).statusCode, 200);
    assert.equal(effects, 2);
  } finally {
    finish.resolve();
    await f.app.close();
  }
});

test('an early HTTP response does not release an accepted handler still performing work', async () => {
  const f = fixture();
  const finish = gate();
  const completed = gate();
  f.app.post('/api/work', async (_request, reply) => {
    reply.send({ ok: true });
    await finish.promise;
    completed.resolve();
  });
  try {
    assert.equal((await f.request('/api/work')).statusCode, 200);
    assert.equal(f.admission.pending, 1);
    const input = { nonce: randomUUID(), targetRelease: 'c'.repeat(40), deadline: Date.now() + 20 };
    assert.equal((await f.request('/api/runtime/drain', input, 'deployment')).statusCode, 503);
    assert.equal(f.admission.pending, 1);
    finish.resolve();
    await completed.promise;
    await delay(0);
    assert.equal(f.admission.pending, 0);
    assert.equal(f.drain.active(), true);
    assert.equal((await f.request('/api/runtime/resume', input, 'deployment')).statusCode, 200);
  } finally {
    finish.resolve();
    await f.app.close();
  }
});

test('a disconnected HTTP client cannot release work until its handler actually settles', async () => {
  const f = fixture();
  const started = gate();
  const finish = gate();
  const completed = gate();
  f.app.post('/api/work', async () => {
    started.resolve();
    await finish.promise;
    completed.resolve();
    return { ok: true };
  });
  try {
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const request = httpRequest(address + '/api/work', {
      method: 'POST',
      headers: f.headers('/api/work', '{}'),
    });
    request.on('error', () => {});
    request.end('{}');
    await started.promise;
    request.destroy();
    await delay(5);
    assert.equal(f.admission.pending, 1);
    const input = { nonce: randomUUID(), targetRelease: 'd'.repeat(40), deadline: Date.now() + 20 };
    await assert.rejects(f.drain.prepare(input));
    assert.equal(f.admission.pending, 1);
    finish.resolve();
    await completed.promise;
    await delay(5);
    assert.equal(f.admission.pending, 0);
    await f.drain.resume(input);
  } finally {
    finish.resolve();
    await f.app.close();
  }
});
