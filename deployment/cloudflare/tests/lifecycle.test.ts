import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTenantLifecycle } from '../src/lifecycle.ts';
import { bootstrap, boundedBody, type TenantIdentity } from '../src/protocol.ts';

function configuration(ownerId = randomUUID(), version = '1') {
  const suffix = createHash('sha256')
    .update(JSON.stringify(['sidekick-tenant-v1', 'development', ownerId]))
    .digest('hex')
    .slice(0, 32);
  return {
    ownerId,
    env: {
      SIDEKICK_OWNER_ID: ownerId,
      SIDEKICK_ENVIRONMENT: 'development',
      SIDEKICK_MODE: 'tenant',
      SIDEKICK_RUNTIME_GENERATION: version,
      SIDEKICK_RUNTIME_SECRET: 's'.repeat(43),
      SIDEKICK_RUNTIME_LEASE_EXPIRES: String(Date.now() + 90_000),
      DATABASE_URL: `postgresql://sk_user_${suffix}:synthetic@db.example.test/sidekick`,
      PGBOSS_SCHEMA: `sk_jobs_${suffix}`,
    },
  };
}

test('tenant bootstrap binds the SQL namespace, runtime identity and environment', async () => {
  const input = configuration();
  const result = await bootstrap(input, 'development');
  assert.equal(result.env.NODE_ENV, 'production');
  assert.equal(result.env.SIDEKICK_DATA_ROOT, '/data');
  assert.equal(result.env.HOST, '0.0.0.0');
  assert.ok(!JSON.stringify(result.identity).includes('synthetic'));
  await assert.rejects(bootstrap(input, 'production'));
  await assert.rejects(bootstrap({ ...input, ownerId: randomUUID() }, 'development'));
  for (const change of [
    { SIDEKICK_MODE: 'gateway' },
    { SIDEKICK_RUNTIME_SECRET: 'short' },
    { SIDEKICK_RUNTIME_GENERATION: '0' },
    { DATABASE_URL: 'postgresql://admin:synthetic@db.example.test/sidekick' },
    { PGBOSS_SCHEMA: 'public' },
    { SIDEKICK_OWNER_ID: randomUUID() },
  ])
    await assert.rejects(bootstrap({ ...input, env: { ...input.env, ...change } }, 'development'));
});

test('tenant startup and replacement require one fixed identity and a confirmed stopped generation', async () => {
  let saved: TenantIdentity | undefined;
  let state: 'stopped' | 'healthy' | 'stopping' = 'stopped';
  let starts = 0;
  let stops = 0;
  let finishStop = true;
  const lifecycle = createTenantLifecycle({
    environment: 'development',
    read: async () => saved,
    write: async (identity) => {
      saved = { ...identity };
    },
    status: async () => state,
    start: async () => {
      starts++;
      state = 'healthy';
    },
    stop: async () => {
      stops++;
      state = finishStop ? 'stopped' : 'stopping';
    },
  });
  const first = configuration();
  await assert.rejects(lifecycle.identity());
  assert.deepEqual(await lifecycle.start(first), { ok: true, generation: '1' });
  assert.equal((await lifecycle.identity()).ownerId, first.ownerId);
  await lifecycle.start(first);
  assert.equal(starts, 2);
  const second = { ...first, env: { ...first.env, SIDEKICK_RUNTIME_GENERATION: '2' } };
  await assert.rejects(lifecycle.start(second), { status: 409 });
  await assert.rejects(lifecycle.start(configuration()), { status: 409 });
  await assert.rejects(lifecycle.stop(first.ownerId, '2'), { status: 409 });
  await assert.rejects(lifecycle.stop(randomUUID(), '1'), { status: 409 });
  assert.equal(stops, 0);
  finishStop = false;
  await assert.rejects(lifecycle.stop(first.ownerId, '1'), { status: 503 });
  assert.equal(saved?.stopped, false);
  await assert.rejects(lifecycle.start(second), { status: 409 });
  finishStop = true;
  await lifecycle.stop(first.ownerId, '1');
  assert.equal(saved?.stopped, true);
  await assert.rejects(lifecycle.identity());
  await assert.rejects(lifecycle.start(first), { status: 409 });
  await lifecycle.start(second);
  assert.equal(saved?.generation, '2');
  await assert.rejects(lifecycle.stop(first.ownerId, '1'), { status: 409 });
  await assert.rejects(
    lifecycle.start({ ...second, env: { ...second.env, SIDEKICK_RUNTIME_SECRET: 't'.repeat(43) } }),
    { status: 409 },
  );
});

test('storage identity is available during startup without blocking hydration on a ready port', async () => {
  let saved: TenantIdentity | undefined;
  const lifecycle = createTenantLifecycle({
    environment: 'development',
    read: async () => saved,
    write: async (identity) => {
      saved = identity;
    },
    status: async () => 'stopped',
    start: async () => {
      const identity = await lifecycle.identity();
      assert.equal(identity.ownerId, input.ownerId);
    },
    stop: async () => {},
  });
  const input = configuration();
  await lifecycle.start(input);
});

test('concurrent conflicting bootstrap calls cannot replace the admitted process', async () => {
  let saved: TenantIdentity | undefined;
  let state: 'stopped' | 'healthy' = 'stopped';
  const lifecycle = createTenantLifecycle({
    environment: 'development',
    read: async () => saved,
    write: async (identity) => {
      saved = identity;
    },
    status: async () => state,
    start: async () => {
      state = 'healthy';
    },
    stop: async () => {
      state = 'stopped';
    },
  });
  const first = configuration();
  const second = { ...first, env: { ...first.env, SIDEKICK_RUNTIME_GENERATION: '2' } };
  const results = await Promise.allSettled([lifecycle.start(first), lifecycle.start(second)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(saved?.generation, '1');
});

test('body limits apply to actual streamed bytes without trusting content length', async () => {
  const request = new Request('http://sidekick.runtime/runtime/start', {
    method: 'POST',
    body: new Uint8Array(12),
    headers: { 'content-length': '1' },
  });
  await assert.rejects(boundedBody(request, 10), { status: 413 });
});
