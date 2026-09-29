import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';

const idle = (signInAvailable: boolean) => ({
  paused: false,
  active: false,
  mode: null,
  signInAvailable,
  resumable: false,
});

test(
  'real pause and reset release manual and sign-in control without restoring or resuming',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15_000 },
  async () => {
    const schema = `test_control_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const db = await import('../src/server/db.ts');
    const { createTakeover } = await import('../src/server/takeover.ts');
    const thread = await import('../src/server/thread.ts');
    const { ownerId } = await import('../src/server/config.ts');
    const app = Fastify({ logger: false });
    const newerBrowser = randomUUID();
    let manualBrowser: string | undefined;
    let resumes = 0;
    let restorations = 0;
    const currentSession = () => manualBrowser ?? newerBrowser;
    createTakeover({
      pool: db.pool,
      ownerId,
      enabled: () => true,
      pause: thread.pauseForControl,
      resume: async () => {
        resumes++;
        return { ok: true };
      },
      waitForThread: async () => {},
      computer: {
        async openSignIn(id) {
          manualBrowser = id;
        },
        async signInScreenshot() {
          return Buffer.from('synthetic-frame');
        },
        async signInControl() {},
        async finishSignIn() {
          restorations++;
        },
        async takeControl(id) {
          manualBrowser = id;
        },
        async control() {},
        async releaseControl(id) {
          if (manualBrowser === id) manualBrowser = undefined;
        },
      },
    }).registerRoutes(app);
    try {
      await db.initializeDatabase();
      for (const route of ['start', 'sign-in']) {
        const active = await thread.activeThread(db.pool);
        const turnId = randomUUID();
        await db.pool.query(
          "INSERT INTO turns(id,owner_id,thread_id,source,prompt,channel,status) VALUES($1,$2,$3,'user','Browser fixture','web','running')",
          [turnId, ownerId, active.id],
        );
        await db.pool.query("UPDATE threads SET status='running' WHERE id=$1", [active.id]);
        const endpoint = '/api/inspector/control';
        const start = await app.inject({
          method: 'POST',
          url: `${endpoint}/${route}`,
          payload: {},
        });
        assert.equal(start.statusCode, 200);
        assert.equal(currentSession(), active.id);
        const paused = await db.pool.query('SELECT status FROM threads WHERE id=$1', [active.id]);
        assert.equal(paused.rows[0].status, 'manual_control');
        assert.equal(
          (await db.pool.query('SELECT status FROM turns WHERE id=$1', [turnId])).rows[0].status,
          'cancelled',
        );
        assert.equal((await app.inject(endpoint)).json().active, true);
        const reset = await thread.resetThread();
        assert.notEqual(reset.threadId, active.id);
        const status = await app.inject(endpoint);
        assert.deepEqual(status.json(), idle(true));
        assert.equal(currentSession(), newerBrowser);
        assert.equal(
          (await app.inject({ method: 'POST', url: `${endpoint}/resume`, payload: {} })).statusCode,
          409,
        );
      }
      assert.equal(resumes, 0);
      assert.equal(restorations, 0);
    } finally {
      await app.close();
      await db.pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
