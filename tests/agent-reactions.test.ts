import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { createAgentReactionService } from '../src/server/agent-reactions.ts';
import { lockConversation } from '../src/server/conversations.ts';

test(
  'trusted agent reactions are restrained and scoped to the current owned web conversation',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_agent_reactions_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    url.searchParams.set('application_name', schema);
    process.env.DATABASE_URL = url.href;
    const { pool, initializeDatabase } = await import('../src/server/db.ts');
    const { initializeTaskSchema } = await import('../src/server/tasks.ts');
    async function waitForBlockedReaction() {
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await admin.query(
          "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock'",
          [schema],
        );
        if (result.rowCount) return;
        await delay(10);
      }
      assert.fail('The synthetic reaction did not reach the held database lock.');
    }
    async function setup() {
      const ownerId = randomUUID();
      let refreshes = 0;
      const service = createAgentReactionService({
        pool,
        ownerId,
        refresh() {
          refreshes++;
        },
      });
      async function seed(
        options: { owner?: string; channel?: string; generation?: number; source?: string } = {},
      ) {
        const taskId = randomUUID();
        const messageId = randomUUID();
        await pool.query(
          "INSERT INTO tasks(id,owner_id,title,prompt,status,channel,conversation_revision,source) VALUES($1,$2,'Synthetic milestone','Synthetic milestone','running',$3,$4,$5)",
          [
            taskId,
            options.owner ?? ownerId,
            options.channel ?? 'web',
            options.generation ?? 0,
            options.source ?? 'user',
          ],
        );
        await pool.query(
          "INSERT INTO messages(id,owner_id,task_id,role,text) VALUES($1,$2,$3,'user','Synthetic milestone')",
          [messageId, options.owner ?? ownerId, taskId],
        );
        return { taskId, messageId, revision: 0, reaction: '🎉', visibleMessageIds: [messageId] };
      }
      return { ownerId, service, seed, refreshes: () => refreshes };
    }
    try {
      await initializeDatabase();
      await initializeDatabase();
      await initializeTaskSchema();
      await t.test(
        'one badge is idempotent, can be removed, and cannot be repeatedly replaced',
        async () => {
          const { service, seed, refreshes } = await setup();
          const input = await seed();
          assert.deepEqual(await service.react({ ...input, reaction: 'like' }), {
            status: 'updated',
          });
          assert.deepEqual(await service.react({ ...input, reaction: '👍' }), {
            status: 'unchanged',
          });
          assert.deepEqual(await service.react(input), {
            status: 'skipped',
            reason: 'already_reacted',
          });
          assert.equal(
            (
              await pool.query('SELECT assistant_reaction FROM messages WHERE id=$1', [
                input.messageId,
              ])
            ).rows[0].assistant_reaction,
            '👍',
          );
          assert.deepEqual(await service.react({ ...input, reaction: null }), {
            status: 'updated',
          });
          assert.deepEqual(await service.react({ ...input, reaction: null }), {
            status: 'unchanged',
          });
          assert.deepEqual(await service.react(input), {
            status: 'skipped',
            reason: 'already_reacted',
          });
          assert.equal(refreshes(), 2);
          assert.equal(
            (await pool.query('SELECT id FROM task_events WHERE task_id=$1', [input.taskId]))
              .rowCount,
            0,
          );
          assert.equal(
            (await pool.query('SELECT id FROM messages WHERE task_id=$1', [input.taskId])).rowCount,
            1,
          );
        },
      );
      await t.test(
        'concurrent sessions share a durable cooldown which survives factory recreation',
        async () => {
          const { ownerId, service, seed, refreshes } = await setup();
          const inputs = await Promise.all([seed(), seed()]);
          const results = await Promise.all(inputs.map(service.react));
          assert.equal(results.filter((result) => result.status === 'updated').length, 1);
          assert.equal(
            results.filter((result) => result.status === 'skipped' && result.reason === 'cooldown')
              .length,
            1,
          );
          assert.equal(refreshes(), 1);
          const waiting = inputs[results.findIndex((result) => result.status === 'skipped')]!;
          const restarted = createAgentReactionService({ pool, ownerId, refresh() {} });
          assert.deepEqual(await restarted.react(waiting), {
            status: 'skipped',
            reason: 'cooldown',
          });
          await pool.query(
            "UPDATE messages SET assistant_reacted_at=now()-interval '5 minutes 1 second' WHERE owner_id=$1 AND assistant_reacted_at IS NOT NULL",
            [ownerId],
          );
          assert.deepEqual(await restarted.react(waiting), { status: 'updated' });
        },
      );
      await t.test(
        'targets must be visible, owned user messages in the exact current channel and generation',
        async () => {
          const { ownerId, service, seed } = await setup();
          const current = await seed({ generation: 1 });
          await pool.query(
            "INSERT INTO conversations(owner_id,channel,revision) VALUES($1,'web',1)",
            [ownerId],
          );
          const foreign = await seed({ owner: randomUUID(), generation: 1 });
          const channel = await seed({ channel: 'telegram:fixture', generation: 1 });
          const archived = await seed();
          const assistant = randomUUID();
          await pool.query(
            "INSERT INTO messages(id,owner_id,task_id,role,text) VALUES($1,$2,$3,'assistant','Synthetic answer')",
            [assistant, ownerId, current.taskId],
          );
          for (const messageId of [
            foreign.messageId,
            channel.messageId,
            archived.messageId,
            assistant,
          ]) {
            await assert.rejects(
              service.react({ ...current, messageId, visibleMessageIds: [messageId] }),
              /cannot receive/,
            );
          }
          await assert.rejects(
            service.react({ ...current, visibleMessageIds: [] }),
            /not in this conversation/,
          );
          await assert.rejects(
            service.react({ ...current, reaction: 'not an emoji' }),
            /one emoji/,
          );
          await assert.rejects(service.react({ ...current, revision: 1 }), /no longer active/);
          await assert.rejects(service.react(foreign), /no longer active/);
          const external = await seed({ channel: 'telegram:fixture' });
          const background = await seed({ generation: 1, source: 'event' });
          assert.deepEqual(await service.react(external), {
            status: 'skipped',
            reason: 'unavailable',
          });
          assert.deepEqual(await service.react(background), {
            status: 'skipped',
            reason: 'unavailable',
          });
          await pool.query("UPDATE tasks SET status='cancelled' WHERE id=$1", [current.taskId]);
          await assert.rejects(service.react(current), /no longer active/);
          assert.equal(
            (
              await pool.query(
                'SELECT id FROM messages WHERE owner_id=$1 AND assistant_reaction IS NOT NULL',
                [ownerId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'reset fences a queued reaction and the new conversation has its own cooldown',
        async () => {
          const { ownerId, service, seed } = await setup();
          const reacted = await seed();
          assert.deepEqual(await service.react(reacted), { status: 'updated' });
          const stale = await seed();
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await lockConversation(client, ownerId);
            await client.query(
              "INSERT INTO conversations(owner_id,channel,revision) VALUES($1,'web',1)",
              [ownerId],
            );
            const pending = assert.rejects(service.react(stale), /no longer active/);
            await waitForBlockedReaction();
            await client.query('COMMIT');
            await pending;
          } finally {
            client.release();
          }
          assert.equal(
            (
              await pool.query('SELECT assistant_reaction FROM messages WHERE id=$1', [
                stale.messageId,
              ])
            ).rows[0].assistant_reaction,
            null,
          );
          assert.deepEqual(await service.react(await seed({ generation: 1 })), {
            status: 'updated',
          });
        },
      );
      await t.test(
        'cancellation while waiting for the current segment lock cannot publish a badge',
        async () => {
          const { service, seed } = await setup();
          const input = await seed();
          const controller = new AbortController();
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('SELECT id FROM tasks WHERE id=$1 FOR NO KEY UPDATE', [
              input.taskId,
            ]);
            const pending = assert.rejects(service.react({ ...input, signal: controller.signal }), {
              name: 'AbortError',
            });
            await waitForBlockedReaction();
            controller.abort();
            await client.query('COMMIT');
            await pending;
          } finally {
            client.release();
          }
          assert.equal(
            (
              await pool.query('SELECT assistant_reaction FROM messages WHERE id=$1', [
                input.messageId,
              ])
            ).rows[0].assistant_reaction,
            null,
          );
        },
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
