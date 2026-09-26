import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createPostgresObjectStore } from '../src/server/object-storage.ts';
import { ObjectStoreConflict } from '../src/ports/object-storage.ts';

async function fixture() {
  const schema = 'test_private_objects_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const database = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  return {
    database,
    async close() {
      await database.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

test(
  'PostgreSQL private objects survive adapter restart, isolate owners and atomically fence concurrent writers',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const f = await fixture();
    const key = `sessions/${randomUUID()}.jsonl`;
    const first = createPostgresObjectStore({ database: f.database, ownerId: 'owner-one' });
    const second = createPostgresObjectStore({ database: f.database, ownerId: 'owner-two' });
    try {
      await Promise.all([first.initialize(), second.initialize()]);
      const original = await first.write(key, Buffer.from('original'), { expectedVersion: null });
      assert.equal(await second.read(key, 100), undefined);
      await second.write(key, Buffer.from('foreign'), { expectedVersion: null });
      const writes = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          first.write(key, Buffer.from('winner-' + i), { expectedVersion: original }),
        ),
      );
      assert.equal(writes.filter((value) => value.status === 'fulfilled').length, 1);
      assert.ok(
        writes
          .filter((value) => value.status === 'rejected')
          .every((value) => value.reason instanceof ObjectStoreConflict),
      );
      const restored = createPostgresObjectStore({ database: f.database, ownerId: 'owner-one' });
      const saved = await restored.read(key, 100);
      assert.match(saved!.bytes.toString(), /^winner-\d+$/);
      assert.equal((await second.read(key, 100))?.bytes.toString(), 'foreign');
      await assert.rejects(first.read(key, 2), /unavailable/);
      await assert.rejects(first.read('../other-owner/key', 100), /unavailable/);
      await assert.rejects(
        first.write(key, Buffer.alloc(16 * 1024 * 1024 + 1), { expectedVersion: saved!.version }),
        /unavailable/,
      );
      await assert.rejects(first.remove(key, { expectedVersion: original }), ObjectStoreConflict);
      await assert.rejects(first.remove(key, { expectedVersion: '' }), ObjectStoreConflict);
      await restored.remove(key, { expectedVersion: saved!.version });
      assert.equal(await first.read(key, 100), undefined);
      assert.equal((await second.read(key, 100))?.bytes.toString(), 'foreign');
    } finally {
      await f.close();
    }
  },
);

test(
  'a lost PostgreSQL write acknowledgement preserves committed bytes and rejects stale replay',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const f = await fixture();
    const key = `artifacts/${randomUUID()}`;
    const stable = createPostgresObjectStore({ database: f.database, ownerId: 'owner' });
    try {
      await stable.initialize();
      const version = await stable.write(key, Buffer.from('before'), { expectedVersion: null });
      const disconnected = {
        query: async (...args: Parameters<pg.Pool['query']>) => {
          await f.database.query(...args);
          throw new Error('private connection details must not escape');
        },
      } as unknown as pg.Pool;
      const uncertain = createPostgresObjectStore({ database: disconnected, ownerId: 'owner' });
      await assert.rejects(
        uncertain.write(key, Buffer.from('committed'), { expectedVersion: version }),
        { message: 'Private file storage is temporarily unavailable.' },
      );
      const restored = createPostgresObjectStore({ database: f.database, ownerId: 'owner' });
      assert.equal((await restored.read(key, 100))?.bytes.toString(), 'committed');
      await assert.rejects(
        restored.write(key, Buffer.from('replayed'), { expectedVersion: version }),
        ObjectStoreConflict,
      );
    } finally {
      await f.close();
    }
  },
);
