import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import pg from 'pg';
import type { Job } from 'pg-boss';
import { z } from 'zod';
import { createPersonalService } from '../src/server/personal.ts';
import type { Schedule, ScheduleHistory } from '../src/shared/contracts.ts';

test(
  'one-off and recurring schedules dispatch atomically with exact timing and retained owned history',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_schedules_${suffix}`;
    const bossSchema = `test_schedules_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    let clock = new Date('2035-10-26T12:00:00.000Z');
    type Data = { scheduleId: string; revision: number; scheduledFor: string };
    let deliver: (jobs: Job<Data>[]) => Promise<unknown> = async () => {
      throw new Error('Schedule worker was not registered.');
    };
    let failAfterTask = false;
    const personal = createPersonalService({
      pool: db.pool,
      ownerId: 'local-development',
      scheduler: tasks.boss,
      now: () => clock,
      submitTask: async (...args) => {
        assert.ok(args[4]?.client);
        const id = await tasks.submitTask(...args);
        if (failAfterTask) throw new Error('Synthetic failure after task creation.');
        return id;
      },
      refresh() {},
    });
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const value = error as Error & { statusCode?: number };
      reply
        .code(error instanceof z.ZodError ? 400 : (value.statusCode ?? 500))
        .send({ error: value.message });
    });
    personal.registerRoutes(app);
    const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) =>
      app.inject({
        method,
        url: path,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
      });
    const create = async (input: Record<string, unknown>) => {
      const response = await request('POST', '/api/schedules', {
        title: 'Fixture schedule',
        prompt: 'Return a synthetic result only.',
        timeZone: 'Europe/Lisbon',
        ...input,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Schedule>();
    };
    const jobFor = async (id: string) => {
      const result = await db.pool.query('SELECT job_id FROM schedules WHERE id=$1', [id]);
      const job = await tasks.boss.getJobById<Data>('scheduled-task', result.rows[0].job_id);
      assert.ok(job);
      return { ...job, signal: new AbortController().signal };
    };
    const runs = async (id: string) => {
      const response = await request('GET', `/api/schedules/${id}/runs`);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<ScheduleHistory>().runs;
    };
    const saved = async (id: string) =>
      (await personal.listSchedules()).find((schedule) => schedule.id === id)!;
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
      await db.pool.query(`CREATE TABLE schedules (
        id uuid PRIMARY KEY,owner_id text NOT NULL,title text NOT NULL,prompt text NOT NULL,
        cron text NOT NULL,time_zone text NOT NULL,enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      const legacyId = randomUUID();
      await db.pool.query(
        "INSERT INTO schedules(id,owner_id,title,prompt,cron,time_zone) VALUES($1,'local-development','Legacy fixture','Synthetic only','0 9 * * *','Europe/Lisbon')",
        [legacyId],
      );
      await tasks.boss.createQueue('scheduled-task');
      await tasks.boss.schedule(
        'scheduled-task',
        '0 9 * * *',
        { scheduleId: legacyId },
        { key: legacyId, tz: 'Europe/Lisbon' },
      );
      await personal.initialize();

      await t.test(
        'migration replaces legacy cron dispatch once and rejects its old payload',
        async () => {
          const migrated = await saved(legacyId);
          assert.equal(migrated.kind, 'recurring');
          assert.equal(migrated.nextRun, '2035-10-27T08:00:00.000Z');
          const current = await jobFor(legacyId);
          await personal.initialize({ workers: false });
          assert.equal((await jobFor(legacyId)).id, current.id);
          assert.equal(
            (await db.pool.query(`SELECT * FROM ${bossSchema}.schedule WHERE key=$1`, [legacyId]))
              .rowCount,
            0,
          );
          await deliver([{ ...current, id: randomUUID(), data: { scheduleId: legacyId } as Data }]);
          assert.deepEqual(await runs(legacyId), []);
        },
      );

      await t.test(
        'one-off firing is single-use under concurrent redelivery and restart',
        async () => {
          const schedule = await create({ kind: 'once', runAt: '2035-10-27T09:05:00+01:00' });
          assert.equal(schedule.kind, 'once');
          assert.equal(schedule.cron, null);
          assert.equal(schedule.runAt, '2035-10-27T08:05:00.000Z');
          assert.equal(schedule.nextRun, schedule.runAt);
          assert.equal(schedule.lastRun, null);
          const job = await jobFor(schedule.id);
          assert.equal(job.startAfter.toISOString(), schedule.runAt);
          clock = new Date(schedule.runAt!);
          await Promise.all([deliver([job]), deliver([job])]);
          const history = await runs(schedule.id);
          assert.equal(history.length, 1);
          assert.equal(history[0]!.scheduledFor, schedule.runAt);
          assert.equal(history[0]!.timeZone, 'Europe/Lisbon');
          assert.equal(history[0]!.status, 'queued');
          assert.equal((await saved(schedule.id)).enabled, false);
          assert.equal((await saved(schedule.id)).nextRun, null);
          assert.equal((await saved(schedule.id)).lastRun?.id, history[0]!.id);
          await personal.initialize({ workers: false });
          await deliver([job]);
          assert.equal((await runs(schedule.id)).length, 1);
          assert.equal(
            (await db.pool.query('SELECT * FROM tasks WHERE id=$1', [history[0]!.taskId])).rows[0]
              .source,
            'schedule',
          );
          assert.equal(
            (await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: true })).statusCode,
            400,
          );
          await db.pool.query("UPDATE tasks SET status='succeeded' WHERE id=$1", [
            history[0]!.taskId,
          ]);
          assert.equal((await runs(schedule.id))[0]!.status, 'succeeded');
        },
      );

      await t.test(
        'recurring work preserves Lisbon wall time across DST and skips a catch-up flood',
        async () => {
          clock = new Date('2035-10-26T12:00:00.000Z');
          const schedule = await create({ cron: '5 9 * * *' });
          assert.equal(schedule.kind, 'recurring');
          assert.equal(schedule.nextRun, '2035-10-27T08:05:00.000Z');
          let job = await jobFor(schedule.id);
          clock = new Date(schedule.nextRun!);
          await deliver([job]);
          assert.equal((await saved(schedule.id)).nextRun, '2035-10-28T09:05:00.000Z');
          job = await jobFor(schedule.id);
          clock = new Date('2035-11-02T12:00:00.000Z');
          await deliver([job]);
          assert.equal((await runs(schedule.id)).length, 2);
          assert.equal((await runs(schedule.id))[0]!.scheduledFor, '2035-10-28T09:05:00.000Z');
          assert.equal((await saved(schedule.id)).nextRun, '2035-11-03T09:05:00.000Z');
        },
      );

      await t.test('edits, pauses and deletions fence already claimed jobs', async () => {
        const schedule = await create({ kind: 'once', runAt: '2035-11-03T14:30:00Z' });
        const stale = await jobFor(schedule.id);
        const update = await request('PATCH', `/api/schedules/${schedule.id}`, {
          runAt: '2035-11-04T14:30:00Z',
          title: 'Updated fixture',
        });
        assert.equal(update.statusCode, 200, update.body);
        assert.equal(update.json<Schedule>().kind, 'once');
        assert.equal(update.json<Schedule>().revision, schedule.revision + 1);
        await deliver([stale]);
        assert.deepEqual(await runs(schedule.id), []);
        const pausedJob = await jobFor(schedule.id);
        assert.equal(
          (await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: false })).statusCode,
          200,
        );
        await deliver([pausedJob]);
        assert.deepEqual(await runs(schedule.id), []);
        assert.equal((await saved(schedule.id)).nextRun, null);
        await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: true });
        const deletedJob = await jobFor(schedule.id);
        await request('DELETE', `/api/schedules/${schedule.id}`);
        await deliver([deletedJob]);
        assert.equal((await request('GET', `/api/schedules/${schedule.id}/runs`)).statusCode, 404);
      });

      await t.test(
        'task creation, run history and next occurrence roll back together',
        async () => {
          const schedule = await create({ kind: 'once', runAt: '2035-11-05T10:00:00Z' });
          const job = await jobFor(schedule.id);
          const before = (await db.pool.query('SELECT count(*)::int AS count FROM tasks')).rows[0]
            .count;
          failAfterTask = true;
          await assert.rejects(deliver([job]), /Synthetic failure/);
          failAfterTask = false;
          assert.equal(
            (await db.pool.query('SELECT count(*)::int AS count FROM tasks')).rows[0].count,
            before,
          );
          assert.deepEqual(await runs(schedule.id), []);
          assert.equal((await jobFor(schedule.id)).id, job.id);
          await deliver([job]);
          assert.equal((await runs(schedule.id)).length, 1);
        },
      );

      await t.test(
        'restart preserves due jobs and replaces a failed dispatcher without replay',
        async () => {
          const schedule = await create({ kind: 'once', runAt: '2035-11-06T10:00:00Z' });
          const job = await jobFor(schedule.id);
          await personal.initialize({ workers: false });
          assert.equal((await jobFor(schedule.id)).id, job.id);
          await tasks.boss.cancel('scheduled-task', job.id);
          clock = new Date('2035-11-07T10:00:00Z');
          await personal.initialize({ workers: false });
          const replacement = await jobFor(schedule.id);
          assert.notEqual(replacement.id, job.id);
          assert.equal(replacement.data.scheduledFor, schedule.runAt);
          await deliver([job]);
          assert.deepEqual(await runs(schedule.id), []);
          await deliver([replacement]);
          assert.equal((await runs(schedule.id)).length, 1);
        },
      );

      await t.test(
        'owned history survives deletion, paginates precisely and reflects failures',
        async () => {
          const schedule = await create({ kind: 'once', runAt: '2035-11-08T10:00:00Z' });
          await deliver([await jobFor(schedule.id)]);
          const run = (await runs(schedule.id))[0]!;
          await db.pool.query(
            "UPDATE tasks SET status='failed',error='Synthetic fixed error.' WHERE id=$1",
            [run.taskId],
          );
          await request('DELETE', `/api/schedules/${schedule.id}`);
          const retained = (await runs(schedule.id))[0]!;
          assert.equal(retained.title, 'Fixture schedule');
          assert.equal(retained.status, 'failed');
          assert.equal(retained.error, 'Synthetic fixed error.');
          const seen = new Set<string>();
          let cursor: string | null = null;
          do {
            const page: ScheduleHistory = (
              await request('GET', `/api/schedule-runs?limit=1${cursor ? `&cursor=${cursor}` : ''}`)
            ).json<ScheduleHistory>();
            for (const entry of page.runs) {
              assert.equal(seen.has(entry.id), false);
              seen.add(entry.id);
            }
            cursor = page.nextCursor;
          } while (cursor);
          assert.equal(
            seen.size,
            (await db.pool.query('SELECT count(*)::int AS count FROM schedule_runs')).rows[0].count,
          );
          const foreign = randomUUID();
          await db.pool.query('UPDATE schedule_runs SET owner_id=$2 WHERE id=$1', [
            run.id,
            'foreign-owner',
          ]);
          assert.equal(
            (await request('GET', `/api/schedules/${schedule.id}/runs`)).statusCode,
            404,
          );
          assert.equal((await request('GET', `/api/schedules/${foreign}/runs`)).statusCode, 404);
          assert.equal((await request('GET', '/api/schedule-runs?cursor=broken')).statusCode, 400);
          assert.equal((await request('GET', '/api/schedule-runs?limit=101')).statusCode, 400);
          assert.equal(
            (await request('GET', '/api/schedule-runs'))
              .json<ScheduleHistory>()
              .runs.some((entry) => entry.id === run.id),
            false,
          );
        },
      );

      await t.test('invalid or ambiguous timing cannot create jobs', async () => {
        const before = (await personal.listSchedules()).length;
        for (const timing of [
          { kind: 'once', runAt: '2035-11-08T10:00:00' },
          { kind: 'once', runAt: '2035-11-01T10:00:00Z' },
          { kind: 'once', runAt: '2035-11-08T10:00:00Z', cron: '0 9 * * *' },
          { kind: 'recurring', runAt: '2035-11-08T10:00:00Z', cron: '0 9 * * *' },
          { kind: 'recurring', cron: '* * * * * *' },
          { kind: 'recurring', cron: '0 9 * * *', timeZone: 'Unknown/Zone' },
        ]) {
          const response = await request('POST', '/api/schedules', {
            title: 'Invalid fixture',
            prompt: 'Synthetic only',
            timeZone: 'Europe/Lisbon',
            ...timing,
          });
          assert.equal(response.statusCode, 400, response.body);
        }
        assert.equal((await personal.listSchedules()).length, before);
      });

      await t.test(
        'a real pg-boss worker dispatches one due one-off without a model or external action',
        async () => {
          workerMock.mock.restore();
          const liveScheduler = createPersonalService({
            pool: db.pool,
            ownerId: 'local-development',
            scheduler: tasks.boss,
            submitTask: tasks.submitTask,
            refresh() {},
          });
          await liveScheduler.initialize();
          const actualRunAt = new Date(Date.now() + 750).toISOString();
          const schedule = (await liveScheduler.manage('schedule_create', {
            title: 'Timed synthetic fixture',
            prompt: 'Synthetic execution only',
            kind: 'once',
            runAt: actualRunAt,
            timeZone: 'Europe/Lisbon',
          })) as Schedule;
          let history = await runs(schedule.id);
          for (let attempts = 0; !history.length && attempts < 300; attempts++) {
            await delay(20);
            history = await runs(schedule.id);
          }
          assert.equal(history.length, 1);
          assert.equal(history[0]!.scheduledFor, actualRunAt);
          assert.ok(new Date(history[0]!.createdAt).getTime() >= new Date(actualRunAt).getTime());
          assert.equal(history[0]!.status, 'queued');
          assert.equal(
            (await liveScheduler.listSchedules()).find((item) => item.id === schedule.id)?.enabled,
            false,
          );
          await tasks.boss.offWork('scheduled-task', { wait: true });
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
