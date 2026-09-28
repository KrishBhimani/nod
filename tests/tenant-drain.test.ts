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

function fixture(computer?: { pause(): Promise<void>; resume(): Promise<void> }) {
  const app = Fastify();
  const identity = {
    secret: randomBytes(32).toString('base64url'),
    ownerId: randomUUID(),
    environment: 'development',
    generation: '7',
  };
  const admission = createWorkAdmission();
  const consumers = createWorkConsumers();
  const drain = createTenantDrain({ admission, consumers, computer });
  registerRuntimeAccess(app, identity);
  registerTenantDrain(app, { admission, drain, generation: identity.generation });
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 503;
    reply.code(status).send({ error: 'The request could not be completed.' });
  });
  app.post('/api/runtime/lease', async () => ({ ok: true }));
  const headers = (path: string, body: string, kind: RuntimeClaims['kind'] = 'user') => ({
    'content-type': 'application/json',
    'x-otto-runtime': signRuntimeRequest({
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

test(
  'a signed partial-body disconnect before the handler releases admission for deployment',
  { timeout: 5000 },
  async () => {
    const f = fixture();
    const received = gate();
    const disconnected = gate();
    let handled = 0;
    f.app.addHook('onRequest', async (request, reply) => {
      if (request.url !== '/api/work') return;
      request.raw.once('data', received.resolve);
      reply.raw.once('close', disconnected.resolve);
    });
    f.app.post('/api/work', async () => {
      handled++;
      return { ok: true };
    });
    const body = JSON.stringify({ value: 'synthetic partial request' });
    let request: ReturnType<typeof httpRequest> | undefined;
    try {
      const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
      request = httpRequest(address + '/api/work', {
        method: 'POST',
        headers: { ...f.headers('/api/work', body), 'content-length': Buffer.byteLength(body) },
      });
      request.on('error', () => {});
      request.write(body.slice(0, 8));
      await received.promise;
      assert.equal(f.admission.pending, 1);
      assert.equal(handled, 0);
      request.destroy();
      await disconnected.promise;
      const input = {
        nonce: randomUUID(),
        targetRelease: 'e'.repeat(40),
        deadline: Date.now() + 500,
      };
      const receipt = await f.request('/api/runtime/drain', input, 'deployment');
      assert.equal(receipt.statusCode, 200, receipt.body);
      assert.equal(receipt.json().drained, true);
      assert.equal(f.admission.pending, 0);
      assert.equal(handled, 0);
    } finally {
      request?.destroy();
      await f.app.close();
    }
  },
);

test(
  'a disconnected request cannot start its handler after a delayed pre-handler resumes',
  { timeout: 5000 },
  async () => {
    const f = fixture();
    const started = gate();
    const finish = gate();
    const completed = gate();
    const disconnected = gate();
    let handled = 0;
    f.app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/api/work') reply.raw.once('close', disconnected.resolve);
    });
    f.app.addHook('preHandler', async (request) => {
      if (request.url !== '/api/work') return;
      started.resolve();
      await finish.promise;
      completed.resolve();
    });
    f.app.post('/api/work', async () => {
      handled++;
      return { ok: true };
    });
    let request: ReturnType<typeof httpRequest> | undefined;
    try {
      const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
      request = httpRequest(address + '/api/work', {
        method: 'POST',
        headers: f.headers('/api/work', '{}'),
      });
      request.on('error', () => {});
      request.end('{}');
      await started.promise;
      assert.equal(f.admission.pending, 1);
      request.destroy();
      await disconnected.promise;
      const input = {
        nonce: randomUUID(),
        targetRelease: 'f'.repeat(40),
        deadline: Date.now() + 500,
      };
      assert.equal((await f.request('/api/runtime/drain', input, 'deployment')).statusCode, 200);
      assert.equal(f.admission.pending, 0);
      finish.resolve();
      await completed.promise;
      await delay(0);
      assert.equal(handled, 0);
      assert.equal(f.admission.pending, 0);
    } finally {
      finish.resolve();
      request?.destroy();
      await f.app.close();
    }
  },
);

test('computer pause follows natural work drain and its acknowledgement precedes the signed receipt', async () => {
  const entered = gate();
  const finish = gate();
  const order: string[] = [];
  const f = fixture({
    async pause() {
      order.push('pause');
      entered.resolve();
      await finish.promise;
    },
    async resume() {
      order.push('resume');
      assert.equal(f.admission.paused, true);
    },
  });
  let workerId = 0;
  await f.consumers.register({
    start: async () => {
      order.push('consumer-start');
      return `worker-${++workerId}`;
    },
    stop: async () => {
      order.push('consumer-stop');
    },
  });
  const release = f.admission.enter()!;
  const input = { nonce: randomUUID(), targetRelease: 'c'.repeat(40), deadline: Date.now() + 2000 };
  const preparing = f.request('/api/runtime/drain', input, 'deployment');
  let replied = false;
  void preparing.then(() => {
    replied = true;
  });
  try {
    await delay(5);
    assert.equal(order.includes('pause'), false);
    release();
    await entered.promise;
    assert.equal(replied, false);
    finish.resolve();
    const response = await preparing;
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().computerPaused, true);
    assert.equal(f.drain.computerPaused?.(), true);
    assert.equal((await f.request('/api/runtime/resume', input, 'deployment')).statusCode, 200);
    assert.equal(f.drain.computerPaused?.(), false);
    assert.deepEqual(order, [
      'consumer-start',
      'consumer-stop',
      'pause',
      'resume',
      'consumer-start',
    ]);
  } finally {
    release();
    finish.resolve();
    await f.app.close();
  }
});

test('abort cannot reopen admission while a timed-out computer pause is still pending', async () => {
  const entered = gate();
  const finish = gate();
  let resumes = 0;
  const f = fixture({
    async pause() {
      entered.resolve();
      await finish.promise;
    },
    async resume() {
      resumes++;
    },
  });
  const input = { nonce: randomUUID(), targetRelease: 'd'.repeat(40), deadline: Date.now() + 1000 };
  const preparing = f.request('/api/runtime/drain', input, 'deployment');
  void preparing.then(() => {});
  try {
    await entered.promise;
    assert.equal((await preparing).statusCode, 503);
    const resuming = f.request('/api/runtime/resume', input, 'deployment');
    let resumed = false;
    void resuming.then(() => {
      resumed = true;
    });
    await delay(5);
    assert.equal(resumed, false);
    assert.equal(resumes, 0);
    assert.equal(f.admission.paused, true);
    finish.resolve();
    assert.equal((await resuming).statusCode, 200);
    assert.equal(resumes, 1);
    assert.equal(f.admission.paused, false);
    assert.equal(f.drain.computerPaused?.(), false);
  } finally {
    finish.resolve();
    await f.app.close();
  }
});

test('uncertain computer pause and resume cannot emit a clean receipt or restart consumers', async () => {
  let starts = 0;
  const f = fixture({
    async pause() {
      throw new Error('Private pause uncertainty');
    },
    async resume() {
      throw new Error('Private retained fence');
    },
  });
  await f.consumers.register({ start: async () => `worker-${++starts}`, stop: async () => {} });
  const input = { nonce: randomUUID(), targetRelease: 'e'.repeat(40), deadline: Date.now() + 1000 };
  try {
    const response = await f.request('/api/runtime/drain', input, 'deployment');
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().computerPaused, undefined);
    assert.equal((await f.request('/api/runtime/resume', input, 'deployment')).statusCode, 503);
    assert.equal(f.admission.paused, true);
    assert.equal(starts, 1);
  } finally {
    await f.app.close();
  }
});

test('failed computer resume invalidates its previous pause receipt', async () => {
  const f = fixture({
    pause: async () => {},
    resume: async () => {
      throw new Error('Private resume uncertainty');
    },
  });
  const input = { nonce: randomUUID(), targetRelease: 'a'.repeat(40), deadline: Date.now() + 2000 };
  try {
    const prepared = await f.request('/api/runtime/drain', input, 'deployment');
    assert.equal(prepared.statusCode, 200);
    assert.equal(prepared.json().computerPaused, true);
    assert.equal((await f.request('/api/runtime/resume', input, 'deployment')).statusCode, 503);
    assert.equal(f.drain.computerPaused?.(), false);
    assert.equal(f.admission.paused, true);
    const repeated = await f.request('/api/runtime/drain', input, 'deployment');
    assert.equal(repeated.statusCode, 503);
    assert.equal(repeated.json().computerPaused, undefined);
  } finally {
    await f.app.close();
  }
});
