import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { registerLocalAccess } from '../src/server/access.ts';
import { createVault, sealCredential } from '../src/server/vault.ts';
import type { VaultLoginEntry } from '../src/shared/contracts.ts';

test(
  'Vault details and password reads stay explicit, owned and outside list metadata',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_vault_details_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
    );
    await pool.query(
      "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running')",
    );
    const key = randomBytes(32);
    const headers = { host: 'localhost:4310', origin: 'http://localhost:4310' };
    let app: FastifyInstance;
    const start = async (getKey: () => Promise<Buffer> = async () => key) => {
      const instance = Fastify({ logger: false });
      registerLocalAccess(instance, 4310);
      const vault = await createVault(pool, {
        keyStore: { id: 'fixture', configured: true, getKey },
        inject: async () => assert.fail('Viewing a login must not fill a browser.'),
        resume: async () => assert.fail('Viewing a login must not resume a turn.'),
        retry: async () => assert.fail('Viewing a login must not restart a turn.'),
      });
      vault.registerRoutes(instance);
      return instance;
    };
    const read = (id: string, field: 'details' | 'password') =>
      app.inject({ method: 'POST', url: `/api/vault/${id}/${field}`, headers, payload: {} });
    const seed = async (ownerId = 'local-development', origin = 'https://example.com') => {
      const entry = { id: randomUUID(), owner_id: ownerId, origin };
      await pool.query(
        'INSERT INTO vault_entries(id,owner_id,label,origin,username_hint,ciphertext) VALUES($1,$2,$3,$4,$5,$6)',
        [
          entry.id,
          entry.owner_id,
          'Synthetic login',
          entry.origin,
          'sy…',
          sealCredential(key, entry, {
            username: 'synthetic-user',
            password: 'synthetic-password',
          }),
        ],
      );
      return entry;
    };
    app = await start();
    try {
      const saved: VaultLoginEntry[] = [];
      for (const label of ['Personal', 'Work']) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/vault',
          headers,
          payload: {
            label,
            origin: 'example.com',
            username: `${label.toLowerCase()}@example.test`,
            password: `${label}-synthetic-password`,
          },
        });
        assert.equal(response.statusCode, 200);
        saved.push(response.json<VaultLoginEntry>());
      }

      await t.test(
        'each account exposes full details and password through separate POSTs',
        async () => {
          for (const entry of saved) {
            const details = await read(entry.id, 'details');
            assert.equal(details.statusCode, 200);
            assert.deepEqual(details.json(), {
              ...entry,
              username: `${entry.label.toLowerCase()}@example.test`,
            });
            assert.doesNotMatch(details.body, /synthetic-password|ciphertext|owner_id/);
            const password = await read(entry.id, 'password');
            assert.equal(password.statusCode, 200);
            assert.deepEqual(password.json(), { password: `${entry.label}-synthetic-password` });
            for (const response of [details, password]) {
              assert.equal(response.headers['cache-control'], 'no-store');
              assert.equal(response.headers['referrer-policy'], 'no-referrer');
            }
          }
          const list = await app.inject({ url: '/api/vault', headers });
          assert.equal(list.json().length, 2);
          assert.match(list.body, /personal@example\.test/);
          assert.match(list.body, /work@example\.test/);
          assert.doesNotMatch(list.body, /synthetic-password|ciphertext|owner_id/);
        },
      );

      await t.test('saved details remain readable after restarting the Vault service', async () => {
        await app.close();
        app = await start();
        assert.equal((await read(saved[0].id, 'details')).json().username, 'personal@example.test');
        assert.deepEqual((await read(saved[1].id, 'password')).json(), {
          password: 'Work-synthetic-password',
        });
      });

      await t.test(
        'foreign, missing and malformed IDs and body overrides cannot reveal values',
        async () => {
          const foreign = await seed('foreign-owner');
          for (const field of ['details', 'password'] as const) {
            for (const id of [foreign.id, randomUUID()]) {
              const response = await read(id, field);
              assert.equal(response.statusCode, 404);
              assert.deepEqual(response.json(), { error: 'This saved login could not be found.' });
            }
            assert.equal((await read('not-an-id', field)).statusCode, 400);
            for (const payload of [{ ownerId: 'foreign-owner' }, { password: 'injected-secret' }]) {
              const response = await app.inject({
                method: 'POST',
                url: `/api/vault/${saved[0].id}/${field}`,
                headers,
                payload,
              });
              assert.equal(response.statusCode, 400);
              assert.doesNotMatch(
                response.body,
                /foreign-owner|injected-secret|synthetic-password/,
              );
            }
            assert.equal(
              (await app.inject({ url: `/api/vault/${saved[0].id}/${field}`, headers })).statusCode,
              404,
            );
          }
        },
      );

      await t.test(
        'local access rejects foreign hosts, origins and cross-site requests',
        async () => {
          for (const field of ['details', 'password'] as const) {
            for (const rejected of [
              { ...headers, host: 'other.example:4310' },
              { ...headers, origin: 'https://other.example' },
              { ...headers, 'sec-fetch-site': 'cross-site' },
            ]) {
              const response = await app.inject({
                method: 'POST',
                url: `/api/vault/${saved[0].id}/${field}`,
                headers: rejected,
                payload: {},
              });
              assert.equal(response.statusCode, 403);
              assert.equal(response.headers['cache-control'], 'no-store');
              assert.doesNotMatch(response.body, /@example\.test|synthetic-password/);
            }
          }
        },
      );

      await t.test('corrupt and transplanted ciphertext returns only a fixed failure', async () => {
        for (const alteration of ['ciphertext', 'record', 'origin']) {
          const entry = await seed();
          if (alteration === 'ciphertext')
            await pool.query('UPDATE vault_entries SET ciphertext=$2 WHERE id=$1', [
              entry.id,
              'corrupt-private-ciphertext',
            ]);
          else if (alteration === 'record')
            await pool.query(
              'UPDATE vault_entries SET ciphertext=(SELECT ciphertext FROM vault_entries WHERE id=$2) WHERE id=$1',
              [entry.id, saved[0].id],
            );
          else
            await pool.query('UPDATE vault_entries SET origin=$2 WHERE id=$1', [
              entry.id,
              'https://other.example.com',
            ]);
          for (const field of ['details', 'password'] as const) {
            const response = await read(entry.id, field);
            assert.equal(response.statusCode, 500);
            assert.deepEqual(response.json(), { error: 'This saved login could not be opened.' });
          }
        }
      });

      await t.test('an unavailable key fails closed without returning its raw error', async () => {
        await app.close();
        app = await start(async () => {
          throw new Error('private-key-provider-detail');
        });
        for (const field of ['details', 'password'] as const) {
          const response = await read(saved[0].id, field);
          assert.equal(response.statusCode, 503);
          assert.deepEqual(response.json(), {
            error: 'The credential key is unavailable. Check the configured key store.',
          });
        }
      });

      await t.test(
        'deletion or ownership changes during key access cannot release an old value',
        async () => {
          for (const field of ['details', 'password'] as const) {
            const entry = await seed();
            await app.close();
            let release!: (value: Buffer) => void;
            let started!: () => void;
            const startedKey = new Promise<void>((resolve) => {
              started = resolve;
            });
            const pendingKey = new Promise<Buffer>((resolve) => {
              release = resolve;
            });
            app = await start(async () => {
              started();
              return pendingKey;
            });
            const pending = read(entry.id, field).then((response) => response);
            assert.equal(
              await Promise.race([startedKey.then(() => true), delay(1000).then(() => false)]),
              true,
              'The owned read should reach the key store.',
            );
            if (field === 'details')
              await pool.query('DELETE FROM vault_entries WHERE id=$1', [entry.id]);
            else
              await pool.query('UPDATE vault_entries SET owner_id=$2 WHERE id=$1', [
                entry.id,
                'foreign-owner',
              ]);
            release(key);
            const response = await pending;
            assert.equal(response.statusCode, 404);
            assert.deepEqual(response.json(), { error: 'This saved login could not be found.' });
          }
        },
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
