import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { createVault } from '../src/server/vault.ts';
import { requestCredentials } from './vault-fixture.ts';

const owner = 'local-development';
const input = { origin: 'https://example.test', label: 'Synthetic login', kind: 'otp' as const };

async function fixture(t: TestContext) {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `vault_fencing_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await pool.query(`CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz);
    CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid REFERENCES threads(id),
    source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text)`);
  const threadId = randomUUID();
  await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [threadId, owner]);
  let injections = 0;
  const resumes: string[] = [];
  const retries: string[] = [];
  const vault = await createVault(pool, {
    keyStore: { id: 'fixture', configured: true, getKey: async () => randomBytes(32) },
    inject: async () => {
      injections++;
    },
    resume: async (turnId) => {
      resumes.push(turnId);
    },
    retry: async (turnId) => {
      retries.push(turnId);
    },
  });
  vault.registerRoutes(app);
  const turn = async () => {
    const turnId = randomUUID();
    await pool.query('INSERT INTO turns(id,thread_id,owner_id) VALUES($1,$2,$3)', [
      turnId,
      threadId,
      owner,
    ]);
    return { threadId, turnId };
  };
  return { pool, app, vault, turn, injections: () => injections, resumes, retries };
}

test(
  'Vault reads, submissions, retries and deferred resumes require the same credential wait',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await fixture(t);
    for (const [status, reason] of [
      ['running', null],
      ['failed', null],
      ['cancelled', null],
      ['succeeded', null],
      ['waiting', 'question'],
    ]) {
      const turn = await f.turn();
      const request = await requestCredentials(f.vault, f.pool, turn, owner, input);
      const route = request.url.replace('/vault/', '/api/credential-requests/');
      const requestId = (
        await f.pool.query('SELECT id FROM credential_requests WHERE turn_id=$1', [turn.turnId])
      ).rows[0].id;
      await f.pool.query('UPDATE turns SET status=$2,waiting_reason=$3 WHERE id=$1', [
        turn.turnId,
        status,
        reason,
      ]);
      assert.equal((await f.app.inject({ url: route })).json().status, 'expired');
      for (const endpoint of ['', '/refresh', '/method', '/saved']) {
        const response = await f.app.inject({
          method: 'POST',
          url: route + endpoint,
          payload:
            endpoint === '/method'
              ? { methodId: 'synthetic' }
              : endpoint === '/saved'
                ? { entryId: randomUUID() }
                : { code: '123456' },
        });
        assert.equal(response.statusCode, 409, `${status}${endpoint}: ${response.body}`);
      }
      assert.deepEqual(await f.vault.submitChatCode(owner, turn.turnId, '123456', requestId), {
        status: 'unavailable',
      });
      await f.pool.query(
        'UPDATE credential_requests SET expires_at=now(),resume_pending=true WHERE id=$1',
        [requestId],
      );
      assert.equal(
        (await f.app.inject({ method: 'POST', url: route + '/retry', payload: {} })).statusCode,
        409,
      );
      await f.vault.resumePending();
      assert.equal(
        (
          await f.pool.query('SELECT resume_pending FROM credential_requests WHERE id=$1', [
            requestId,
          ])
        ).rows[0].resume_pending,
        false,
      );
    }
    assert.equal(f.injections(), 0);
    assert.deepEqual(f.resumes, []);
    assert.deepEqual(f.retries, []);
  },
);

test(
  'a new credential request serializes old submission and expires its superseded form',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const original = await f.turn();
    const request = await requestCredentials(f.vault, f.pool, original, owner, input);
    const route = request.url.replace('/vault/', '/api/credential-requests/');
    const next = await f.turn();
    const gate = await f.pool.connect();
    const lockKey = `fixture:${randomUUID()}`;
    await gate.query("SELECT pg_advisory_lock(hashtextextended(current_schema() || ':' || $1,0))", [
      lockKey,
    ]);
    await f.pool.query(`CREATE FUNCTION hold_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.turn_id='${next.turnId}'::uuid THEN PERFORM pg_advisory_xact_lock(hashtextextended(current_schema() || ':' || '${lockKey}',0)); END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER hold_request BEFORE INSERT ON credential_requests FOR EACH ROW EXECUTE FUNCTION hold_request()`);
    const creating = requestCredentials(f.vault, f.pool, next, owner, input);
    let submitting: Promise<{ statusCode: number }> | undefined;
    try {
      const deadline = Date.now() + 3000;
      while (true) {
        const held = await f.pool.query(
          `SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted
        AND objid=(hashtextextended(current_schema() || ':' || $1,0) & 4294967295)::oid`,
          [lockKey],
        );
        if (held.rowCount) break;
        assert.ok(Date.now() < deadline, 'The new request must hold the shared thread lock.');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      submitting = f.app.inject({ method: 'POST', url: route, payload: { code: '123456' } });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(f.injections(), 0);
      await gate.query(
        "SELECT pg_advisory_unlock(hashtextextended(current_schema() || ':' || $1,0))",
        [lockKey],
      );
      await creating;
      assert.ok(submitting);
      assert.equal((await submitting).statusCode, 409);
      assert.equal((await f.app.inject({ url: route })).json().status, 'expired');
      assert.equal(f.injections(), 0);
      assert.deepEqual(f.resumes, []);
    } finally {
      await gate.query('SELECT pg_advisory_unlock_all()');
      gate.release();
      await Promise.allSettled([creating, submitting]);
    }
  },
);
