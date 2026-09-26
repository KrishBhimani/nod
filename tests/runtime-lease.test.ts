import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { createRuntimeLease } from '../src/server/runtime-lease.ts';

test('runtime lease tolerates bounded clock skew but fences expired work and cannot be resurrected', async (t) => {
  const now = Date.parse('2026-09-26T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  let fences = 0;
  const lease = createRuntimeLease({
    expiresAt: new Date(now + 64_000).toISOString(),
    fence: () => {
      fences++;
    },
  });
  const app = Fastify();
  lease.register(app);
  app.get('/api/fixture', async () => ({ ok: true }));
  t.after(async () => {
    lease.close();
    await app.close();
  });
  assert.equal((await app.inject('/api/fixture')).statusCode, 200);
  assert.throws(() =>
    createRuntimeLease({ expiresAt: new Date(now + 65_001).toISOString(), fence: () => {} }),
  );
  t.mock.timers.tick(30_000);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/runtime/lease',
        payload: { expiresAt: new Date(now + 90_000).toISOString() },
      })
    ).statusCode,
    200,
  );
  t.mock.timers.tick(59_999);
  assert.equal(fences, 0);
  t.mock.timers.tick(1);
  assert.equal(fences, 1);
  assert.equal((await app.inject('/api/fixture')).statusCode, 503);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/runtime/lease',
        payload: { expiresAt: new Date(now + 120_000).toISOString() },
      })
    ).statusCode,
    503,
  );
  t.mock.timers.tick(60_000);
  assert.equal(fences, 1);
});
