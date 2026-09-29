import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import type { Job } from 'pg-boss';
import type { InboundMessage, MessagingTransport } from '../src/ports/messaging.ts';
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
    const thread = await import('../src/server/thread.ts');
    const { createChannels } = await import('../src/server/channels.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const ownerId = 'local-development';
    let clock = new Date('2035-10-26T12:00:00Z');
    type Data = { scheduleId: string; revision: number; scheduledFor: string };
    let deliver: (jobs: Job<Data>[]) => Promise<unknown> = async () => {
      throw new Error('Schedule worker was not registered.');
    };
    const inbox: InboundMessage[] = [];
    const sent: Array<Parameters<MessagingTransport['post']>[0]> = [];
    let uncertain = false;
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
      scheduler: thread.boss,
      enqueueTurn: thread.enqueueTurn,
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
        submit: async (text, sourceId, client, channel, messageId) =>
          (
            await thread.submitUserMessage(text, [], {
              sourceId,
              client,
              channel,
              clientMessageId: messageId,
            })
          ).turnId,
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
          `SELECT i.turn_id,i.message_id,u.channel,m.text FROM channel_inbox i
           JOIN turns u ON u.id=i.turn_id JOIN messages m ON m.id=i.message_id
           WHERE i.source_id=$1 AND i.state='submitted'`,
          [sourceId],
        )
      ).rows[0];
      assert.ok(row);
      assert.equal(row.text, text);
      return {
        turnId: row.turn_id as string,
        sourceMessageId: row.message_id as string,
        channel: row.channel as string,
        sourceId,
      };
    };
    const create = (
      provenance?: { turnId: string; sourceMessageId: string | null },
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
      const job = await thread.boss.getJobById<Data>('scheduled-task', saved.rows[0].job_id);
      assert.ok(job);
      return { ...job, signal: new AbortController().signal };
    };
    const runs = async (id: string) =>
      (
        await db.pool.query(
          `SELECT r.turn_id,u.channel,u.source,u.background FROM schedule_runs r
           JOIN turns u ON u.id=r.turn_id
           WHERE r.schedule_id=$1 ORDER BY r.created_at,r.id`,
          [id],
        )
      ).rows;
    const reply = async (turnId: string, text: string) => {
      const id = randomUUID();
      await db.pool.query(
        "INSERT INTO messages(id,owner_id,role,text,turn_id,thread_id) SELECT $1,$2,'assistant',$3,id,thread_id FROM turns WHERE id=$4",
        [id, ownerId, text, turnId],
      );
      await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [turnId]);
      await channels!.drain();
      return id;
    };
    try {
      await db.initializeDatabase();
      await thread.initializeThreads();
      const workerMock = t.mock.method(
        thread.boss,
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
          assert.equal(dispatched[0].source, 'schedule');
          assert.equal(dispatched[0].background, true);
          await reply(dispatched[0].turn_id, 'One-off fixture reminder.');
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

      await t.test(
        'service-level background route inheritance does not require model recipient arguments',
        async () => {
          const schedule = await create(origin);
          const job = await jobFor(schedule.id);
          clock = new Date(job.data.scheduledFor);
          await deliver([job]);
          const first = (await runs(schedule.id))[0];
          const followup = await create({ turnId: first.turn_id, sourceMessageId: null });
          const next = await jobFor(followup.id);
          clock = new Date(next.data.scheduledFor);
          await deliver([next]);
          const inherited = (await runs(followup.id))[0];
          assert.equal(inherited.channel, origin.channel);
          await reply(inherited.turn_id, 'Background follow-up fixture.');
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
          await reply(firstRun.turn_id, 'Recurring fixture one.');
          await personal.manage('schedule_update', { id: schedule.id, title: 'Renamed reminder' });
          const second = await jobFor(schedule.id);
          clock = new Date(second.data.scheduledFor);
          await deliver([second]);
          const executions = await runs(schedule.id);
          const secondRun = executions.find((run) => run.turn_id !== firstRun.turn_id)!;
          await reply(secondRun.turn_id, 'Recurring fixture two.');
          assert.equal(executions.length, 2);
          assert.ok(executions.every((run) => run.channel === origin.channel));
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
        const before = sent.length;
        await reply(dispatched.turn_id, 'Web fixture reminder.');
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
            create({ turnId: randomUUID(), sourceMessageId: null }),
            /unavailable/,
          );
          await assert.rejects(
            create({ turnId: origin.turnId, sourceMessageId: null }),
            /unavailable/,
          );
          const foreign = randomUUID();
          const foreignThread = randomUUID();
          await db.pool.query("INSERT INTO threads(id,owner_id) VALUES($1,'foreign')", [
            foreignThread,
          ]);
          await db.pool.query(
            "INSERT INTO turns(id,owner_id,thread_id,source,prompt,channel) VALUES($1,'foreign',$2,'schedule','Other',$3)",
            [foreign, foreignThread, origin.channel],
          );
          await assert.rejects(create({ turnId: foreign, sourceMessageId: null }), /unavailable/);
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
          const messageId = await reply((await runs(schedule.id))[0].turn_id, 'Uncertain fixture.');
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
          const messageId = await reply((await runs(schedule.id))[0].turn_id, 'Revoked fixture.');
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
            scheduler: thread.boss,
            enqueueTurn: thread.enqueueTurn,
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
          await reply(dispatched[0].turn_id, 'Real-timer fixture reminder.');
          await channels!.drain();
          assert.equal(sent.length, before + 1);
          assert.equal(sent.at(-1)!.threadId, 'original-thread');
          await thread.boss.offWork('scheduled-task', { wait: true });
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
          (await runs(schedule.id))[0].turn_id,
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
      await thread.stopThreadWorkers();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
