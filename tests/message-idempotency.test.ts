import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { SubmitMessageResponse } from '../src/shared/contracts.ts';

test(
  'client message IDs reconcile accepted sends without repeating dispatch or accepting changed payloads',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_message_ids_${suffix}`;
    const bossSchema = `test_message_ids_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { configuration, port } = await import('../src/server/config.ts');
    let routeCalls = 0;
    const messages = tasks.createUserMessageService({
      routeConversation: async () => {
        routeCalls++;
        return {
          kind: 'new_outcome',
          title: 'Synthetic requested work',
          objective: 'Complete the synthetic requested work.',
        };
      },
    });
    const app = await createApp({
      submitMessage: messages.submit,
      configuration: () => ({ ...configuration(), llmReady: true }),
    });
    const headers = {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      'content-type': 'application/json',
    };
    const send = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/messages',
        headers,
        payload: JSON.stringify(payload),
      });
    const counts = async () => ({
      tasks: (await db.pool.query('SELECT count(*)::int AS count FROM tasks')).rows[0].count,
      messages: (await db.pool.query('SELECT count(*)::int AS count FROM messages')).rows[0].count,
      jobs: (
        await db.pool.query(
          `SELECT count(*)::int AS count FROM ${bossSchema}.job WHERE name='assistant-task'`,
        )
      ).rows[0].count,
      inputs: (await db.pool.query('SELECT count(*)::int AS count FROM pending_task_inputs'))
        .rows[0].count,
    });
    let first: SubmitMessageResponse;
    const firstMessageId = randomUUID();
    try {
      await db.initializeDatabase();
      await tasks.initializeTasks();
      await t.test(
        'concurrent identical submissions store one message, outcome, task and job',
        async () => {
          const payload = {
            clientMessageId: firstMessageId,
            text: '  Prepare the synthetic report  ',
            conversationRevision: 0,
          };
          const responses = await Promise.all([send(payload), send(payload)]);
          for (const response of responses) assert.equal(response.statusCode, 200, response.body);
          first = responses[0]!.json<SubmitMessageResponse>();
          assert.deepEqual(responses[1]!.json(), first);
          assert.equal(first.messageId, firstMessageId);
          assert.equal(first.continued, false);
          assert.deepEqual(await counts(), { tasks: 1, messages: 1, jobs: 1, inputs: 0 });
          assert.equal((await db.pool.query('SELECT * FROM outcomes')).rowCount, 1);
          assert.equal(
            (await db.pool.query('SELECT text,task_id FROM messages WHERE id=$1', [firstMessageId]))
              .rows[0].text,
            'Prepare the synthetic report',
          );
          const before = routeCalls;
          assert.deepEqual((await send(payload)).json(), first);
          assert.equal(routeCalls, before);
        },
      );
      await t.test(
        'a queued reply keeps its stable ID and repeated HTTP retries do not queue twice',
        async () => {
          const clientMessageId = randomUUID();
          const payload = {
            clientMessageId,
            text: 'Add a short conclusion to that report',
            replyToMessageId: firstMessageId,
            conversationRevision: 0,
          };
          const responses = await Promise.all([send(payload), send(payload)]);
          for (const response of responses) assert.equal(response.statusCode, 200, response.body);
          const reply = responses[0]!.json<SubmitMessageResponse>();
          assert.deepEqual(reply, {
            taskId: first.taskId,
            continued: true,
            messageId: clientMessageId,
          });
          assert.deepEqual(responses[1]!.json(), reply);
          assert.deepEqual(await counts(), { tasks: 1, messages: 2, jobs: 1, inputs: 1 });
          assert.equal(
            (
              await db.pool.query('SELECT message_id FROM pending_task_inputs WHERE task_id=$1', [
                first.taskId,
              ])
            ).rows[0].message_id,
            clientMessageId,
          );
          assert.equal((await send({ ...payload, replyToMessageId: undefined })).statusCode, 409);
          assert.equal((await send({ ...payload, text: 'A changed instruction' })).statusCode, 409);
          assert.deepEqual(await counts(), { tasks: 1, messages: 2, jobs: 1, inputs: 1 });
        },
      );
      await t.test('attachment IDs retain request order and cannot change on replay', async () => {
        const ids = [randomUUID(), randomUUID()];
        for (const id of ids)
          await db.pool.query(
            'INSERT INTO artifacts(id,owner_id,name,mime_type,size,storage_path) VALUES($1,$2,$3,$4,1,$5)',
            [id, 'local-development', 'fixture.txt', 'text/plain', `/synthetic/unused/${id}`],
          );
        const clientMessageId = randomUUID();
        const payload = {
          clientMessageId,
          text: 'Read these synthetic attachments',
          attachmentIds: [ids[1], ids[0]],
        };
        const accepted = await send(payload);
        assert.equal(accepted.statusCode, 200, accepted.body);
        assert.equal(accepted.json<SubmitMessageResponse>().messageId, clientMessageId);
        const saved = (
          await db.pool.query('SELECT attachments FROM messages WHERE id=$1', [clientMessageId])
        ).rows[0].attachments;
        assert.deepEqual(
          saved.map((item: { id: string }) => item.id),
          payload.attachmentIds,
        );
        assert.deepEqual((await send(payload)).json(), accepted.json());
        const before = await counts();
        assert.equal((await send({ ...payload, attachmentIds: ids })).statusCode, 409);
        assert.equal((await send({ ...payload, attachmentIds: [] })).statusCode, 409);
        assert.deepEqual(await counts(), before);
      });
      await t.test(
        'foreign, assistant and other-channel message IDs cannot be reused',
        async () => {
          const foreignTask = randomUUID(),
            foreignId = randomUUID(),
            assistantId = randomUUID(),
            channelId = randomUUID();
          await db.pool.query(
            "INSERT INTO tasks(id,owner_id,title,prompt,status) VALUES($1,'another-owner','Private fixture','Private fixture','succeeded')",
            [foreignTask],
          );
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,'another-owner','user','Same synthetic text',$2),($3,'local-development','assistant','Same synthetic text',$4)",
            [foreignId, foreignTask, assistantId, first.taskId],
          );
          await tasks.submitTask('Same synthetic text', [], undefined, false, {
            channel: 'telegram:fixture',
            messageId: channelId,
          });
          const before = await counts();
          for (const id of [foreignId, assistantId, channelId])
            assert.equal(
              (await send({ clientMessageId: id, text: 'Same synthetic text' })).statusCode,
              409,
            );
          assert.deepEqual(await counts(), before);
          assert.equal(
            (await send({ clientMessageId: 'not-a-uuid', text: 'Invalid ID' })).statusCode,
            400,
          );
        },
      );
      await t.test(
        'reset rejects old IDs even without an explicit generation and new messages receive a generated ID',
        async () => {
          const reset = await app.inject({
            method: 'POST',
            url: '/api/conversation/reset',
            headers,
            payload: '{}',
          });
          assert.equal(reset.statusCode, 200, reset.body);
          for (const conversationRevision of [undefined, 0, 1])
            assert.equal(
              (
                await send({
                  clientMessageId: firstMessageId,
                  text: 'Prepare the synthetic report',
                  conversationRevision,
                })
              ).statusCode,
              409,
            );
          const accepted = await send({
            text: 'New conversation request',
            conversationRevision: 1,
          });
          assert.equal(accepted.statusCode, 200, accepted.body);
          const body = accepted.json<SubmitMessageResponse>();
          assert.match(body.messageId, /^[0-9a-f-]{36}$/);
          assert.notEqual(body.messageId, firstMessageId);
          assert.equal(
            (
              await db.pool.query('SELECT conversation_revision FROM tasks WHERE id=$1', [
                body.taskId,
              ])
            ).rows[0].conversation_revision,
            1,
          );
          assert.equal(
            (await db.pool.query('SELECT id FROM messages WHERE id=$1', [body.messageId])).rowCount,
            1,
          );
        },
      );
    } finally {
      await app.close();
      await tasks.stopTasks();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
