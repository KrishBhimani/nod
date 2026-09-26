import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { ComputerAllocation } from '../src/ports/computer-allocation.ts';
import {
  ComputerAllocationError,
  createComputerAllocationStore,
} from '../src/server/computer-allocations.ts';

function initial(ownerId: string): ComputerAllocation {
  return {
    ownerId,
    role: 'browser',
    provider: 'e2b',
    templateId: 'synthetic-browser',
    resourceId: null,
    generation: randomUUID(),
    version: 1,
    state: 'allocating',
    leaseId: randomUUID(),
    leaseExpiresAt: Date.now() + 90_000,
  };
}

test('computer allocation stores reject foreign owners and malformed writes before access', async () => {
  let queries = 0;
  const database = {
    query: async () => {
      queries++;
      throw new Error('synthetic private database detail');
    },
  } as unknown as pg.Pool;
  assert.throws(() => createComputerAllocationStore({ database, ownerId: '' }));
  const ownerId = randomUUID();
  const store = createComputerAllocationStore({ database, ownerId });
  await assert.rejects(store.read(randomUUID(), 'browser'), { code: 'invalid_allocation' });
  const value = initial(ownerId);
  for (const change of [
    { ownerId: randomUUID() },
    { version: 2 },
    { version: 0 },
    { version: 1.5 },
    { provider: '' },
    { templateId: 'a'.repeat(201) },
    { resourceId: 'resource\u0000' },
    { generation: '' },
    { leaseId: null },
    { leaseExpiresAt: null },
    { leaseExpiresAt: Infinity },
    { leaseExpiresAt: -1 },
    { leaseExpiresAt: 1.2 },
    { state: 'ready' as const },
  ])
    await assert.rejects(store.compareAndSwap(null, { ...value, ...change }), {
      code: 'invalid_allocation',
    });
  await assert.rejects(store.compareAndSwap(0, value), { code: 'invalid_allocation' });
  await assert.rejects(store.compareAndSwap(2_147_483_647, { ...value, version: 2_147_483_648 }), {
    code: 'invalid_allocation',
  });
  assert.equal(queries, 0);
  await assert.rejects(store.read(ownerId, 'browser'), (error) => {
    assert.ok(error instanceof ComputerAllocationError);
    assert.equal(error.code, 'unavailable');
    assert.ok(!String(error).includes('synthetic private'));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test(
  'computer allocations persist owner and role boundaries, CAS writes and immutable resource identity',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_allocations_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 4,
    });
    t.after(async () => {
      await database.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const ownerId = randomUUID();
    const otherOwner = randomUUID();
    const store = createComputerAllocationStore({ database, ownerId });
    const other = createComputerAllocationStore({ database, ownerId: otherOwner });
    await Promise.all([store.initialize(), other.initialize()]);
    assert.equal(await store.read(ownerId, 'browser'), undefined);
    const first = initial(ownerId);
    const competing = { ...first, generation: randomUUID(), leaseId: randomUUID() };
    const created = await Promise.all([
      store.compareAndSwap(null, first),
      store.compareAndSwap(null, competing),
    ]);
    assert.equal(created.filter(Boolean).length, 1);
    const accepted = created[0] ? first : competing;
    assert.deepEqual(await store.read(ownerId, 'browser'), accepted);
    assert.equal(await other.read(otherOwner, 'browser'), undefined);
    const otherValue = initial(otherOwner);
    assert.equal(await other.compareAndSwap(null, otherValue), true);
    const workspace = { ...initial(ownerId), role: 'workspace' as const };
    assert.equal(await store.compareAndSwap(null, workspace), true);
    const ready = { ...accepted, version: 2, state: 'ready' as const, resourceId: 'sandbox-a' };
    assert.equal(await store.compareAndSwap(1, ready), true);
    assert.equal(await store.compareAndSwap(1, { ...ready, resourceId: 'sandbox-b' }), false);
    for (const change of [
      { provider: 'other' },
      { templateId: 'other-template' },
      { generation: randomUUID() },
      { resourceId: 'sandbox-b' },
      { resourceId: null, state: 'uncertain' as const },
    ])
      assert.equal(await store.compareAndSwap(2, { ...ready, version: 3, ...change }), false);
    const released = { ...ready, version: 3, leaseId: null, leaseExpiresAt: null };
    assert.equal(await store.compareAndSwap(2, released), true);
    const restart = createComputerAllocationStore({ database, ownerId });
    assert.deepEqual(await restart.read(ownerId, 'browser'), released);
    const reacquire = {
      ...released,
      version: 4,
      leaseId: randomUUID(),
      leaseExpiresAt: Date.now() + 90_000,
    };
    const claimed = await Promise.all([
      restart.compareAndSwap(3, reacquire),
      store.compareAndSwap(3, { ...reacquire, leaseId: randomUUID() }),
    ]);
    assert.equal(claimed.filter(Boolean).length, 1);
    const live = (await store.read(ownerId, 'browser'))!;
    const uncertain = { ...live, version: 5, state: 'uncertain' as const, leaseExpiresAt: 1 };
    assert.equal(await store.compareAndSwap(4, uncertain), true);
    assert.deepEqual(await restart.read(ownerId, 'browser'), uncertain);
    assert.equal(await restart.compareAndSwap(null, initial(ownerId)), false);
    const recovered = {
      ...uncertain,
      version: 6,
      state: 'ready' as const,
      leaseId: null,
      leaseExpiresAt: null,
    };
    assert.equal(await restart.compareAndSwap(5, recovered), true);
    assert.deepEqual(await store.read(ownerId, 'browser'), recovered);
    assert.deepEqual(await store.read(ownerId, 'workspace'), workspace);
    assert.deepEqual(await other.read(otherOwner, 'browser'), otherValue);
    await assert.rejects(store.compareAndSwap(1, { ...otherValue, version: 2 }), {
      code: 'invalid_allocation',
    });
  },
);
