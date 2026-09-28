import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';

test(
  'execution failures report once through normal messages while obsolete and cancelled segments stay quiet',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_failures_${suffix}`;
    const bossSchema = `test_failures_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { createChannels } = await import('../src/server/channels.ts');
    const { dataRoot } = await import('../src/server/config.ts');
    const app = Fastify();
    const held = new Map<string, () => void>();
    const attempted = new Set<string>();
    const diagnostics: Array<{ taskId: string; revision: number; error: unknown }> = [];
    const sent: Array<{ text: string; threadId: string }> = [];
    let channels: Awaited<ReturnType<typeof createChannels>> | undefined;
    const waitFor = async (check: () => Promise<boolean> | boolean) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (await check()) return;
        await delay(20);
      }
      throw new Error('Fixture condition did not complete.');
    };
    const row = async (id: string) =>
      (await db.pool.query('SELECT * FROM tasks WHERE id=$1', [id])).rows[0];
    const messages = async (id: string) =>
      (
        await db.pool.query(
          "SELECT * FROM messages WHERE task_id=$1 AND role='assistant' ORDER BY created_at,id",
          [id],
        )
      ).rows;
    try {
      await db.initializeDatabase();
      await tasks.initializeTasks();
      await createPersonalService({
        pool: db.pool,
        ownerId: 'local-development',
        scheduler: tasks.boss,
        submitTask: tasks.submitTask,
        refresh() {},
      }).initialize({ workers: false });
      await tasks.startTaskWorkers({
        async runTask(context) {
          attempted.add(context.taskId);
          if (context.prompt.startsWith('held:'))
            await new Promise<void>((resolve) => held.set(context.taskId, resolve));
          if (context.prompt.startsWith('write:')) await context.startExternalAction!();
          throw new Error('PRIVATE-FIXTURE-KEY provider implementation /private/fixture/path');
        },
        recordFailure: async (taskId, revision, error) => {
          diagnostics.push({ taskId, revision, error });
          return new Promise<void>(() => {});
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
      await t.test(
        'setup failures before the runtime starts create a concise persisted reply',
        async () => {
          const artifactId = randomUUID();
          await db.pool.query(
            'INSERT INTO artifacts(id,owner_id,name,mime_type,size,storage_path) VALUES($1,$2,$3,$4,1,$5)',
            [
              artifactId,
              'local-development',
              'unavailable.txt',
              'text/plain',
              join(dataRoot, 'artifacts', `missing-${artifactId}`),
            ],
          );
          const id = await tasks.submitTask('Read the synthetic unavailable attachment', [
            {
              id: artifactId,
              name: 'unavailable.txt',
              mimeType: 'text/plain',
              size: 1,
              url: `/api/artifacts/${artifactId}`,
            },
          ]);
          await waitFor(async () => (await row(id)).status === 'failed');
          assert.equal(attempted.has(id), false);
          const replies = await messages(id);
          assert.equal(replies.length, 1);
          assert.equal(replies[0].text, 'I couldn’t finish that.');
          assert.equal(replies[0].stream_id, `failure:${id}:0`);
          assert.equal(replies[0].owner_id, 'local-development');
        },
      );
      await t.test(
        'duplicate delivery and a retry of a read-only failure preserve the original failed segment',
        async () => {
          const id = await tasks.submitTask('Fail the synthetic request');
          await waitFor(async () => (await row(id)).status === 'failed');
          assert.equal((await row(id)).external_action, false);
          const first = (await messages(id))[0];
          await tasks.boss.send('assistant-task', { taskId: id, revision: 0 }, { retryLimit: 0 });
          await delay(650);
          assert.equal((await messages(id)).length, 1);
          const retried = await tasks.submitUserMessage('Retry the synthetic request', [], {
            replyToMessageId: first.id,
          });
          assert.equal(retried.continued, false);
          assert.notEqual(retried.taskId, id);
          assert.equal((await row(retried.taskId)).title, 'Retry the synthetic request');
          await waitFor(async () => (await row(retried.taskId)).status === 'failed');
          const replies = await messages(id);
          assert.deepEqual(
            replies.map((item) => item.stream_id),
            [`failure:${id}:0`],
          );
          assert.equal((await row(id)).revision, 0);
          assert.equal(
            (await db.pool.query('SELECT id FROM pending_task_inputs WHERE task_id=$1', [id]))
              .rowCount,
            0,
          );
          const publicData = JSON.stringify({
            task: await row(id),
            messages: replies,
            events: (await db.pool.query('SELECT * FROM task_events WHERE task_id=$1', [id])).rows,
          });
          assert.equal(publicData.includes('PRIVATE-FIXTURE-KEY'), false);
          assert.equal(publicData.includes('/private/fixture/path'), false);
          assert.ok(diagnostics.some((item) => item.taskId === id && item.revision === 0));
        },
      );
      await t.test('a failure after a started outside action stays blocked', async () => {
        const id = await tasks.submitTask('write:Send the synthetic confirmation');
        await waitFor(async () => (await row(id)).status === 'failed');
        assert.equal((await row(id)).external_action, true);
        const first = (await messages(id))[0];
        for (const target of [{ replyToMessageId: first.id }, { taskId: id }])
          await assert.rejects(tasks.submitUserMessage('Try again', [], target), {
            statusCode: 409,
            code: 'task_review_required',
            taskId: id,
            summary: 'write:Send the synthetic confirmation',
          });
        assert.equal((await row(id)).revision, 0);
        assert.equal((await messages(id)).length, 1);
      });
      await t.test(
        'an already accepted follow-up remains held when its active segment fails',
        async () => {
          const id = await tasks.submitTask('held:synthetic work with a queued follow-up');
          await waitFor(() => held.has(id));
          await tasks.submitUserMessage('Add the synthetic supporting detail', [], { taskId: id });
          held.get(id)!();
          await waitFor(async () => (await row(id)).status === 'failed');
          await delay(100);
          assert.equal((await row(id)).revision, 0);
          assert.deepEqual(
            (await db.pool.query('SELECT state FROM pending_task_inputs WHERE task_id=$1', [id]))
              .rows,
            [{ state: 'pending' }],
          );
          assert.equal(
            (
              await db.pool.query(
                `SELECT id FROM ${bossSchema}.job WHERE name='assistant-task' AND data->>'taskId'=$1 AND (data->>'revision')::int>0`,
                [id],
              )
            ).rowCount,
            0,
          );
          assert.equal((await messages(id)).length, 1);
        },
      );
      await t.test(
        'cancelled, superseded, reset and no-longer-owned failures cannot publish',
        async () => {
          for (const mode of ['cancel', 'revision', 'owner', 'reset']) {
            const id = await tasks.submitTask(`held:${mode}`);
            await waitFor(() => held.has(id));
            if (mode === 'cancel') await tasks.cancelTask(id);
            if (mode === 'revision')
              await db.pool.query('UPDATE tasks SET revision=revision+1 WHERE id=$1', [id]);
            if (mode === 'owner')
              await db.pool.query("UPDATE tasks SET owner_id='foreign-owner' WHERE id=$1", [id]);
            if (mode === 'reset') await tasks.resetConversation();
            const before = diagnostics.length;
            held.get(id)!();
            await delay(75);
            assert.deepEqual(await messages(id), []);
            assert.equal(diagnostics.length, before);
            if (mode === 'revision') await tasks.cancelTask(id);
          }
        },
      );
      await t.test(
        'background failures stay quiet while private diagnostics cannot block completion',
        async () => {
          const id = await tasks.submitTask('Synthetic quiet review failure', [], undefined, true, {
            source: 'event',
          });
          await waitFor(async () => (await row(id)).status === 'failed');
          assert.deepEqual(await messages(id), []);
          assert.ok(diagnostics.some((item) => item.taskId === id));
        },
      );
      await t.test(
        'channel failures enter the existing outbox and are delivered only once to the same thread',
        async () => {
          channels = await createChannels(db.pool, {
            ownerId: 'local-development',
            intervalMs: 60_000,
            transport: {
              channels: [
                {
                  id: 'telegram',
                  status: 'configured',
                  missing: [],
                  accountId: 'fixture-bot',
                  allowedSenderIds: ['fixture-owner'],
                },
              ],
              receive: async () => ({
                status: 200,
                body: 'ok',
                messages: [
                  {
                    channelId: 'telegram',
                    accountId: 'fixture-bot',
                    senderId: 'fixture-owner',
                    messageId: 'failure-message',
                    threadId: 'fixture-dm',
                    text: 'Synthetic channel failure',
                    sentAt: new Date(),
                  },
                ],
              }),
              post: async (input) => {
                sent.push({ text: input.text, threadId: input.threadId });
                return { id: randomUUID() };
              },
              close: async () => {},
            },
            submit: async (text, sourceId, client, channel) =>
              (await tasks.submitUserMessage(text, [], { sourceId, client, channel })).taskId,
            subscribe: () => () => {},
          });
          channels.registerRoutes(app);
          await app.inject({ method: 'POST', url: '/api/webhooks/telegram', payload: {} });
          await channels.drain();
          const id = (
            await db.pool.query(
              "SELECT task_id FROM channel_inbox WHERE source_id='channel:telegram:fixture-bot:failure-message'",
            )
          ).rows[0].task_id;
          await waitFor(async () => (await row(id)).status === 'failed');
          await channels.drain();
          await app.inject({ method: 'POST', url: '/api/webhooks/telegram', payload: {} });
          await channels.drain();
          assert.deepEqual(sent, [{ text: 'I couldn’t finish that.', threadId: 'fixture-dm' }]);
          assert.equal((await db.pool.query('SELECT * FROM channel_outbox')).rowCount, 1);
        },
      );
    } finally {
      for (const release of held.values()) release();
      await channels?.close();
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
