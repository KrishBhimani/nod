import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { RuntimeContext } from '../src/ports/agent.ts';
import type { ThreadDependencies } from '../src/server/thread.ts';

test(
  'one thread runs every turn in order on the same session and workspace',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_thread_${suffix}`;
    const bossSchema = `test_boss_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), 'thread-test-'));
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = databaseUrl.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    process.env.OTTO_DATA_ROOT = root;
    const db = await import('../src/server/db.ts');
    const thread = await import('../src/server/thread.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { configuration, dataRoot, port } = await import('../src/server/config.ts');
    const { storeArtifact } = await import('../src/server/artifacts.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const personal = createPersonalService({
      pool: db.pool,
      ownerId: 'local-development',
      scheduler: thread.boss,
      enqueueTurn: thread.enqueueTurn,
      refresh() {},
    });
    assert.equal(dataRoot, root);

    const runs: RuntimeContext[] = [];
    const gates = new Map<string, () => void>();
    const hold = (prompt: string) =>
      new Promise<void>((resolve) => {
        gates.set(prompt, resolve);
      });
    const waiting = new Map<string, Promise<void>>();
    const stagedReads = new Map<string, string>();
    const workspaceListings = new Map<string, string[]>();
    const abortedPrompts = new Set<string>();

    const dependencies: ThreadDependencies = {
      speech: {
        synthesize: async () => {
          throw new Error('Unused fixture');
        },
      },
      requestCredential: async () => {
        throw new Error('Unused fixture');
      },
      integration: async () => {
        throw new Error('Unused fixture');
      },
      manage: async () => {
        throw new Error('Unused fixture');
      },
      runTurn: async (context) => {
        runs.push(context);
        const gate = waiting.get(context.prompt);
        if (gate) {
          await Promise.race([
            gate,
            new Promise<void>((resolve) =>
              context.signal.addEventListener('abort', () => resolve(), { once: true }),
            ),
          ]);
          if (context.signal.aborted) {
            abortedPrompts.add(context.prompt);
            throw new Error('Aborted fixture');
          }
        }
        if (context.attachments.length)
          stagedReads.set(context.prompt, await readFile(context.attachments[0].path, 'utf8'));
        workspaceListings.set(context.prompt, await readdir(context.workspacePath));
        if (context.prompt === 'runtime-failure') throw new Error('Synthetic runtime failure');
        if (context.prompt === 'ask-question') {
          await context.waitForUser!('Which account should I use?');
          return { status: 'waiting_user' };
        }
        await context.reply(`done: ${context.prompt}`);
        return { status: 'succeeded' };
      },
    };

    const block = (prompt: string) => waiting.set(prompt, hold(prompt));
    const release = (prompt: string) => gates.get(prompt)?.();

    async function waitFor(predicate: () => Promise<boolean> | boolean, timeout = 15_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await delay(20);
      }
      assert.fail('The thread fixture did not reach the expected state.');
    }
    const turnStatus = async (turnId: string) =>
      (await db.pool.query('SELECT status FROM turns WHERE id=$1', [turnId])).rows[0]?.status as
        string | undefined;
    const settled = (turnId: string) => async () =>
      ['succeeded', 'waiting', 'failed', 'cancelled'].includes((await turnStatus(turnId)) ?? '');
    const ran = (turnId: string) => runs.find((context) => context.turnId === turnId);

    const app = await createApp({ configuration: () => ({ ...configuration(), llmReady: true }) });
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };

    try {
      await db.initializeDatabase();
      await thread.initializeThreads();
      await personal.initialize({ workers: false });
      await thread.startThreadWorkers(dependencies);

      let firstThreadId = '';

      await t.test('consecutive messages run as turns on the same thread', async () => {
        const first = await thread.submitUserMessage('first message', [], { channel: 'web' });
        await waitFor(settled(first.turnId));
        const second = await thread.submitUserMessage('second message', [], {
          channel: 'web',
          threadId: first.threadId,
        });
        await waitFor(settled(second.turnId));
        assert.equal(second.threadId, first.threadId);
        assert.equal(await turnStatus(first.turnId), 'succeeded');
        assert.equal(await turnStatus(second.turnId), 'succeeded');
        assert.equal(ran(first.turnId)?.threadId, first.threadId);
        assert.equal(ran(second.turnId)?.threadId, first.threadId);
        assert.equal(ran(first.turnId)?.workspacePath, ran(second.turnId)?.workspacePath);
        assert.equal(ran(first.turnId)?.currentMessageId, first.messageId);
        assert.equal(ran(second.turnId)?.currentMessageId, second.messageId);
        assert.equal(
          (await db.pool.query('SELECT count(*)::int AS count FROM threads')).rows[0].count,
          1,
        );
        firstThreadId = first.threadId;
      });

      await t.test('a message sent during a running turn queues and runs after it', async () => {
        block('slow first');
        const first = await thread.submitUserMessage('slow first', [], { channel: 'web' });
        await waitFor(() => Boolean(ran(first.turnId)));
        const second = await thread.submitUserMessage('queued second', [], { channel: 'web' });
        const third = await thread.submitUserMessage('queued third', [], { channel: 'web' });
        await delay(700);
        assert.equal(await turnStatus(first.turnId), 'running');
        assert.equal(await turnStatus(second.turnId), 'queued');
        assert.equal(await turnStatus(third.turnId), 'queued');
        assert.equal(ran(second.turnId), undefined);
        release('slow first');
        await waitFor(settled(third.turnId));
        const order = runs.map((context) => context.turnId);
        const positions = [first.turnId, second.turnId, third.turnId].map((id) =>
          order.indexOf(id),
        );
        assert.ok(positions[0] >= 0 && positions[0] < positions[1] && positions[1] < positions[2]);
        const timing = (
          await db.pool.query(
            'SELECT id,status,started_at,finished_at FROM turns WHERE id=ANY($1::uuid[])',
            [[first.turnId, second.turnId, third.turnId]],
          )
        ).rows;
        const byId = new Map(timing.map((row) => [row.id, row]));
        assert.ok(byId.get(second.turnId).started_at >= byId.get(first.turnId).finished_at);
        assert.ok(byId.get(third.turnId).started_at >= byId.get(second.turnId).finished_at);
        assert.ok(timing.every((row) => row.status === 'succeeded'));
        assert.ok(
          [first, second, third].every((turn) => ran(turn.turnId)?.threadId === firstThreadId),
        );
      });

      await t.test(
        'an uploaded attachment stays in the thread workspace for later turns',
        async () => {
          const artifact = await storeArtifact(
            Buffer.from('synthetic attachment bytes'),
            'notes.txt',
            'text/plain',
          );
          const first = await thread.submitUserMessage('read attachment', [artifact], {
            channel: 'web',
          });
          await waitFor(settled(first.turnId));
          const staged = `${artifact.id}-notes.txt`;
          const workspace = join(root, 'workspaces', first.threadId);
          assert.equal(ran(first.turnId)?.workspacePath, workspace);
          assert.equal(ran(first.turnId)?.attachments[0]?.path, join(workspace, staged));
          assert.equal(stagedReads.get('read attachment'), 'synthetic attachment bytes');
          const second = await thread.submitUserMessage('use attachment again', [], {
            channel: 'web',
          });
          await waitFor(settled(second.turnId));
          assert.equal(ran(second.turnId)?.workspacePath, workspace);
          assert.equal(ran(second.turnId)?.attachments.length, 0);
          assert.ok(workspaceListings.get('use attachment again')?.includes(staged));
          assert.equal(
            await readFile(join(workspace, staged), 'utf8'),
            'synthetic attachment bytes',
          );
        },
      );

      await t.test('a waiting question does not block the next user message', async () => {
        const question = await thread.submitUserMessage('ask-question', [], { channel: 'web' });
        await waitFor(settled(question.turnId));
        const row = (
          await db.pool.query('SELECT status,waiting_reason FROM turns WHERE id=$1', [
            question.turnId,
          ])
        ).rows[0];
        assert.deepEqual(row, { status: 'waiting', waiting_reason: 'question' });
        assert.equal(
          (
            await db.pool.query(
              "SELECT count(*)::int AS count FROM messages WHERE turn_id=$1 AND role='assistant' AND text='Which account should I use?'",
              [question.turnId],
            )
          ).rows[0].count,
          1,
        );
        await waitFor(async () => (await thread.activeThread(db.pool)).status === 'idle');
        const answer = await thread.submitUserMessage('the work account', [], { channel: 'web' });
        await waitFor(settled(answer.turnId));
        assert.equal(await turnStatus(answer.turnId), 'succeeded');
        assert.equal(ran(answer.turnId)?.threadId, question.threadId);
        assert.ok(
          ran(answer.turnId)?.history.some(
            (message) =>
              message.role === 'assistant' && message.text === 'Which account should I use?',
          ),
        );
      });

      await t.test(
        'a runtime failure ends the turn failed with one message and no retry',
        async () => {
          const before = (await db.pool.query('SELECT count(*)::int AS count FROM turns')).rows[0]
            .count;
          const failed = await thread.submitUserMessage('runtime-failure', [], { channel: 'web' });
          await waitFor(settled(failed.turnId));
          await delay(1200);
          const row = (
            await db.pool.query('SELECT status,error FROM turns WHERE id=$1', [failed.turnId])
          ).rows[0];
          assert.equal(row.status, 'failed');
          const messages = (
            await db.pool.query(
              "SELECT text FROM messages WHERE thread_id=$1 AND role='assistant' AND created_at >= (SELECT created_at FROM turns WHERE id=$2)",
              [failed.threadId, failed.turnId],
            )
          ).rows.map((message) => message.text);
          assert.deepEqual(messages, [thread.interruptedMessage]);
          assert.equal(
            (await db.pool.query('SELECT count(*)::int AS count FROM turns')).rows[0].count,
            before + 1,
          );
          assert.equal(runs.filter((context) => context.prompt === 'runtime-failure').length, 1);
          await waitFor(async () => (await thread.activeThread(db.pool)).status === 'idle');
        },
      );

      await t.test('stop cancels the running turn and every queued turn', async () => {
        block('stop running');
        const runningTurn = await thread.submitUserMessage('stop running', [], { channel: 'web' });
        await waitFor(() => Boolean(ran(runningTurn.turnId)));
        const queued = await thread.submitUserMessage('stop queued', [], { channel: 'web' });
        const scheduled = await thread.enqueueTurn('stop scheduled', {
          source: 'schedule',
          sourceId: `schedule:${randomUUID()}`,
        });
        await thread.stopThread();
        await waitFor(() => abortedPrompts.has('stop running'));
        await delay(700);
        for (const turnId of [runningTurn.turnId, queued.turnId, scheduled])
          assert.equal(await turnStatus(turnId), 'cancelled');
        assert.equal(ran(queued.turnId), undefined);
        assert.equal(
          runs.some((context) => context.turnId === scheduled),
          false,
        );
        assert.equal(
          (
            await db.pool.query(
              'SELECT count(*)::int AS count FROM messages WHERE turn_id=ANY($1::uuid[]) AND role=$2',
              [[runningTurn.turnId, queued.turnId, scheduled], 'assistant'],
            )
          ).rows[0].count,
          0,
        );
        await waitFor(async () => (await thread.activeThread(db.pool)).status === 'idle');
        const after = await thread.submitUserMessage('after stop', [], { channel: 'web' });
        await waitFor(settled(after.turnId));
        assert.equal(await turnStatus(after.turnId), 'succeeded');
      });

      await t.test('reset archives the thread and rejects the stale thread id', async () => {
        const reset = await thread.resetThread();
        assert.equal(reset.ok, true);
        assert.notEqual(reset.threadId, firstThreadId);
        assert.ok(
          (await db.pool.query('SELECT archived_at FROM threads WHERE id=$1', [firstThreadId]))
            .rows[0].archived_at,
        );
        const state = (await app.inject({ url: '/api/state', headers })).json();
        assert.equal(state.threadId, reset.threadId);
        assert.deepEqual(state.messages, []);
        const stale = await app.inject({
          method: 'POST',
          url: '/api/messages',
          headers,
          payload: { text: 'stale message', threadId: firstThreadId },
        });
        assert.equal(stale.statusCode, 409);
        assert.equal(
          (
            await db.pool.query(
              "SELECT count(*)::int AS count FROM messages WHERE text='stale message'",
            )
          ).rows[0].count,
          0,
        );
        const staleHistory = await app.inject({
          url: `/api/messages?threadId=${firstThreadId}`,
          headers,
        });
        assert.equal(staleHistory.statusCode, 409);
        const fresh = await app.inject({
          method: 'POST',
          url: '/api/messages',
          headers,
          payload: { text: 'fresh message', threadId: reset.threadId },
        });
        assert.equal(fresh.statusCode, 200);
        const accepted = fresh.json();
        assert.equal(accepted.threadId, reset.threadId);
        await waitFor(settled(accepted.turnId));
        assert.equal(ran(accepted.turnId)?.threadId, reset.threadId);
        assert.equal(
          ran(accepted.turnId)?.history.some((message) => message.text === 'first message'),
          false,
        );
        assert.equal(ran(accepted.turnId)?.workspacePath, join(root, 'workspaces', reset.threadId));
      });
    } finally {
      for (const resolve of gates.values()) resolve();
      await thread.stopThreadWorkers();
      await app.close();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
