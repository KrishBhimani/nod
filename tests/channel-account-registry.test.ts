import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {
  ChannelAccountRegistryError,
  createChannelAccountRegistry,
} from '../src/server/channel-account-registry.ts';

test('channel ownership validates deployment and verified identities before database access', async () => {
  let queries = 0;
  const admin = {
    query: async () => {
      queries++;
      throw new Error('synthetic private database detail');
    },
  } as unknown as pg.Pool;
  for (const change of [
    { environment: '../production' },
    { controlSchema: 'public' },
    { controlSchema: 'pg_catalog' },
    { controlSchema: 'schema;select' },
  ])
    assert.throws(
      () => createChannelAccountRegistry({ admin, environment: 'development', ...change }),
      ChannelAccountRegistryError,
    );
  const registry = createChannelAccountRegistry({ admin, environment: 'development' });
  const valid = {
    ownerId: randomUUID(),
    provider: 'telegram' as const,
    accountId: '123456',
    revision: '1',
  };
  for (const change of [
    { ownerId: 'local-development' },
    { accountId: '' },
    { accountId: 'account with spaces' },
    { accountId: 'a'.repeat(201) },
    { revision: '' },
    { revision: '-1' },
    { revision: '1.0' },
    { revision: '9223372036854775808' },
  ]) {
    await assert.rejects(registry.claim({ ...valid, ...change }), { code: 'invalid_identity' });
    await assert.rejects(registry.release({ ...valid, ...change }), { code: 'invalid_identity' });
  }
  assert.equal(queries, 0);
  await assert.rejects(registry.claim(valid), (error) => {
    assert.ok(error instanceof ChannelAccountRegistryError);
    assert.equal(error.code, 'unavailable');
    assert.ok(!String(error).includes('synthetic private'));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test(
  'channel account claims are atomic, persistent and released only by their owner',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const controlSchema = `test_channel_owners_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
    t.after(async () => {
      await admin.query(`DROP SCHEMA IF EXISTS ${controlSchema} CASCADE`);
      await admin.end();
    });
    await admin.query(`CREATE SCHEMA ${controlSchema}`);
    const options = { admin, controlSchema, environment: 'development' };
    const registry = createChannelAccountRegistry(options);
    await Promise.all([registry.initialize(), registry.initialize()]);
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    const account = { provider: 'telegram' as const, accountId: '123456', revision: '1' };
    const result = await Promise.all([
      registry.claim({ ...account, ownerId: ownerA }),
      registry.claim({ ...account, ownerId: ownerB }),
    ]);
    assert.equal(result.filter(Boolean).length, 1);
    const winner = result[0] ? ownerA : ownerB;
    const loser = result[0] ? ownerB : ownerA;
    assert.equal(await registry.claim({ ...account, ownerId: winner.toUpperCase() }), true);
    await registry.release({ ...account, ownerId: loser });
    assert.equal(await registry.claim({ ...account, ownerId: loser }), false);
    const restarted = createChannelAccountRegistry(options);
    assert.equal(await restarted.claim({ ...account, ownerId: winner }), true);
    assert.equal(await restarted.claim({ ...account, ownerId: loser }), false);
    assert.equal(await registry.claim({ ...account, ownerId: loser, provider: 'whatsapp' }), true);
    const production = createChannelAccountRegistry({ ...options, environment: 'production' });
    assert.equal(await production.claim({ ...account, ownerId: loser }), true);
    await production.release({ ...account, ownerId: loser });
    assert.equal(await registry.claim({ ...account, ownerId: loser }), false);
    await restarted.release({ ...account, ownerId: winner });
    assert.equal(await registry.claim({ ...account, ownerId: loser, revision: '2' }), true);
    await restarted.release({ ...account, ownerId: winner });
    assert.equal(await registry.claim({ ...account, ownerId: winner }), false);
    const granted = await admin.query<{ count: string }>(
      `SELECT count(*) FROM information_schema.table_privileges
       WHERE table_schema=$1 AND table_name='channel_accounts' AND grantee='PUBLIC'`,
      [controlSchema],
    );
    assert.equal(granted.rows[0].count, '0');
  },
);

test(
  'channel revisions preserve release tombstones, reject stale writes and migrate existing claims',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async (t) => {
    const controlSchema = `test_channel_revisions_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    t.after(async () => {
      await admin.query(`DROP SCHEMA IF EXISTS ${controlSchema} CASCADE`);
      await admin.end();
    });
    await admin.query(`CREATE SCHEMA ${controlSchema}`);
    await admin.query(`CREATE TABLE ${controlSchema}.channel_accounts (
    environment text NOT NULL, provider text NOT NULL, account_id text NOT NULL, owner_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(environment,provider,account_id)
  )`);
    const account = {
      ownerId: randomUUID(),
      provider: 'telegram' as const,
      accountId: '12345',
      revision: '0',
    };
    await admin.query(
      `INSERT INTO ${controlSchema}.channel_accounts(environment,provider,account_id,owner_id) VALUES($1,$2,$3,$4)`,
      ['development', account.provider, account.accountId, account.ownerId],
    );
    const options = { admin, controlSchema, environment: 'development' };
    const registry = createChannelAccountRegistry(options);
    await registry.initialize();
    assert.equal(await registry.claim(account), true);
    await registry.release(account);
    assert.equal(await registry.claim(account), false);
    await registry.release({ ...account, revision: '1' });
    const restarted = createChannelAccountRegistry(options);
    await restarted.initialize();
    assert.equal(await restarted.claim({ ...account, revision: '1' }), false);
    assert.equal(await restarted.claim({ ...account, revision: '2' }), true);
    await registry.release({ ...account, revision: '1' });
    assert.equal(await registry.claim({ ...account, revision: '1' }), false);
    const foreign = { ...account, ownerId: randomUUID(), revision: '99' };
    assert.equal(await registry.claim(foreign), false);
    await registry.release(foreign);
    assert.equal(await registry.claim({ ...account, revision: '2' }), true);
    const stored = await admin.query(
      `SELECT owner_id,revision::text FROM ${controlSchema}.channel_accounts`,
    );
    assert.deepEqual(stored.rows, [{ owner_id: account.ownerId, revision: '2' }]);
    await registry.release({ ...account, revision: '2' });
    assert.equal(await registry.claim(foreign), false);
    assert.equal(await registry.claim({ ...foreign, revision: '100' }), true);
    await registry.release({ ...account, revision: '2' });
    assert.equal(
      (await admin.query(`SELECT owner_id FROM ${controlSchema}.channel_accounts`)).rows[0]
        .owner_id,
      foreign.ownerId,
    );
  },
);
