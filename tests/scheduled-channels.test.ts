import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import type { Job } from 'pg-boss';
import type { InboundMessage, MessagingTransport } from '../src/ports/messaging.ts';
import { createChannels } from '../src/server/channels.ts';
import { createPersonalService } from '../src/server/personal.ts';
import type { Schedule } from '../src/shared/contracts.ts';

test(
  'scheduled channel replies retain the verified conversation through dispatch, edits and retries',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_scheduled_channels_${suffix}`;
    const bossSchema = `test_scheduled_channels_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const ownerId = 'local-development';
    let clock = new Date('2035-10-26T12:00:00Z');
    type Data = { scheduleId: string; revision: number; scheduledFor: string };
    let deliver: (jobs: Job<Data>[]) => Promise<unknown> = async () => {
      throw new Error('Schedule worker was not registered.');
    };
    const inbox: InboundMessage[] = [];
    const sent: Array<Parameters<MessagingTransport['post']>[0]> = [];
    let uncertain = false;
    let selectedTaskId: string | undefined;
    const transport: MessagingTransport = {
      channels: [
        {
          id: 'telegram',
          status: 'configured',
          missing: [],
          accountId: 'fixture-bot',
          allowedSenderIds: ['fixture-owner'],
        },
      ],
      async poll(accept) {
        for (const message of inbox.splice(0)) await accept(message);
      },
      async receive() {
        return { status: 200, body: 'ok' };
      },
      async post(input) {
        sent.push(input);
        if (uncertain) throw new Error('Synthetic transport failure after acceptance.');
        return { id: randomUUID() };
      },
      async close() {},
    };
    const personal = createPersonalService({
      pool: db.pool,
      ownerId,
      scheduler: tasks.boss,
      submitTask: tasks.submitTask,
      now: () => clock,
      refresh() {},
    });
    let channels: Awaited<ReturnType<typeof createChannels>> | undefined;
    const connect = () =>
      createChannels(db.pool, {
        ownerId,
        transport,
        intervalMs: 60_000,
        subscribe: () => () => {},
        submit: async (text, sourceId, client, channel, _prepared, messageId) =>
          (
            await tasks.submitUserMessage(text, [], {
              sourceId,
              client,
              channel,
              clientMessageId: messageId,
              ...(selectedTaskId ? { taskId: selectedTaskId } : {}),
            })
          ).taskId,
      });
    const receive = async (text: string, threadId = 'original-thread') => {
      const messageId = randomUUID();
      inbox.push({
        channelId: 'telegram',
        accountId: 'fixture-bot',
        senderId: 'fixture-owner',
        messageId,
        threadId,
        text,
        sentAt: new Date(),
      });
      await channels!.drain();
      const sourceId = `channel:telegram:fixture-bot:${messageId}`;
      const row = (
        await db.pool.query(
          `SELECT i.task_id,i.message_id,t.channel,m.text FROM channel_inbox i
           JOIN tasks t ON t.id=i.task_id JOIN messages m ON m.id=i.message_id
           WHERE i.source_id=$1 AND i.state='submitted'`,
          [sourceId],
        )
      ).rows[0];
      assert.ok(row);
      assert.equal(row.text, text);
      return {
        taskId: row.task_id as string,
        sourceMessageId: row.message_id as string,
        channel: row.channel as string,
        sourceId,
      };
    };
    const create = (
      provenance?: { taskId: string; sourceMessageId: string | null },
      timing: Record<string, unknown> = {},
    ) =>
      personal.manage(
        'schedule_create',
        {
          title: 'Synthetic reminder',
          prompt: 'Send the synthetic reminder.',
          kind: 'once',
          runAt: new Date(clock.getTime() + 60_000).toISOString(),
          timeZone: 'Europe/Lisbon',
          ...timing,
        },
        provenance,
      ) as Promise<Schedule>;
    const jobFor = async (id: string) => {
      const saved = await db.pool.query('SELECT job_id FROM schedules WHERE id=$1', [id]);
      const job = await tasks.boss.getJobById<Data>('scheduled-task', saved.rows[0].job_id);
      assert.ok(job);
      return { ...job, signal: new AbortController().signal };
    };
    const runs = async (id: string) =>
      (
        await db.pool.query(
          `SELECT r.task_id,t.channel,c.source_id FROM schedule_runs r
           JOIN tasks t ON t.id=r.task_id
           LEFT JOIN channel_task_routes c ON c.task_id=t.id
           WHERE r.schedule_id=$1 ORDER BY r.created_at,r.id`,
          [id],
        )
      ).rows;
    const reply = async (taskId: string, text: string) => {
      const id = randomUUID();
      await db.pool.query(
        "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,$2,'assistant',$3,$4)",
        [id, ownerId, text, taskId],
      );
      await db.pool.query("UPDATE tasks SET status='succeeded' WHERE id=$1", [taskId]);
      await channels!.drain();
      return id;
    };
    try {
      await db.initializeDatabase();
      await tasks.initializeTasks();
      const workerMock = t.mock.method(
        tasks.boss,
        'work',
        async (_name: string, handler: unknown) => {
          deliver = handler as typeof deliver;
          return randomUUID();
        },
      );
      await personal.initialize();
      channels = await connect();
      const origin = await receive('Remind me in a minute.');

      await t.test(
        'one-off replay sends one reminder to the original verified thread',
        async () => {
          const schedule = await create(origin);
          const job = await jobFor(schedule.id);
          clock = new Date(job.data.scheduledFor);
          await Promise.all([deliver([job]), deliver([job])]);
          const dispatched = await runs(schedule.id);
          assert.equal(dispatched.length, 1);
          assert.equal(dispatched[0].channel, origin.channel);
          assert.equal(dispatched[0].source_id, origin.sourceId);
          await reply(dispatched[0].task_id, 'One-off fixture reminder.');
          await channels!.drain();
          assert.deepEqual(sent, [
            {
              channelId: 'telegram',
              accountId: 'fixture-bot',
              threadId: 'original-thread',
              text: 'One-off fixture reminder.',
            },
          ]);
          await deliver([job]);
          assert.equal((await runs(schedule.id)).length, 1);
        },
      );

      await t.test('accepted follow-up message identity selects its exact thread', async () => {
        await db.pool.query(
          "UPDATE tasks SET status='waiting_user',waiting_reason='question' WHERE id=$1",
          [origin.taskId],
        );
        selectedTaskId = origin.taskId;
        const followup = await receive('Make another reminder.', 'followup-thread');
        selectedTaskId = undefined;
        assert.equal(followup.taskId, origin.taskId);
        assert.notEqual(followup.sourceMessageId, origin.sourceMessageId);
        const schedule = await create(followup);
        const job = await jobFor(schedule.id);
        clock = new Date(job.data.scheduledFor);
        await deliver([job]);
        const dispatched = (await runs(schedule.id))[0];
        assert.equal(dispatched.source_id, followup.sourceId);
        await reply(dispatched.task_id, 'Follow-up fixture reminder.');
        assert.equal(sent.at(-1)!.threadId, 'followup-thread');
      });

      await t.test(
        'service-level background route inheritance does not require model recipient arguments',
        async () => {
          const schedule = await create(origin);
          const job = await jobFor(schedule.id);
          clock = new Date(job.data.scheduledFor);
          await deliver([job]);
          const first = (await runs(schedule.id))[0];
          const followup = await create({ taskId: first.task_id, sourceMessageId: null });
          const next = await jobFor(followup.id);
          clock = new Date(next.data.scheduledFor);
          await deliver([next]);
          const inherited = (await runs(followup.id))[0];
          assert.equal(inherited.source_id, origin.sourceId);
          assert.equal(inherited.channel, origin.channel);
          await reply(inherited.task_id, 'Background follow-up fixture.');
          assert.equal(sent.at(-1)!.threadId, 'original-thread');
        },
      );

      await t.test(
        'recurrence, rescheduling and pause preserve the route and fence old jobs',
        async () => {
          const schedule = await create(origin, {
            kind: 'recurring',
            cron: '* * * * *',
            runAt: null,
          });
          const stale = await jobFor(schedule.id);
          await personal.manage('schedule_update', { id: schedule.id, cron: '*/2 * * * *' });
          await deliver([stale]);
          assert.equal((await runs(schedule.id)).length, 0);
          const first = await jobFor(schedule.id);
          clock = new Date(first.data.scheduledFor);
          await deliver([first]);
          const firstRun = (await runs(schedule.id))[0];
          await reply(firstRun.task_id, 'Recurring fixture one.');
          await personal.manage('schedule_update', { id: schedule.id, title: 'Renamed reminder' });
          const second = await jobFor(schedule.id);
          clock = new Date(second.data.scheduledFor);
          await deliver([second]);
          const executions = await runs(schedule.id);
          const secondRun = executions.find((run) => run.task_id !== firstRun.task_id)!;
          await reply(secondRun.task_id, 'Recurring fixture two.');
          assert.equal(executions.length, 2);
          assert.ok(executions.every((run) => run.source_id === origin.sourceId));
          const third = await jobFor(schedule.id);
          const before = sent.length;
          await personal.manage('schedule_cancel', { id: schedule.id });
          clock = new Date(third.data.scheduledFor);
          await deliver([third]);
          await channels!.drain();
          assert.equal((await runs(schedule.id)).length, 2);
          assert.equal(sent.length, before);
        },
      );

      await t.test('web delivery stays web after a channel-origin edit', async () => {
        const schedule = await create();
        await personal.manage(
          'schedule_update',
          { id: schedule.id, title: 'Changed from Telegram' },
          origin,
        );
        const job = await jobFor(schedule.id);
        clock = new Date(job.data.scheduledFor);
        await deliver([job]);
        const dispatched = (await runs(schedule.id))[0];
        assert.equal(dispatched.channel, 'web');
        assert.equal(dispatched.source_id, null);
        const before = sent.length;
        await reply(dispatched.task_id, 'Web fixture reminder.');
        assert.equal(sent.length, before);
      });

      await t.test(
        'model route arguments and unverified message provenance are rejected',
        async () => {
          await assert.rejects(
            create(origin, { channel: 'telegram:arbitrary', threadId: 'other' }),
          );
          const schedule = await create(origin);
          await assert.rejects(
            personal.manage('schedule_update', { id: schedule.id, deliveryChannel: 'web' }),
          );
          await assert.rejects(create({ ...origin, sourceMessageId: randomUUID() }), /unavailable/);
          await assert.rejects(
            create({ taskId: randomUUID(), sourceMessageId: null }),
            /unavailable/,
          );
          await assert.rejects(
            create({ taskId: origin.taskId, sourceMessageId: null }),
            /unavailable/,
          );
          const foreign = randomUUID();
          await db.pool.query(
            "INSERT INTO tasks(id,owner_id,title,prompt,channel) VALUES($1,'foreign','Other','Other',$2)",
            [foreign, origin.channel],
          );
          await assert.rejects(create({ taskId: foreign, sourceMessageId: null }), /unavailable/);
        },
      );

      await t.test(
        'an uncertain scheduled send remains single-attempt across restart',
        async () => {
          const schedule = await create(origin);
          const job = await jobFor(schedule.id);
          clock = new Date(job.data.scheduledFor);
          await deliver([job]);
          uncertain = true;
          const before = sent.length;
          const messageId = await reply((await runs(schedule.id))[0].task_id, 'Uncertain fixture.');
          assert.equal(sent.length, before + 1);
          assert.equal(
            (
              await db.pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [
                messageId,
              ])
            ).rows[0].state,
            'uncertain',
          );
          uncertain = false;
          await channels!.close();
          channels = await connect();
          await channels.drain();
          await deliver([job]);
          await channels.drain();
          assert.equal(sent.length, before + 1);
        },
      );

      await t.test(
        'revoked channel access blocks a due reminder without rerouting or retry',
        async () => {
          const schedule = await create(origin);
          const job = await jobFor(schedule.id);
          clock = new Date(job.data.scheduledFor);
          await deliver([job]);
          await channels!.replaceTransport({
            ...transport,
            channels: [{ ...transport.channels[0]!, allowedSenderIds: [] }],
          });
          const before = sent.length;
          const messageId = await reply((await runs(schedule.id))[0].task_id, 'Revoked fixture.');
          const state = (
            await db.pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
              messageId,
            ])
          ).rows[0];
          assert.deepEqual(state, { state: 'blocked', reason: 'channel_access_changed' });
          await channels!.replaceTransport(transport);
          await channels!.drain();
          assert.equal(sent.length, before);
        },
      );
      await t.test(
        'a real timed occurrence reaches the original Telegram fixture once',
        async () => {
          workerMock.mock.restore();
          const live = createPersonalService({
            pool: db.pool,
            ownerId,
            scheduler: tasks.boss,
            submitTask: tasks.submitTask,
            refresh() {},
          });
          await live.initialize();
          const runAt = new Date(Date.now() + 750).toISOString();
          const schedule = (await live.manage(
            'schedule_create',
            {
              title: 'Timed Telegram fixture',
              prompt: 'Send the synthetic reminder.',
              kind: 'once',
              runAt,
              timeZone: 'Europe/Lisbon',
            },
            origin,
          )) as Schedule;
          let dispatched = await runs(schedule.id);
          for (let attempt = 0; !dispatched.length && attempt < 300; attempt++) {
            await delay(20);
            dispatched = await runs(schedule.id);
          }
          assert.equal(dispatched.length, 1);
          const due = (
            await db.pool.query(
              'SELECT scheduled_for,created_at FROM schedule_runs WHERE schedule_id=$1',
              [schedule.id],
            )
          ).rows[0];
          assert.equal(due.scheduled_for.toISOString(), runAt);
          assert.ok(due.created_at.getTime() >= new Date(runAt).getTime());
          const before = sent.length;
          await reply(dispatched[0].task_id, 'Real-timer fixture reminder.');
          await channels!.drain();
          assert.equal(sent.length, before + 1);
          assert.equal(sent.at(-1)!.threadId, 'original-thread');
          await tasks.boss.offWork('scheduled-task', { wait: true });
        },
      );

      await t.test('scheduled replies cannot extend a provider reply window', async () => {
        const schedule = await create(origin);
        const job = await jobFor(schedule.id);
        clock = new Date(job.data.scheduledFor);
        await deliver([job]);
        await db.pool.query("UPDATE channel_inbox SET received_at=now()-interval '2 days'");
        await channels!.replaceTransport({
          ...transport,
          channels: [{ ...transport.channels[0]!, replyWindowMs: 86_400_000 }],
        });
        const before = sent.length;
        const messageId = await reply(
          (await runs(schedule.id))[0].task_id,
          'Expired-window fixture.',
        );
        const state = (
          await db.pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
            messageId,
          ])
        ).rows[0];
        assert.deepEqual(state, { state: 'blocked', reason: 'reply_window_closed' });
        assert.equal(sent.length, before);
      });
    } finally {
      await channels?.close();
      await tasks.stopTasks();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
