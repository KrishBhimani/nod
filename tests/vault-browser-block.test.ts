import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type { LoginInspection } from '../src/ports/computer.ts';
import { createVault } from '../src/server/vault.ts';
import type { TurnRef } from '../src/server/thread.ts';

async function seedTurns(pool: pg.Pool, names: string[], owner = 'local-development') {
  await pool.query(
    'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
  );
  await pool.query(
    "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text)",
  );
  const threadId = randomUUID();
  await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [threadId, owner]);
  const turns: Record<string, TurnRef> = {};
  for (const name of names) {
    const turnId = randomUUID();
    await pool.query('INSERT INTO turns(id,owner_id,thread_id) VALUES($1,$2,$3)', [
      turnId,
      owner,
      threadId,
    ]);
    turns[name] = { threadId, turnId };
  }
  return turns;
}

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
      const turns = await seedTurns(pool, ['new', 'refresh', 'submit', 'method', 'saved']);
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
      await assert.rejects(vault.request(turns.new, 'local-development', input), isBlocked);
      await assert.rejects(
        vault.fillSaved(turns.saved, 'local-development', saved.json().id, input),
        isBlocked,
      );
      for (const [id, suffix, payload] of [
        ['refresh', '/refresh', {}],
        ['submit', '', { password: 'fixture-password' }],
        ['method', '/method', { methodId: 'oauth-google' }],
      ] as const) {
        blocked = false;
        const request = await vault.request(turns[id], 'local-development', input);
        await pool.query(
          "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1",
          [turns[id].turnId],
        );
        blocked = true;
        const response = await app.inject({
          method: 'POST',
          url: `${request.url.replace('/vault/', '/api/credential-requests/')}${suffix}`,
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
        (await pool.query('SELECT 1 FROM credential_requests WHERE turn_id=$1', [turns.new.turnId]))
          .rowCount,
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
