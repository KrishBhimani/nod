import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';

test(
  'trusted agent reactions are restrained and scoped to the active owned thread',
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
    const { activeThread, lockThread } = await import('../src/server/thread.ts');
    const { createAgentReactionService } = await import('../src/server/agent-reactions.ts');
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
        options: { owner?: string; channel?: string; source?: string; archived?: boolean } = {},
      ) {
        const owner = options.owner ?? ownerId;
        let threadId: string;
        if (options.archived) {
          threadId = randomUUID();
          await pool.query('INSERT INTO threads(id,owner_id,archived_at) VALUES($1,$2,now())', [
            threadId,
            owner,
          ]);
        } else threadId = (await activeThread(pool, owner)).id;
        const turnId = randomUUID();
        const messageId = randomUUID();
        await pool.query(
          "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status,channel,message_id) VALUES($1,$2,$3,$4,'Synthetic milestone','running',$5,$6)",
          [turnId, owner, threadId, options.source ?? 'user', options.channel ?? 'web', messageId],
        );
        await pool.query(
          "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'user','Synthetic milestone')",
          [messageId, owner, threadId, turnId],
        );
        return { threadId, turnId, messageId, reaction: '🎉' };
      }
      return { ownerId, service, seed, refreshes: () => refreshes };
    }
    try {
      await initializeDatabase();
      await initializeDatabase();
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
            (await pool.query('SELECT id FROM turn_events WHERE turn_id=$1', [input.turnId]))
              .rowCount,
            0,
          );
          assert.equal(
            (await pool.query('SELECT id FROM messages WHERE turn_id=$1', [input.turnId])).rowCount,
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
        'targets must be owned user messages in the active thread of a running web user turn',
        async () => {
          const { ownerId, service, seed } = await setup();
          const current = await seed();
          const foreign = await seed({ owner: randomUUID() });
          const archived = await seed({ archived: true });
          const assistant = randomUUID();
          await pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'assistant','Synthetic answer')",
            [assistant, ownerId, current.threadId, current.turnId],
          );
          for (const messageId of [
            foreign.messageId,
            archived.messageId,
            assistant,
            randomUUID(),
          ]) {
            await assert.rejects(service.react({ ...current, messageId }), /cannot receive/);
          }
          await assert.rejects(
            service.react({ ...current, reaction: 'not an emoji' }),
            /one emoji/,
          );
          await assert.rejects(
            service.react({ ...current, turnId: randomUUID() }),
            /no longer active/,
          );
          await assert.rejects(
            service.react({ ...current, threadId: archived.threadId }),
            /no longer active/,
          );
          await assert.rejects(service.react(foreign), /no longer active/);
          await assert.rejects(service.react(archived), /no longer active/);
          const external = await seed({ channel: 'telegram:fixture' });
          const background = await seed({ source: 'event' });
          assert.deepEqual(await service.react(external), {
            status: 'skipped',
            reason: 'unavailable',
          });
          assert.deepEqual(await service.react(background), {
            status: 'skipped',
            reason: 'unavailable',
          });
          await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [current.turnId]);
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
        'reset fences a queued reaction and the new thread has its own cooldown',
        async () => {
          const { ownerId, service, seed } = await setup();
          const reacted = await seed();
          assert.deepEqual(await service.react(reacted), { status: 'updated' });
          const stale = await seed();
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const thread = await lockThread(client, ownerId);
            await client.query('UPDATE threads SET archived_at=now() WHERE id=$1', [thread.id]);
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
          assert.deepEqual(await service.react(await seed()), {
            status: 'updated',
          });
        },
      );
      await t.test(
        'cancellation while waiting for the current turn lock cannot publish a badge',
        async () => {
          const { service, seed } = await setup();
          const input = await seed();
          const controller = new AbortController();
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('SELECT id FROM turns WHERE id=$1 FOR NO KEY UPDATE', [
              input.turnId,
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
