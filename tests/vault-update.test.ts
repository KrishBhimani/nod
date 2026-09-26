import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { registerLocalAccess } from '../src/server/access.ts';
import { createVault, sealCredential } from '../src/server/vault.ts';
import type { VaultLoginEntry } from '../src/shared/contracts.ts';

test(
  'Vault edits preserve owned account bindings and keep secrets outside metadata',
  {
    skip: !process.env.TEST_DATABASE_URL,
    timeout: 30_000,
  },
  async (t) => {
    const schema = `test_vault_update_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      "CREATE TABLE tasks(id text PRIMARY KEY,owner_id text NOT NULL,revision integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'running')",
    );
    const key = randomBytes(32);
    const headers = { host: 'localhost:4310', origin: 'http://localhost:4310' };
    const start = async (getKey: () => Promise<Buffer> = async () => key) => {
      const instance = Fastify({ logger: false });
      registerLocalAccess(instance, 4310);
      const vault = await createVault(pool, {
        keyStore: { id: 'fixture', configured: true, getKey },
        inject: async () => assert.fail('Editing must not fill a browser.'),
        resume: async () => assert.fail('Editing must not resume a task.'),
        retry: async () => assert.fail('Editing must not retry a task.'),
      });
      vault.registerRoutes(instance);
      return instance;
    };
    let app: FastifyInstance = await start();
    const patch = (id: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: `/api/vault/${id}`, headers, payload });
    const read = (id: string, field: 'details' | 'password') =>
      app.inject({ method: 'POST', url: `/api/vault/${id}/${field}`, headers, payload: {} });
    const save = async (label: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault',
        headers,
        payload: {
          label,
          origin: 'https://accounts.example.test:8443',
          username: `${label}@example.test`,
          password: `${label}-secret`,
        },
      });
      assert.equal(response.statusCode, 200);
      return response.json<VaultLoginEntry>();
    };
    try {
      const first = await save('First');
      const second = await save('Second');
      await t.test(
        'rename and username changes preserve the blank or omitted password and other accounts',
        async () => {
          for (const password of [undefined, '']) {
            const response = await patch(first.id, {
              label: ' Renamed work login ',
              username: 'new-user@example.test',
              ...(password === undefined ? {} : { password }),
            });
            assert.equal(response.statusCode, 200);
            assert.equal(response.headers['cache-control'], 'no-store');
            assert.equal(response.headers['referrer-policy'], 'no-referrer');
            assert.equal(response.json().id, first.id);
            assert.equal(response.json().origin, first.origin);
            assert.equal(response.json().label, 'Renamed work login');
            assert.equal(response.json().usernameHint, 'ne…');
            assert.doesNotMatch(response.body, /new-user@example|First-secret|ciphertext|owner_id/);
            assert.equal(
              (await read(first.id, 'details')).json().username,
              'new-user@example.test',
            );
            assert.equal((await read(first.id, 'password')).json().password, 'First-secret');
          }
          assert.equal((await read(second.id, 'password')).json().password, 'Second-secret');
          assert.equal((await read(second.id, 'details')).json().label, 'Second');
          const list = await app.inject({ url: '/api/vault', headers });
          assert.equal(list.json().length, 2);
          assert.match(list.body, /new-user@example/);
          assert.doesNotMatch(list.body, /First-secret|Second-secret/);
        },
      );
      await t.test(
        'an explicit replacement survives restart with the same exact origin and record',
        async () => {
          assert.equal(
            (
              await patch(first.id, {
                label: 'Updated',
                username: '',
                password: 'replacement-secret',
              })
            ).statusCode,
            200,
          );
          await app.close();
          app = await start();
          assert.equal((await read(first.id, 'password')).json().password, 'replacement-secret');
          const details = (await read(first.id, 'details')).json();
          assert.equal(details.origin, first.origin);
          assert.equal(details.username, '');
          assert.equal(details.usernameHint, '');
        },
      );
      await t.test(
        'invalid fields, cross-origin requests and foreign IDs cannot change a login',
        async () => {
          for (const payload of [
            { label: '', username: 'user' },
            { label: 'name', username: 'x'.repeat(321) },
            { label: 'name', username: 'user', password: 'x'.repeat(8193) },
            { label: 'name', username: 'user', origin: 'https://other.example.test' },
            { label: 'name', username: 'user', ownerId: 'foreign' },
            { label: 'name' },
          ]) {
            const response = await patch(first.id, payload);
            assert.equal(response.statusCode, 400);
            assert.deepEqual(response.json(), { error: 'Check the credential fields.' });
          }
          for (const rejected of [
            { ...headers, host: 'other.example:4310' },
            { ...headers, origin: 'https://other.example' },
            { ...headers, 'sec-fetch-site': 'cross-site' },
          ]) {
            const response = await app.inject({
              method: 'PATCH',
              url: `/api/vault/${first.id}`,
              headers: rejected,
              payload: { label: 'wrong', username: 'wrong' },
            });
            assert.equal(response.statusCode, 403);
            assert.equal(response.headers['cache-control'], 'no-store');
          }
          const foreign = await save('Foreign');
          await pool.query('UPDATE vault_entries SET owner_id=$2 WHERE id=$1', [
            foreign.id,
            'other-owner',
          ]);
          for (const id of [foreign.id, randomUUID()])
            assert.equal((await patch(id, { label: 'wrong', username: 'wrong' })).statusCode, 404);
          assert.equal(
            (await patch('invalid', { label: 'wrong', username: 'wrong' })).statusCode,
            400,
          );
          assert.equal((await read(first.id, 'details')).json().label, 'Updated');
          assert.equal((await read(first.id, 'password')).json().password, 'replacement-secret');
        },
      );
      await t.test(
        'unavailable keys and corrupted ciphertext fail without overwriting the entry',
        async () => {
          await app.close();
          app = await start(async () => {
            throw new Error('private-key-failure');
          });
          const unavailable = await patch(first.id, {
            label: 'wrong',
            username: 'wrong',
            password: 'new-secret',
          });
          assert.equal(unavailable.statusCode, 503);
          assert.doesNotMatch(unavailable.body, /private-key-failure|new-secret/);
          await app.close();
          app = await start();
          const corrupt = await save('Corrupt');
          await pool.query('UPDATE vault_entries SET ciphertext=$2 WHERE id=$1', [
            corrupt.id,
            'invalid-ciphertext',
          ]);
          const response = await patch(corrupt.id, {
            label: 'wrong',
            username: 'wrong',
            password: 'new-secret',
          });
          assert.equal(response.statusCode, 500);
          assert.deepEqual(response.json(), { error: 'This saved login could not be opened.' });
          assert.equal(
            (await pool.query('SELECT label FROM vault_entries WHERE id=$1', [corrupt.id])).rows[0]
              .label,
            'Corrupt',
          );
        },
      );
      await t.test(
        'key access races recheck ownership and preserve the latest password',
        async () => {
          for (const change of ['password', 'owner', 'delete']) {
            const entry = await save(`Race-${change}`);
            await app.close();
            let release!: (value: Buffer) => void;
            let started!: () => void;
            const reached = new Promise<void>((resolve) => {
              started = resolve;
            });
            const waiting = new Promise<Buffer>((resolve) => {
              release = resolve;
            });
            app = await start(async () => {
              started();
              return waiting;
            });
            const pending = patch(entry.id, {
              label: 'Race updated',
              username: 'edited-user',
              password: '',
            }).then((value) => value);
            await reached;
            if (change === 'password')
              await pool.query('UPDATE vault_entries SET ciphertext=$2 WHERE id=$1', [
                entry.id,
                sealCredential(
                  key,
                  { id: entry.id, owner_id: 'local-development', origin: entry.origin },
                  { username: 'concurrent-user', password: 'latest-password' },
                ),
              ]);
            else if (change === 'owner')
              await pool.query('UPDATE vault_entries SET owner_id=$2 WHERE id=$1', [
                entry.id,
                'other-owner',
              ]);
            else await pool.query('DELETE FROM vault_entries WHERE id=$1', [entry.id]);
            release(key);
            const response = await pending;
            assert.equal(response.statusCode, change === 'password' ? 200 : 404);
            if (change === 'password') {
              assert.equal((await read(entry.id, 'password')).json().password, 'latest-password');
              assert.equal((await read(entry.id, 'details')).json().username, 'edited-user');
            }
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
