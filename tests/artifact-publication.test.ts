import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { Artifact } from '../src/shared/contracts.ts';
import type { PrivateObject, PrivateObjectStore } from '../src/ports/object-storage.ts';
import { createArtifactService } from '../src/server/artifacts.ts';
import { pool, transaction } from '../src/server/db.ts';

for (const storage of ['local', 'object'] as const)
  test(
    `${storage} publication cleanup removes only known uncommitted bytes`,
    { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'otto-publication-'));
      const schema = `test_publication_${randomUUID().replaceAll('-', '')}`;
      const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const database = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path=${schema}`,
        max: 1,
        connectionTimeoutMillis: 1_000,
      });
      t.mock.method(pool, 'connect', () => database.connect());
      const objects = new Map<string, PrivateObject>();
      const deletions: Array<{ key: string; expectedVersion?: string }> = [];
      let rejectRemoval = false;
      const store: PrivateObjectStore = {
        async read(key) {
          return objects.get(key);
        },
        async write(key, bytes, { expectedVersion }) {
          assert.equal(expectedVersion, objects.get(key)?.version ?? null);
          const version = randomUUID();
          objects.set(key, { bytes: bytes.slice(), version });
          return version;
        },
        async remove(key, options) {
          deletions.push({ key, expectedVersion: options?.expectedVersion });
          assert.ok(options?.expectedVersion);
          if (rejectRemoval || options.expectedVersion !== objects.get(key)?.version)
            throw new Error('Conditional removal unavailable.');
          objects.delete(key);
        },
      };
      const artifacts = createArtifactService({
        database,
        ownerId: 'fixture-owner',
        ...(storage === 'local' ? { localRoot: root } : { store }),
      });
      const bytes = Buffer.from('synthetic private publication');
      const readStored = async (id: string) =>
        storage === 'local'
          ? readFile(join(root, 'artifacts', id)).catch(() => undefined)
          : objects.get(`artifacts/${id}`)?.bytes;
      const storedIds = async () =>
        storage === 'local'
          ? readdir(join(root, 'artifacts')).catch(() => [])
          : [...objects.keys()].map((key) => key.slice('artifacts/'.length));
      const waitForArtifact = async (id: string) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((await database.query('SELECT 1 FROM artifacts WHERE id=$1', [id])).rowCount) return;
          await delay(10);
        }
        assert.fail('The delayed publication did not commit.');
      };
      const publication = async (commit: boolean) => {
        const client = await database.connect();
        let artifact!: Artifact;
        try {
          await client.query('BEGIN');
          artifact = await artifacts.storeArtifact(
            bytes,
            'fixture.txt',
            'text/plain',
            undefined,
            client,
          );
          await client.query('INSERT INTO messages(id,text) VALUES($1,$2)', [
            randomUUID(),
            commit ? 'saved' : 'reject',
          ]);
          await client.query('COMMIT');
          throw new Error('Synthetic lost COMMIT response.');
        } catch {
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
        assert.ok(artifact);
        return artifact;
      };
      try {
        await database.query(`CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL);
          CREATE TABLE artifacts(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid,name text NOT NULL CHECK(name<>'reject'),mime_type text NOT NULL,size integer NOT NULL,storage_path text NOT NULL);
          CREATE TABLE messages(id uuid PRIMARY KEY,text text NOT NULL CHECK(text<>'reject'));
          CREATE FUNCTION hold_publication() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.name='held-commit.txt' THEN
              PERFORM pg_advisory_xact_lock(hashtextextended(TG_TABLE_SCHEMA,0));
            ELSIF NEW.name='rejected-commit.txt' THEN
              RAISE EXCEPTION 'Rejected publication' USING ERRCODE='23514';
            END IF;
            RETURN NEW;
          END$$;
          CREATE CONSTRAINT TRIGGER hold_publication AFTER INSERT ON artifacts DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW EXECUTE FUNCTION hold_publication()`);
        await t.test('delivery rollback releases the sole connection before cleanup', async () => {
          let artifact!: Artifact;
          let cleaned = false;
          await assert.rejects(
            transaction(
              async (client) => {
                artifact = await artifacts.storeArtifact(
                  bytes,
                  'fixture.txt',
                  'text/plain',
                  undefined,
                  client,
                );
                await client.query("INSERT INTO messages VALUES($1,'reject')", [randomUUID()]);
              },
              async () => {
                await artifacts.discardUnpublished(artifact);
                cleaned = true;
              },
            ),
            { code: '23514' },
          );
          assert.equal(cleaned, true);
          assert.equal(await readStored(artifact.id), undefined);
          assert.equal(database.totalCount, 1);
          assert.equal(database.idleCount, 1);
        });
        await t.test(
          'rejected metadata insertion cleans up with the sole connection held',
          async () => {
            const before = (await storedIds()).sort();
            await assert.rejects(
              transaction((client) =>
                artifacts.storeArtifact(bytes, 'reject', 'text/plain', undefined, client),
              ),
              { code: '23514' },
            );
            assert.deepEqual((await storedIds()).sort(), before);
            await assert.rejects(artifacts.storeArtifact(bytes, 'reject', 'text/plain'), {
              code: '23514',
            });
            assert.deepEqual((await storedIds()).sort(), before);
          },
        );
        await t.test('an unacknowledged rollback retains private bytes', async () => {
          let artifact!: Artifact;
          let cleanupCalled = false;
          await assert.rejects(
            transaction(
              async (client) => {
                artifact = await artifacts.storeArtifact(
                  bytes,
                  'fixture.txt',
                  'text/plain',
                  undefined,
                  client,
                );
                await client.end();
                throw new Error('Synthetic connection loss before rollback.');
              },
              async () => {
                cleanupCalled = true;
                await artifacts.discardUnpublished(artifact);
              },
            ),
          );
          assert.equal(cleanupCalled, false);
          assert.deepEqual(Buffer.from((await readStored(artifact.id))!), bytes);
        });
        await t.test(
          'attempted COMMIT never authorizes cleanup from a later ROLLBACK',
          async () => {
            let artifact!: Artifact;
            let cleanupCalled = false;
            await assert.rejects(
              transaction(
                async (client) => {
                  artifact = await artifacts.storeArtifact(
                    bytes,
                    'rejected-commit.txt',
                    'text/plain',
                    undefined,
                    client,
                  );
                },
                async () => {
                  cleanupCalled = true;
                  await artifacts.discardUnpublished(artifact);
                },
              ),
              { code: '23514' },
            );
            assert.equal(cleanupCalled, false);
            assert.equal(
              (await database.query('SELECT 1 FROM artifacts WHERE id=$1', [artifact.id])).rowCount,
              0,
            );
            assert.deepEqual(Buffer.from((await readStored(artifact.id))!), bytes);
          },
        );
        await t.test(
          'COMMIT can finish after disconnect while metadata is still absent',
          async (commitTest) => {
            const locker = await admin.connect();
            await locker.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [schema]);
            let artifact!: Artifact;
            let cleanupCalled = false;
            try {
              await assert.rejects(
                transaction(
                  async (client) => {
                    artifact = await artifacts.storeArtifact(
                      bytes,
                      'held-commit.txt',
                      'text/plain',
                      undefined,
                      client,
                    );
                    const query = client.query.bind(client);
                    commitTest.mock.method(
                      client,
                      'query',
                      async (statement: string, ...args: unknown[]) => {
                        if (statement !== 'COMMIT')
                          return Reflect.apply(query, client, [statement, ...args]);
                        try {
                          const commit = { text: 'COMMIT', query_timeout: 100 };
                          return await query(commit);
                        } catch (error) {
                          await client.end();
                          throw error;
                        }
                      },
                    );
                  },
                  async () => {
                    cleanupCalled = true;
                    await artifacts.discardUnpublished(artifact);
                  },
                ),
              );
              assert.equal(cleanupCalled, false);
              assert.equal(
                (await database.query('SELECT 1 FROM artifacts WHERE id=$1', [artifact.id]))
                  .rowCount,
                0,
              );
              assert.deepEqual(Buffer.from((await readStored(artifact.id))!), bytes);
            } finally {
              await locker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [schema]);
              locker.release();
            }
            await waitForArtifact(artifact.id);
            assert.deepEqual(await artifacts.readArtifact(artifact.id), bytes);
          },
        );
        await t.test(
          'an implicit INSERT timeout retains bytes until its delayed commit',
          async (insertTest) => {
            const locker = await admin.connect();
            await locker.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [schema]);
            const before = new Set(await storedIds());
            const query = database.query.bind(database);
            const timedQuery = insertTest.mock.method(
              database,
              'query',
              (statement: string, ...args: unknown[]) => {
                if (!statement.startsWith('INSERT INTO artifacts'))
                  return Reflect.apply(query, database, [statement, ...args]);
                const insert = {
                  text: statement,
                  values: args[0] as unknown[],
                  query_timeout: 100,
                };
                return query(insert);
              },
            );
            let id!: string;
            try {
              await assert.rejects(
                artifacts.storeArtifact(bytes, 'held-commit.txt', 'text/plain'),
                /Query read timeout/,
              );
              timedQuery.mock.restore();
              const created = (await storedIds()).filter((id) => !before.has(id));
              assert.equal(created.length, 1);
              id = created[0];
              assert.equal(
                (await database.query('SELECT 1 FROM artifacts WHERE id=$1', [id])).rowCount,
                0,
              );
              assert.deepEqual(Buffer.from((await readStored(id))!), bytes);
            } finally {
              timedQuery.mock.restore();
              await locker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [schema]);
              locker.release();
            }
            await waitForArtifact(id);
            assert.deepEqual(await artifacts.readArtifact(id), bytes);
          },
        );
        await t.test('a rejected delivery removes the rolled-back bytes', async () => {
          const artifact = await publication(false);
          assert.deepEqual(Buffer.from((await readStored(artifact.id))!), bytes);
          await artifacts.discardUnpublished(artifact);
          assert.equal(await readStored(artifact.id), undefined);
          assert.equal(
            (await database.query('SELECT 1 FROM artifacts WHERE id=$1', [artifact.id])).rowCount,
            0,
          );
        });
        await t.test(
          'a lost commit acknowledgement keeps accepted bytes and metadata',
          async () => {
            const artifact = await publication(true);
            await artifacts.discardUnpublished(artifact);
            assert.deepEqual(await artifacts.readArtifact(artifact.id), bytes);
            assert.equal(
              (await database.query('SELECT count(*)::int AS count FROM messages')).rows[0].count,
              1,
            );
          },
        );
        await t.test('unavailable metadata never authorizes byte removal', async () => {
          const artifact = await publication(false);
          const query = t.mock.method(database, 'query', async () => {
            throw new Error('Synthetic database unavailable.');
          });
          await artifacts.discardUnpublished(artifact);
          query.mock.restore();
          assert.deepEqual(Buffer.from((await readStored(artifact.id))!), bytes);
          await artifacts.discardUnpublished(artifact);
          assert.equal(await readStored(artifact.id), undefined);
        });
        await t.test('cleanup accepts only this service creation receipt', async () => {
          const artifact = await publication(false);
          await artifacts.discardUnpublished({ ...artifact });
          assert.deepEqual(Buffer.from((await readStored(artifact.id))!), bytes);
          const id = artifact.id;
          artifact.id = randomUUID();
          await artifacts.discardUnpublished(artifact);
          assert.equal(await readStored(id), undefined);
        });
        if (storage === 'object') {
          await t.test('a replaced object version is retained', async () => {
            const artifact = await publication(false);
            const key = `artifacts/${artifact.id}`;
            const original = objects.get(key)!;
            const replacement = { bytes: Buffer.from('replacement'), version: randomUUID() };
            objects.set(key, replacement);
            await artifacts.discardUnpublished(artifact);
            assert.equal(objects.get(key), replacement);
            assert.deepEqual(deletions.at(-1), { key, expectedVersion: original.version });
          });
          await t.test('unsupported conditional removal retains the private orphan', async () => {
            const artifact = await publication(false);
            rejectRemoval = true;
            const before = deletions.length;
            await artifacts.discardUnpublished(artifact);
            assert.deepEqual(Buffer.from((await readStored(artifact.id))!), bytes);
            assert.equal(deletions.length, before + 1);
            assert.ok(deletions.at(-1)?.expectedVersion);
          });
        }
      } finally {
        await database.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
