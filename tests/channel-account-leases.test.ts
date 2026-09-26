import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { createChannelAccountRegistry } from '../src/server/channel-account-registry.ts';
import type { TenantLease } from '../src/server/tenants.ts';

async function fixture(t: TestContext) {
  const schema = `test_channel_lease_${randomUUID().replaceAll('-', '')}`;
  const applicationName = `channel-lease-${randomUUID()}`;
  const admin = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    application_name: applicationName,
    max: 5,
  });
  const blockers: pg.PoolClient[] = [];
  t.after(async () => {
    for (const blocker of blockers) {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`CREATE TABLE ${schema}.tenants (
    environment text NOT NULL, owner_id uuid NOT NULL,
    lease_holder uuid, lease_generation bigint NOT NULL, lease_expires timestamptz,
    PRIMARY KEY (environment,owner_id)
  )`);
  const registry = createChannelAccountRegistry({
    admin,
    controlSchema: schema,
    environment: 'development',
  });
  await registry.initialize();
  async function createLease(): Promise<TenantLease> {
    const lease = {
      ownerId: randomUUID(),
      environment: 'development',
      holderId: randomUUID(),
      generation: '1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await admin.query(`INSERT INTO ${schema}.tenants VALUES ($1,$2,$3,$4,$5)`, [
      lease.environment,
      lease.ownerId,
      lease.holderId,
      lease.generation,
      lease.expiresAt,
    ]);
    return lease;
  }
  async function waitForLock() {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const result = await admin.query<{ waiting: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
         WHERE application_name=$1 AND wait_event_type='Lock' AND pid<>pg_backend_pid()) AS waiting`,
        [applicationName],
      );
      if (result.rows[0].waiting) return;
      await setTimeout(5);
    }
    assert.fail('The channel mutation did not wait for the tenant lock.');
  }
  async function connectBlocker() {
    const client = await admin.connect();
    blockers.push(client);
    return client;
  }
  return { admin, schema, registry, createLease, waitForLock, connectBlocker };
}

test('leased channel claims reject malformed and mismatched identities before SQL', async () => {
  let queries = 0;
  const admin = {
    query: async () => {
      queries++;
      throw new Error('private database detail');
    },
  } as unknown as pg.Pool;
  const registry = createChannelAccountRegistry({ admin, environment: 'development' });
  const ownerId = randomUUID();
  const input = { ownerId, provider: 'telegram' as const, accountId: '12345' };
  const lease = {
    ownerId,
    environment: 'development',
    holderId: randomUUID(),
    generation: '1',
    expiresAt: new Date().toISOString(),
  };
  for (const change of [
    { ownerId: randomUUID() },
    { environment: 'production' },
    { holderId: 'not-a-holder' },
    { generation: '0' },
    { generation: '-1' },
    { generation: '1.0' },
    { generation: '9223372036854775808' },
    { generation: '1;SELECT' },
  ]) {
    await assert.rejects(registry.claimWithLease(input, { ...lease, ...change }), {
      code: 'invalid_lease',
      statusCode: 401,
    });
    await assert.rejects(registry.releaseWithLease(input, { ...lease, ...change }), {
      code: 'invalid_lease',
      statusCode: 401,
    });
  }
  assert.equal(queries, 0);
});

test(
  'leased channel ownership uses the active SQL lease and preserves another owner',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { admin, schema, registry, createLease } = await fixture(t);
    const first = await createLease();
    const second = await createLease();
    const account = { provider: 'telegram' as const, accountId: '12345' };
    const identity = { ...account, ownerId: first.ownerId };
    assert.equal(
      await registry.claimWithLease(identity, { ...first, expiresAt: new Date(0).toISOString() }),
      true,
    );
    assert.equal(await registry.claimWithLease(identity, first), true);
    assert.equal(
      await registry.claimWithLease({ ...account, ownerId: second.ownerId }, second),
      false,
    );
    await registry.releaseWithLease({ ...account, ownerId: second.ownerId }, second);
    assert.equal(
      await registry.claimWithLease({ ...account, ownerId: second.ownerId }, second),
      false,
    );
    for (const change of [
      { holderId: randomUUID() },
      { generation: '2' },
      { ownerId: randomUUID() },
    ]) {
      const candidate = { ...first, ...change };
      await assert.rejects(
        registry.claimWithLease({ ...identity, ownerId: candidate.ownerId }, candidate),
        { code: 'invalid_lease' },
      );
      await assert.rejects(
        registry.releaseWithLease({ ...identity, ownerId: candidate.ownerId }, candidate),
        { code: 'invalid_lease' },
      );
    }
    await admin.query(
      `UPDATE ${schema}.tenants SET lease_expires=clock_timestamp()-interval '1 second' WHERE owner_id=$1`,
      [first.ownerId],
    );
    await assert.rejects(registry.releaseWithLease(identity, first), { code: 'invalid_lease' });
    await assert.rejects(registry.claimWithLease({ ...identity, accountId: 'another' }, first), {
      code: 'invalid_lease',
    });
    assert.equal(
      await registry.claimWithLease({ ...account, ownerId: second.ownerId }, second),
      false,
    );
    await admin.query(
      `UPDATE ${schema}.tenants SET lease_expires=clock_timestamp()+interval '60 seconds' WHERE owner_id=$1`,
      [first.ownerId],
    );
    await registry.releaseWithLease(identity, first);
    assert.equal(
      await registry.claimWithLease({ ...account, ownerId: second.ownerId }, second),
      true,
    );
  },
);

test(
  'channel mutations recheck generation after waiting for the tenant row lock',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { admin, schema, registry, createLease, waitForLock, connectBlocker } = await fixture(t);
    const lease = await createLease();
    const identity = { ownerId: lease.ownerId, provider: 'telegram' as const, accountId: '12345' };
    await registry.claimWithLease(identity, lease);
    const blocker = await connectBlocker();
    await blocker.query('BEGIN');
    await blocker.query(
      `UPDATE ${schema}.tenants SET lease_generation=2,lease_holder=$2 WHERE owner_id=$1`,
      [lease.ownerId, randomUUID()],
    );
    const claim = assert.rejects(
      registry.claimWithLease({ ...identity, accountId: 'stale-claim' }, lease),
      { code: 'invalid_lease', statusCode: 401 },
    );
    const release = assert.rejects(registry.releaseWithLease(identity, lease), {
      code: 'invalid_lease',
      statusCode: 401,
    });
    await waitForLock();
    await blocker.query('COMMIT');
    await Promise.all([claim, release]);
    const rows = await admin.query<{ account_id: string; owner_id: string }>(
      `SELECT account_id,owner_id FROM ${schema}.channel_accounts`,
    );
    assert.deepEqual(rows.rows, [{ account_id: identity.accountId, owner_id: lease.ownerId }]);
  },
);

test(
  'channel claims recheck database expiry after an unchanged tenant lock is released',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { admin, schema, registry, createLease, waitForLock, connectBlocker } = await fixture(t);
    const lease = await createLease();
    await admin.query(
      `UPDATE ${schema}.tenants SET lease_expires=clock_timestamp()+interval '400 milliseconds' WHERE owner_id=$1`,
      [lease.ownerId],
    );
    const blocker = await connectBlocker();
    await blocker.query('BEGIN');
    await blocker.query(`SELECT owner_id FROM ${schema}.tenants WHERE owner_id=$1 FOR UPDATE`, [
      lease.ownerId,
    ]);
    const claim = assert.rejects(
      registry.claimWithLease(
        { ownerId: lease.ownerId, provider: 'telegram', accountId: 'expired-claim' },
        lease,
      ),
      { code: 'invalid_lease', statusCode: 401 },
    );
    await waitForLock();
    await blocker.query('SELECT pg_sleep(0.45)');
    await blocker.query('COMMIT');
    await claim;
    const rows = await admin.query(`SELECT * FROM ${schema}.channel_accounts`);
    assert.equal(rows.rowCount, 0);
  },
);
