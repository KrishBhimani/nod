import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { RuntimeContext } from '../src/ports/agent.ts';

test(
  'message replies, two-way reactions and targeted inspection preserve one owned conversation',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_conversation_${suffix}`;
    const bossSchema = `test_conversation_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { createAgentReactionService } = await import('../src/server/agent-reactions.ts');
    const { configuration, ownerId, port, dataRoot } = await import('../src/server/config.ts');
    const personal = createPersonalService({
      pool: db.pool,
      ownerId,
      scheduler: tasks.boss,
      submitTask: tasks.submitTask,
      refresh() {},
    });
    const app = await createApp({
      configuration: () => ({ ...configuration(), llmReady: true, inspectorEnabled: true }),
    });
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    const request = (method: 'GET' | 'POST', path: string, payload?: Record<string, unknown>) =>
      app.inject({ method, url: path, headers, payload });
    const waitFor = async (predicate: () => Promise<boolean>) => {
      for (let i = 0; i < 100; i++) {
        if (await predicate()) return;
        await delay(50);
      }
      throw new Error('Conversation fixture did not complete.');
    };
    try {
      await db.initializeDatabase();
      await tasks.initializeTasks();
      await personal.initialize({ workers: false });
      const original = await tasks.submitTask('Original conversation');
      await tasks.reply(original, 'A helpful original answer.');
      await db.pool.query("UPDATE tasks SET status='succeeded' WHERE id=$1", [original]);
      const assistantId = (
        await db.pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='assistant'", [
          original,
        ])
      ).rows[0].id as string;
      const userId = (
        await db.pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='user'", [original])
      ).rows[0].id as string;
      const hidden = await tasks.submitTask('Another channel fixture', [], undefined, false, {
        channel: 'telegram:fixture',
      });
      await tasks.reply(hidden, 'Hidden channel reply.');
      const hiddenId = (
        await db.pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='assistant'", [
          hidden,
        ])
      ).rows[0].id as string;
      const foreign = randomUUID();
      const foreignMessage = randomUUID();
      await db.pool.query(
        "INSERT INTO tasks(id,owner_id,title,prompt,status) VALUES($1,'other','Foreign fixture','Foreign fixture','succeeded')",
        [foreign],
      );
      await db.pool.query(
        "INSERT INTO messages(id,owner_id,task_id,role,text) VALUES($1,'other',$2,'assistant','Foreign fixture')",
        [foreignMessage, foreign],
      );
      const sent = await request('POST', '/api/messages', {
        text: 'Follow up with an explanation',
        replyToMessageId: assistantId,
      });
      assert.equal(sent.statusCode, 200, sent.body);
      assert.equal(sent.json().taskId, original);
      const state = (await request('GET', '/api/state')).json();
      assert.equal(
        state.tasks.find((task: { id: string }) => task.id === original).showTyping,
        true,
      );
      assert.equal(
        state.tasks.find((task: { id: string }) => task.id === hidden).showTyping,
        false,
      );
      assert.equal(
        state.messages.some((message: { id: string }) => message.id === hiddenId),
        false,
      );
      assert.equal(
        state.messages.some((message: { id: string }) => message.id === foreignMessage),
        false,
      );
      const quoted = state.messages.find(
        (message: { replyToMessageId?: string }) => message.replyToMessageId === assistantId,
      );
      assert.deepEqual(quoted.replyTo, {
        id: assistantId,
        role: 'assistant',
        text: 'A helpful original answer.',
      });
      for (const id of [userId, hiddenId, foreignMessage, randomUUID()]) {
        assert.equal(
          (await request('POST', `/api/messages/${id}/reaction`, { reaction: 'heart' })).statusCode,
          404,
        );
      }
      await db.pool.query("UPDATE tasks SET status='cancelled' WHERE status='queued'");
      await tasks.boss.deleteAllJobs('assistant-task');
      for (let i = 0; i < 2; i++)
        assert.equal(
          (await request('POST', `/api/messages/${assistantId}/reaction`, { reaction: 'heart' }))
            .statusCode,
          200,
        );
      const reactionTasks = await db.pool.query(
        "SELECT id,source,prompt FROM tasks WHERE source_id LIKE 'reaction:%'",
      );
      assert.equal(reactionTasks.rowCount, 1);
      assert.equal(reactionTasks.rows[0].source, 'event');
      assert.equal(
        (await request('GET', `/api/tasks/${reactionTasks.rows[0].id}`)).json().showTyping,
        false,
      );
      assert.equal(
        (await request('POST', `/api/messages/${assistantId}/reaction`, { reaction: null }))
          .statusCode,
        200,
      );
      assert.equal(
        (await db.pool.query("SELECT id FROM tasks WHERE source_id LIKE 'reaction:%'")).rowCount,
        1,
      );
      const inspected = await request('GET', `/api/inspector?taskId=${original}`);
      assert.equal(inspected.statusCode, 200);
      assert.deepEqual(
        inspected.json().tasks.map((task: { id: string }) => task.id),
        [original],
      );
      assert.equal((await request('GET', `/api/inspector?taskId=${foreign}`)).statusCode, 404);
      assert.equal((await request('GET', '/api/inspector?taskId=bad')).statusCode, 400);
      const seen: RuntimeContext[] = [];
      const reactions = createAgentReactionService({ pool: db.pool, ownerId, refresh() {} });
      await tasks.startTaskWorkers({
        reactToMessage: reactions.react,
        runTask: async (context) => {
          seen.push(context);
          if (!context.background) {
            assert.ok(context.currentMessageId);
            await context.reactToMessage!(context.currentMessageId, 'like');
            await assert.rejects(context.reactToMessage!(assistantId, 'like'), /cannot receive/);
            await assert.rejects(
              context.reactToMessage!(foreignMessage, 'heart'),
              /not in this conversation/,
            );
            await assert.rejects(
              context.reply('Wrong target', undefined, hiddenId),
              /not in this conversation/,
            );
            await context.reply('Useful response.', undefined, context.currentMessageId);
          }
          return { status: 'succeeded' };
        },
        speech: {
          synthesize: async () => {
            throw new Error('Unused');
          },
        },
        requestCredential: async () => ({}),
        integration: async () => ({}),
        manage: async () => ({}),
      });
      const next = await tasks.submitTask('React fixture user');
      await waitFor(
        async () =>
          (
            await db.pool.query(
              "SELECT count(*)::int AS count FROM tasks WHERE id=ANY($1::uuid[]) AND status='succeeded'",
              [[next, reactionTasks.rows[0].id]],
            )
          ).rows[0].count === 2,
      );
      assert.equal(
        seen.some((context) => context.background),
        true,
      );
      const reacted = (await request('GET', '/api/state'))
        .json()
        .messages.find((message: { text: string }) => message.text === 'React fixture user');
      assert.deepEqual(reacted.reactions, [{ actor: 'assistant', reaction: '👍' }]);
      assert.equal(
        (await db.pool.query("SELECT id FROM tasks WHERE source_id LIKE 'reaction:%'")).rowCount,
        1,
      );
      assert.equal(
        (
          await db.pool.query('SELECT id FROM messages WHERE task_id=$1', [
            reactionTasks.rows[0].id,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (await db.pool.query("SELECT id FROM messages WHERE text='Wrong target'")).rowCount,
        0,
      );
    } finally {
      await app.close();
      await tasks.stopTasks();
      const ids = (await db.pool.query('SELECT id FROM tasks')).rows.map((row) => row.id as string);
      await db.pool.end();
      for (const id of ids)
        await rm(join(dataRoot, 'workspaces', id), { recursive: true, force: true });
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
