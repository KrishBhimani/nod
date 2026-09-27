import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createArtifactService } from '../src/server/artifacts.ts';
import { createFilesystemObjectStore } from '../src/providers/object-storage/filesystem.ts';

test(
  'private artifacts survive actor restart and remain owned for downloads and channel delivery',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-artifact-store-'));
    const schema = 'test_durable_artifacts_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    try {
      await database.query(
        `CREATE TABLE tasks(id uuid PRIMARY KEY,owner_id text NOT NULL); CREATE TABLE artifacts(id uuid PRIMARY KEY,owner_id text NOT NULL,task_id uuid REFERENCES tasks(id),name text NOT NULL CHECK(name <> 'reject'),mime_type text NOT NULL,size integer NOT NULL,storage_path text NOT NULL)`,
      );
      const task = randomUUID();
      const foreignTask = randomUUID();
      await database.query('INSERT INTO tasks VALUES($1,$2),($3,$4)', [
        task,
        'owner-one',
        foreignTask,
        'owner-two',
      ]);
      const create = (ownerId: string) =>
        createArtifactService({
          database,
          ownerId,
          store: createFilesystemObjectStore(join(root, ownerId)),
        });
      const original = create('owner-one');
      const saved = await original.storeArtifact(
        Buffer.from('synthetic file'),
        'private.txt',
        'text/plain',
        task,
      );
      assert.deepEqual(Object.keys(saved).sort(), ['id', 'mimeType', 'name', 'size', 'url']);
      const restored = create('owner-one');
      assert.equal((await restored.readArtifact(saved.id)).toString(), 'synthetic file');
      assert.equal(
        (await restored.readTaskArtifacts(task, [saved.id]))[0].bytes.toString(),
        'synthetic file',
      );
      await assert.rejects(create('owner-two').readArtifact(saved.id), /unavailable/);
      await assert.rejects(
        create('owner-two').readTaskArtifacts(foreignTask, [saved.id]),
        /unavailable/,
      );
      await assert.rejects(
        restored.storeArtifact(Buffer.from('x'), 'file', 'text/plain', foreignTask),
        /task is unavailable/,
      );
      const before = await readdir(join(root, 'owner-one', 'artifacts'));
      await assert.rejects(restored.storeArtifact(Buffer.from('cleanup'), 'reject', 'text/plain'));
      assert.deepEqual(await readdir(join(root, 'owner-one', 'artifacts')), before);
      await database.query('UPDATE artifacts SET storage_path=$1 WHERE id=$2', [
        'object:artifacts/' + randomUUID(),
        saved.id,
      ]);
      await assert.rejects(restored.readArtifact(saved.id), /unavailable/);
    } finally {
      await database.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
