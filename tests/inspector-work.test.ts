import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { z } from 'zod';
import { createInspectorWork } from '../src/server/inspector-work.ts';
import { registerLocalAccess } from '../src/server/access.ts';
import { createSchedules } from '../src/server/schedules.ts';

test(
  'work inspector groups current owned outcomes and reports bounded actual schedule and review state',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_inspector_work_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const ownerId = 'local-development';
    const secret = 'fixture-provider-secret';
    let enabled = true;
    let reviewAvailable = true;
    const store = createInspectorWork(db.pool, {
      ownerId,
      enabled: () => enabled,
      secrets: [secret],
      async reviewStatus() {
        if (!reviewAvailable) throw new Error('Fixture scheduler unavailable.');
        return { configured: true, scheduled: true, cron: '0 * * * *', timeZone: 'UTC' };
      },
    });
    const app = Fastify();
    registerLocalAccess(app, 4310);
    app.setErrorHandler((error, _request, reply) =>
      reply.code(error instanceof z.ZodError ? 400 : 500).send({ error: 'Invalid work request.' }),
    );
    store.registerRoutes(app);
    const headers = { host: 'localhost:4310' };
    const mainTask = randomUUID();
    const relatedTask = randomUUID();
    const reviewTask = randomUUID();
    const scheduledTask = randomUUID();
    const outcomeId = randomUUID();
    async function task(
      status: string,
      options: {
        id?: string;
        owner?: string;
        revision?: number;
        outcome?: string;
        source?: string;
        title?: string;
        waiting?: string;
      } = {},
    ) {
      const id = options.id ?? randomUUID();
      await db.pool.query(
        `INSERT INTO tasks(id,owner_id,title,prompt,status,conversation_revision,outcome_id,source,waiting_reason)
      VALUES($1,$2,$3,'Private huge instruction must stay out',$4,$5,$6,$7,$8)`,
        [
          id,
          options.owner ?? ownerId,
          options.title ?? 'Fixture work',
          status,
          options.revision ?? 1,
          options.outcome ?? null,
          options.source ?? 'user',
          options.waiting ?? null,
        ],
      );
      return id;
    }
    async function notification(
      input: {
        owner?: string;
        taskId?: string;
        age?: string;
        reason?: string;
        decision?: string;
      } = {},
    ) {
      const id = randomUUID();
      await db.pool.query(
        `INSERT INTO notifications(id,event_id,owner_id,summary,decision,reason,task_id,created_at)
      VALUES($1,$2,$3,'Raw external message must stay out',$4,$5,$6,now()-$7::interval)`,
        [
          id,
          id,
          input.owner ?? ownerId,
          input.decision ?? 'ignore',
          input.reason ?? `A useful decision. password=private-password ${secret}`,
          input.taskId ?? null,
          input.age ?? '0 seconds',
        ],
      );
      return id;
    }
    try {
      await db.initializeDatabase();
      await tasks.initializeTaskSchema();
      const createQueue = t.mock.method(tasks.boss, 'createQueue', async () => {});
      await createSchedules({
        pool: db.pool,
        ownerId,
        scheduler: tasks.boss,
        submitTask: tasks.submitTask,
        refresh() {},
      }).initialize({ workers: false });
      createQueue.mock.restore();
      await db.pool.query(
        "INSERT INTO conversations(owner_id,channel,revision) VALUES($1,'web',1)",
        [ownerId],
      );
      await db.pool.query(
        "INSERT INTO outcomes(id,owner_id,channel,conversation_revision,title,objective) VALUES($1,$2,'web',1,$3,'Private objective')",
        [outcomeId, ownerId, `Prepare the trip ${secret}`],
      );
      await task('running', { id: mainTask, outcome: outcomeId });
      await task('queued', { id: relatedTask, outcome: outcomeId });
      await task('waiting_credentials', { waiting: 'credentials' });
      await task('waiting_user', { waiting: 'approval' });
      await task('waiting_user', { waiting: 'manual_control' });
      await task('running', {
        id: reviewTask,
        source: 'event',
        title: 'Huge hourly reviewer system instruction',
      });
      await task('running', {
        id: scheduledTask,
        source: 'event',
        title: 'Huge scheduled instruction',
      });
      await task('running', { owner: 'foreign-owner' });
      await task('running', { revision: 0 });
      for (let index = 0; index < 55; index++) await task('succeeded');
      for (const id of [mainTask, relatedTask]) {
        const messageId = randomUUID();
        await db.pool.query(
          "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,$2,'user','Private pending follow-up',$3)",
          [messageId, ownerId, id],
        );
        await db.pool.query(
          'INSERT INTO pending_task_inputs(id,owner_id,task_id,message_id) VALUES($1,$2,$3,$4)',
          [randomUUID(), ownerId, id, messageId],
        );
      }
      await db.pool.query(
        `INSERT INTO schedules(id,owner_id,title,prompt,kind,run_at,next_run_at,time_zone,job_id)
      VALUES($1,$2,'Morning reminder','Private scheduled instruction','once','2035-10-29T09:00:00Z','2035-10-29T09:00:00Z','Europe/Lisbon',$3),
      ($4,'foreign-owner','Foreign schedule','Private','once',NULL,NULL,'UTC',NULL)`,
        [randomUUID(), ownerId, randomUUID(), randomUUID()],
      );
      await db.pool.query(
        `INSERT INTO schedule_runs(id,owner_id,schedule_id,schedule_revision,job_id,title,task_id,scheduled_for,time_zone)
      VALUES($1,$2,$3,0,$4,'Prepare monthly report',$5,now(),'Europe/Lisbon')`,
        [randomUUID(), ownerId, randomUUID(), randomUUID(), scheduledTask],
      );
      await notification({ taskId: reviewTask });
      await notification({ owner: 'foreign-owner' });
      await notification({ age: '2 days' });
      await t.test(
        'schema without notification kind remains readable and details stay private',
        async () => {
          const result = await app.inject({ url: '/api/inspector/work', headers });
          assert.equal(result.statusCode, 200, result.body);
          assert.equal(result.headers['cache-control'], 'no-store');
          const body = result.json();
          assert.equal(body.scope, 'owner');
          assert.equal(body.activeTotal, 6);
          const grouped = body.active.find((item: { taskId: string }) => item.taskId === mainTask);
          assert.equal(grouped.executions, 2);
          assert.equal(grouped.queuedInputs, 2);
          assert.match(grouped.title, /Prepare the trip/);
          assert.equal(
            body.active.some((item: { taskId: string }) => item.taskId === relatedTask),
            false,
          );
          assert.equal(body.upcomingTotal, 1);
          assert.equal(body.upcoming[0].runAt, '2035-10-29T09:00:00.000Z');
          assert.equal(body.upcoming[0].queued, true);
          assert.equal(body.upcoming[0].timeZone, 'Europe/Lisbon');
          assert.deepEqual(body.review, {
            configured: true,
            scheduled: true,
            cron: '0 * * * *',
            timeZone: 'UTC',
          });
          assert.equal(body.decisionsTotal, 1);
          assert.equal(body.decisions[0].kind, 'external');
          assert.doesNotMatch(
            result.body,
            /Private|Huge|foreign|fixture-provider-secret|private-password|Raw external/,
          );
          assert.equal(
            body.active.find((item: { taskId: string }) => item.taskId === scheduledTask).title,
            'Prepare monthly report',
          );
          assert.equal(
            body.active.find((item: { taskId: string }) => item.taskId === scheduledTask).source,
            'schedule',
          );
        },
      );
      await t.test(
        'typed decisions and bounded lists keep full counts without inventing schedule times',
        async () => {
          await db.pool.query(
            "ALTER TABLE notifications ADD COLUMN kind text NOT NULL DEFAULT 'external'",
          );
          await db.pool.query("UPDATE notifications SET kind='review' WHERE task_id=$1", [
            reviewTask,
          ]);
          for (let index = 0; index < 10; index++) {
            await task('queued');
            await notification();
            await db.pool.query(
              "INSERT INTO schedules(id,owner_id,title,prompt,time_zone) VALUES($1,$2,'Unscheduled reminder','Private','UTC')",
              [randomUUID(), ownerId],
            );
          }
          reviewAvailable = false;
          const result = await store.read();
          assert.equal(result.active.length, 12);
          assert.equal(result.activeTotal, 16);
          assert.equal(result.active[0].status, 'running');
          assert.equal(
            result.active.find((item) => item.taskId === reviewTask)!.title,
            'Review goals and recent updates',
          );
          assert.equal(result.active.find((item) => item.taskId === reviewTask)!.source, 'review');
          assert.equal(result.upcoming.length, 8);
          assert.equal(result.upcomingTotal, 11);
          assert.equal(result.upcoming.filter((item) => item.runAt === null).length, 7);
          assert.equal(result.upcoming.filter((item) => !item.queued).length, 7);
          assert.equal(result.decisions.length, 8);
          assert.equal(result.decisionsTotal, 11);
          assert.equal(result.decisionWindowHours, 24);
          assert.equal(result.review, null);
        },
      );
      await t.test(
        'access stays local and disabled or caller-scoped reads never query private state',
        async () => {
          assert.equal(
            (
              await app.inject({
                url: '/api/inspector/work',
                headers: { ...headers, 'sec-fetch-site': 'cross-site' },
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (await app.inject({ url: '/api/inspector/work?ownerId=foreign-owner', headers }))
              .statusCode,
            400,
          );
          assert.equal(
            (await app.inject({ url: `/api/inspector/work?taskId=${mainTask}`, headers }))
              .statusCode,
            400,
          );
          enabled = false;
          const query = t.mock.method(db.pool, 'query', () => {
            throw new Error('Disabled read must not query.');
          });
          assert.equal((await app.inject({ url: '/api/inspector/work', headers })).statusCode, 404);
          query.mock.restore();
        },
      );
    } finally {
      t.mock.restoreAll();
      await app.close();
      await db.pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
