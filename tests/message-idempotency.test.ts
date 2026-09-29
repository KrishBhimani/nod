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
    const thread = await import('../src/server/thread.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { configuration, port } = await import('../src/server/config.ts');
    const messages = thread.createUserMessageService();
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
      turns: (await db.pool.query('SELECT count(*)::int AS count FROM turns')).rows[0].count,
      messages: (await db.pool.query('SELECT count(*)::int AS count FROM messages')).rows[0].count,
      jobs: (
        await db.pool.query(
          `SELECT count(*)::int AS count FROM ${bossSchema}.job WHERE name='thread-drain'`,
        )
      ).rows[0].count,
    });
    let first: SubmitMessageResponse & { threadId: string };
    const firstMessageId = randomUUID();
    try {
      await db.initializeDatabase();
      await thread.initializeThreads();
      await t.test('concurrent identical submissions store one message, turn and job', async () => {
        const payload = {
          clientMessageId: firstMessageId,
          text: '  Prepare the synthetic report  ',
        };
        const responses = await Promise.all([send(payload), send(payload)]);
        for (const response of responses) assert.equal(response.statusCode, 200, response.body);
        first = responses[0]!.json();
        assert.deepEqual(responses[1]!.json(), first);
        assert.equal(first.messageId, firstMessageId);
        assert.deepEqual(await counts(), { turns: 1, messages: 1, jobs: 1 });
        const saved = (
          await db.pool.query('SELECT text,turn_id,thread_id FROM messages WHERE id=$1', [
            firstMessageId,
          ])
        ).rows[0];
        assert.equal(saved.text, 'Prepare the synthetic report');
        assert.equal(saved.turn_id, first.turnId);
        assert.equal(saved.thread_id, first.threadId);
        assert.deepEqual((await send(payload)).json(), first);
        assert.deepEqual(await counts(), { turns: 1, messages: 1, jobs: 1 });
      });
      await t.test(
        'a reply queues its own turn on the same thread and HTTP retries do not queue twice',
        async () => {
          const clientMessageId = randomUUID();
          const payload = {
            clientMessageId,
            text: 'Add a short conclusion to that report',
            replyToMessageId: firstMessageId,
            threadId: first.threadId,
          };
          const responses = await Promise.all([send(payload), send(payload)]);
          for (const response of responses) assert.equal(response.statusCode, 200, response.body);
          const reply = responses[0]!.json<SubmitMessageResponse & { threadId: string }>();
          assert.equal(reply.messageId, clientMessageId);
          assert.equal(reply.threadId, first.threadId);
          assert.notEqual(reply.turnId, first.turnId);
          assert.deepEqual(responses[1]!.json(), reply);
          assert.deepEqual(await counts(), { turns: 2, messages: 2, jobs: 2 });
          assert.equal((await send({ ...payload, replyToMessageId: undefined })).statusCode, 409);
          assert.equal((await send({ ...payload, text: 'A changed instruction' })).statusCode, 409);
          assert.deepEqual(await counts(), { turns: 2, messages: 2, jobs: 2 });
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
      await t.test('foreign and assistant message IDs cannot be reused', async () => {
        const foreignThread = randomUUID(),
          foreignId = randomUUID(),
          assistantId = randomUUID();
        await db.pool.query("INSERT INTO threads(id,owner_id) VALUES($1,'another-owner')", [
          foreignThread,
        ]);
        await db.pool.query(
          "INSERT INTO messages(id,owner_id,role,text,thread_id) VALUES($1,'another-owner','user','Same synthetic text',$2),($3,'local-development','assistant','Same synthetic text',$4)",
          [foreignId, foreignThread, assistantId, first.threadId],
        );
        const before = await counts();
        for (const id of [foreignId, assistantId])
          assert.equal(
            (await send({ clientMessageId: id, text: 'Same synthetic text' })).statusCode,
            409,
          );
        assert.deepEqual(await counts(), before);
        assert.equal(
          (await send({ clientMessageId: 'not-a-uuid', text: 'Invalid ID' })).statusCode,
          400,
        );
      });
      await t.test(
        'reset rejects old IDs and stale thread IDs and new messages receive a generated ID',
        async () => {
          const reset = await app.inject({
            method: 'POST',
            url: '/api/conversation/reset',
            headers,
            payload: '{}',
          });
          assert.equal(reset.statusCode, 200, reset.body);
          const next = reset.json<{ ok: boolean; threadId: string }>().threadId;
          assert.notEqual(next, first.threadId);
          for (const threadId of [undefined, first.threadId, next])
            assert.equal(
              (
                await send({
                  clientMessageId: firstMessageId,
                  text: 'Prepare the synthetic report',
                  threadId,
                })
              ).statusCode,
              409,
            );
          assert.equal(
            (await send({ text: 'Stale request', threadId: first.threadId })).statusCode,
            409,
          );
          const accepted = await send({ text: 'New conversation request', threadId: next });
          assert.equal(accepted.statusCode, 200, accepted.body);
          const body = accepted.json<SubmitMessageResponse & { threadId: string }>();
          assert.match(body.messageId, /^[0-9a-f-]{36}$/);
          assert.notEqual(body.messageId, firstMessageId);
          assert.equal(body.threadId, next);
          assert.equal(
            (await db.pool.query('SELECT thread_id FROM turns WHERE id=$1', [body.turnId])).rows[0]
              .thread_id,
            next,
          );
          assert.equal(
            (await db.pool.query('SELECT id FROM messages WHERE id=$1', [body.messageId])).rowCount,
            1,
          );
        },
      );
    } finally {
      await app.close();
      await thread.stopThreadWorkers();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
