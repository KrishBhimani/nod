import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type { LoginInspection } from '../src/ports/computer.ts';
import { createVault } from '../src/server/vault.ts';

test(
  'Vault rejects a freshly blocked browser before creating, refreshing, filling or selecting a sign-in step',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_browser_block_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    let blocked = false;
    let injections = 0;
    let selections = 0;
    let resumes = 0;
    const origin = 'https://accounts.example.com';
    const input = { origin, label: 'Synthetic sign-in', kind: 'password' as const };
    try {
      await pool.query(
        "CREATE TABLE tasks(id text PRIMARY KEY,owner_id text NOT NULL,status text NOT NULL DEFAULT 'running',revision integer NOT NULL DEFAULT 0)",
      );
      for (const id of ['new', 'refresh', 'submit', 'method', 'saved'])
        await pool.query("INSERT INTO tasks(id,owner_id) VALUES($1,'local-development')", [id]);
      const key = randomBytes(32);
      const vault = await createVault(pool, {
        keyStore: { id: 'fixture', configured: true, getKey: async () => key },
        inspect: async (): Promise<LoginInspection> => ({
          origin,
          url: `${origin}/login`,
          ...(blocked ? { issue: 'browser_not_supported' as const } : {}),
          fields: [{ kind: 'password', selector: '#password', label: 'Password' }],
          methods: [
            { id: 'credentials', kind: 'credentials', label: 'Secure form', supported: true },
            { id: 'oauth-google', kind: 'oauth', label: 'Google', supported: true },
          ],
        }),
        inject: async () => {
          injections++;
        },
        selectMethod: async () => {
          selections++;
        },
        retry: async () => {},
        resume: async () => {
          resumes++;
        },
      });
      vault.registerRoutes(app);
      const paths = new Map<string, string>();
      for (const id of ['refresh', 'submit', 'method']) {
        const request = await vault.request(id, 'local-development', input);
        paths.set(id, request.url.replace('/vault/', '/api/credential-requests/'));
        await pool.query("UPDATE tasks SET status='waiting_credentials' WHERE id=$1", [id]);
      }
      const saved = await app.inject({
        method: 'POST',
        url: '/api/vault',
        payload: {
          label: 'Synthetic',
          origin,
          username: 'synthetic@example.com',
          password: 'fixture-password',
        },
      });
      assert.equal(saved.statusCode, 200);
      blocked = true;
      const isBlocked = (error: unknown) => {
        assert.equal((error as { statusCode: number }).statusCode, 409);
        assert.match((error as Error).message, /Take control/);
        assert.match((error as Error).message, /Resume agent/);
        return true;
      };
      await assert.rejects(vault.request('new', 'local-development', input), isBlocked);
      await assert.rejects(
        vault.fillSaved('saved', 'local-development', saved.json().id, input),
        isBlocked,
      );
      for (const [id, suffix, payload] of [
        ['refresh', '/refresh', {}],
        ['submit', '', { password: 'fixture-password' }],
        ['method', '/method', { methodId: 'oauth-google' }],
      ] as const) {
        const response = await app.inject({
          method: 'POST',
          url: `${paths.get(id)}${suffix}`,
          payload,
        });
        assert.equal(response.statusCode, 409);
        assert.match(response.json().error, /Take control/);
        assert.match(response.json().error, /Resume agent/);
      }
      assert.equal(injections, 0);
      assert.equal(selections, 0);
      assert.equal(resumes, 0);
      assert.equal(
        (await pool.query("SELECT 1 FROM credential_requests WHERE task_id='new'")).rowCount,
        0,
      );
      assert.equal(
        (await pool.query("SELECT 1 FROM credential_requests WHERE status='filled'")).rowCount,
        0,
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
