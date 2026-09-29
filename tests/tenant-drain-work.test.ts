import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { createTenantDrain } from '../src/server/tenant-drain.ts';
import { createWorkAdmission, createWorkConsumers } from '../src/server/work-admission.ts';
import { createChannels } from '../src/server/channels.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(check: () => Promise<boolean> | boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error('The fixture condition did not complete.');
}

test(
  'deployment drain includes queued callbacks before model start and preserves natural completion and resume',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_drain_${suffix}`;
    const bossSchema = `test_drain_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    url.searchParams.set('application_name', schema);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const thread = await import('../src/server/thread.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { dataRoot } = await import('../src/server/config.ts');
    const admission = createWorkAdmission();
    const consumers = createWorkConsumers();
    const drain = createTenantDrain({ admission, consumers });
    const finish = gate();
    const signals = new Map<string, AbortSignal>();
    const threadIds = new Set<string>();
    const blocker = await db.pool.connect();
    const blocked = async () =>
      Boolean(
        (
          await admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM turns WHERE thread_id=%'",
            [schema],
          )
        ).rowCount,
      );
    const state = async (id: string) =>
      (await db.pool.query('SELECT status FROM turns WHERE id=$1', [id])).rows[0].status;
    const submit = async (text: string) => {
      const result = await thread.submitUserMessage(text);
      threadIds.add(result.threadId);
      return result.turnId;
    };
    try {
      await db.initializeDatabase();
      await thread.initializeThreads();
      await createPersonalService({
        pool: db.pool,
        ownerId: 'local-development',
        scheduler: thread.boss,
        enqueueTurn: thread.enqueueTurn,
        refresh() {},
      }).initialize({ workers: false });
      const first = await submit('Synthetic held natural-drain turn');
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM turns WHERE id=$1 FOR UPDATE', [first]);
      await thread.startThreadWorkers({
        consumers,
        async runTurn(context) {
          signals.set(context.turnId, context.signal);
          if (context.turnId === first) await finish.promise;
          if (context.prompt === 'Synthetic running shutdown turn')
            await new Promise<void>((resolve) =>
              context.signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          return { status: 'succeeded' };
        },
        speech: {
          synthesize: async () => {
            throw new Error('Unused fixture.');
          },
        },
        requestCredential: async () => ({ url: '/vault/fixture' }),
        integration: async () => ({}),
        manage: async () => ({}),
      });
      await waitFor(blocked);
      assert.equal(signals.size, 0);
      const input = {
        nonce: randomUUID(),
        targetRelease: 'a'.repeat(40),
        deadline: Date.now() + 10_000,
      };
      let received = false;
      const receipt = drain.prepare(input).then(() => {
        received = true;
      });
      await delay(20);
      assert.equal(received, false);
      await blocker.query('COMMIT');
      await waitFor(() => signals.has(first));
      assert.equal(signals.get(first)!.aborted, false);
      assert.equal(received, false);
      const second = await submit('Synthetic queued-during-drain turn');
      await delay(100);
      assert.equal(signals.has(second), false);
      assert.equal(await state(second), 'queued');
      finish.resolve();
      await receipt;
      assert.equal(signals.get(first)!.aborted, false);
      assert.equal(await state(first), 'succeeded');
      assert.equal(await state(second), 'queued');
      await drain.resume(input);
      await waitFor(async () => (await state(second)) === 'succeeded');
      assert.equal(signals.get(second)!.aborted, false);
      const running = await submit('Synthetic running shutdown turn');
      await waitFor(() => signals.has(running));
      const queued = await submit('Synthetic shutdown-before-start turn');
      admission.close();
      await Promise.all([consumers.close(), thread.stopThreadWorkers()]);
      assert.equal(signals.has(queued), false);
      assert.equal(await state(queued), 'queued');
      assert.equal(signals.get(running)!.aborted, true);
      assert.equal(await state(running), 'running');
      await assert.rejects(consumers.resume());
      assert.throws(() => admission.resume());
    } finally {
      finish.resolve();
      await blocker.query('ROLLBACK');
      blocker.release();
      await thread.stopThreadWorkers();
      await consumers.close();
      await db.pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.query(`DROP SCHEMA ${bossSchema} CASCADE`);
      await admin.end();
      await Promise.all(
        [...threadIds].map((id) =>
          rm(join(dataRoot, 'workspaces', id), { recursive: true, force: true }),
        ),
      );
    }
  },
);

test(
  'channel drain pauses new polling while an accepted inbox batch finishes without replay',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15_000 },
  async () => {
    const schema = `test_channel_drain_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      `CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text,archived_at timestamptz); CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text,channel text); CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text,role text,text text,thread_id uuid,turn_id uuid,attachments jsonb DEFAULT '[]')`,
    );
    const admission = createWorkAdmission();
    const consumers = createWorkConsumers();
    const drain = createTenantDrain({ admission, consumers });
    const poll = gate();
    const submit = gate();
    let polls = 0;
    let submissions = 0;
    let refreshed = () => {};
    const channels = await createChannels(pool, {
      admission,
      ownerId: 'fixture-owner',
      intervalMs: 60_000,
      transport: {
        channels: [
          {
            id: 'telegram',
            status: 'configured',
            missing: [],
            accountId: 'fixture-account',
            allowedSenderIds: ['fixture-owner'],
          },
        ],
        receive: async () => ({ status: 200, body: 'accepted' }),
        poll: async (accept) => {
          polls++;
          if (polls !== 1) return;
          await poll.promise;
          await accept({
            channelId: 'telegram',
            accountId: 'fixture-account',
            senderId: 'fixture-owner',
            messageId: 'fixture-message',
            threadId: 'fixture-thread',
            text: 'Synthetic drain message',
            sentAt: new Date(),
          });
        },
        post: async () => {
          throw new Error('No fixture message may be sent.');
        },
        close: async () => {},
      },
      submit: async (_text, _sourceId, client) => {
        submissions++;
        await submit.promise;
        const id = randomUUID();
        await client.query('INSERT INTO turns(id) VALUES($1)', [id]);
        return id;
      },
      subscribe: (listener) => {
        refreshed = listener;
        return () => {};
      },
    });
    try {
      const running = channels.drain();
      await waitFor(() => polls === 1);
      const input = {
        nonce: randomUUID(),
        targetRelease: 'b'.repeat(40),
        deadline: Date.now() + 10_000,
      };
      let received = false;
      const receipt = drain.prepare(input).then(() => {
        received = true;
      });
      assert.equal(admission.pending, 1);
      refreshed();
      await channels.drain();
      assert.equal(polls, 1);
      poll.resolve();
      await waitFor(() => submissions === 1);
      assert.equal(received, false);
      submit.resolve();
      await Promise.all([running, receipt]);
      assert.equal(admission.pending, 0);
      assert.equal(polls, 1);
      await drain.resume(input);
      await channels.drain();
      assert.equal(polls, 2);
      assert.equal(submissions, 1);
      assert.equal(
        (await pool.query('SELECT state FROM channel_inbox')).rows[0].state,
        'submitted',
      );
      admission.close();
      refreshed();
      await channels.drain();
      assert.equal(polls, 2);
    } finally {
      poll.resolve();
      submit.resolve();
      await channels.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
