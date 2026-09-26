import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createAccountStore } from '../src/server/account-store.ts';

test(
  'account preferences persist partial updates independently for each owner',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async () => {
    const schema = 'test_account_store_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const first = randomUUID();
    const second = randomUUID();
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const store = createAccountStore(database);
      await store.initialize();
      await store.initialize();
      const defaults = { theme: 'system', onboardingCompleted: false, displayName: null };
      assert.deepEqual(await store.read(first), defaults);
      assert.equal(
        (await database.query('SELECT count(*)::integer AS count FROM account_settings')).rows[0]
          .count,
        0,
      );
      await store.update(first, { theme: 'dark' });
      await store.update(first, { name: 'Synthetic account', onboardingCompleted: true });
      assert.deepEqual(await store.update(first, {}), {
        theme: 'dark',
        onboardingCompleted: true,
        displayName: 'Synthetic account',
      });
      await store.update(first, { onboardingCompleted: false });
      await store.update(second, { theme: 'light' });
      const restarted = createAccountStore(database);
      await restarted.initialize();
      assert.deepEqual(await restarted.read(first), {
        theme: 'dark',
        onboardingCompleted: false,
        displayName: 'Synthetic account',
      });
      assert.deepEqual(await restarted.read(second), { ...defaults, theme: 'light' });
      await assert.rejects(
        () =>
          database.query('UPDATE account_settings SET theme=$2 WHERE owner_id=$1', [
            first,
            'unrecognized',
          ]),
        { code: '23514' },
      );
    } finally {
      await database.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
