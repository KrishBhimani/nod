import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { createPersonalService } from '../src/server/personal.ts';
import { readSchedule, scheduleExpression, scheduleLabel } from '../src/web/lib/schedules.ts';

test('daily and weekly schedule forms preserve local wall time and existing custom timing', () => {
  assert.equal(scheduleExpression('daily', '09:05', '1'), '5 9 * * *');
  assert.equal(scheduleExpression('weekly', '00:00', '0'), '0 0 * * 0');
  assert.deepEqual(readSchedule('5 9 * * 7'), { frequency: 'weekly', time: '09:05', day: '0' });
  assert.equal(scheduleLabel('5 9 * * *'), 'Every day at 09:05');
  assert.equal(scheduleLabel('0 8 * * 1'), 'Every Monday at 08:00');
  assert.equal(readSchedule('0 9 1 1 *').frequency, 'custom');
  assert.equal(scheduleExpression('custom', '09:00', '1', '0 9 1 1 *'), '0 9 1 1 *');
  assert.throws(() => scheduleExpression('weekly', '25:00', '1'));
  assert.throws(() => scheduleExpression('weekly', '09:00', '8'));
});

test(
  'personal data routes edit goals and manage owned recurring schedules with durable reloads',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_personal_${suffix}`;
    const bossSchema = `test_personal_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const scheduler = new PgBoss({
      connectionString: process.env.TEST_DATABASE_URL,
      schema: bossSchema,
      schedule: false,
      supervise: false,
    });
    const personal = createPersonalService({
      pool,
      ownerId: 'fixture-owner',
      scheduler,
      submitTask: async () => {
        throw new Error('No task execution is expected in this fixture.');
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
    const request = (
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url,
        ...(payload === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) }),
      });
    const storedSchedule = (id: string) =>
      pool.query(`SELECT cron,timezone FROM ${bossSchema}.schedule WHERE key=$1`, [id]);
    try {
      await scheduler.start();
      await personal.initialize({ workers: false });
      await pool.query(`CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text NOT NULL,role text NOT NULL);
        CREATE TABLE memory_facts(id uuid PRIMARY KEY,owner_id text NOT NULL,text text NOT NULL,
          source_message_id uuid REFERENCES messages(id),UNIQUE(owner_id,text))`);
      await t.test(
        'memory preserves trusted user-message provenance and rejects spoofed sources',
        async () => {
          const trustedId = randomUUID();
          const laterId = randomUUID();
          const foreignId = randomUUID();
          const assistantId = randomUUID();
          await pool.query(
            'INSERT INTO messages(id,owner_id,role) VALUES($1,$5,$6),($2,$5,$6),($3,$7,$6),($4,$5,$8)',
            [
              trustedId,
              laterId,
              foreignId,
              assistantId,
              'fixture-owner',
              'user',
              'another-owner',
              'assistant',
            ],
          );
          await personal.manage(
            'memory_propose',
            { text: 'Fixture prefers concise updates' },
            { sourceMessageId: trustedId },
          );
          await personal.manage(
            'memory_propose',
            { text: 'Fixture prefers concise updates' },
            { sourceMessageId: laterId },
          );
          const memory = await pool.query(
            'SELECT owner_id,source_message_id FROM memory_facts WHERE text=$1',
            ['Fixture prefers concise updates'],
          );
          assert.equal(memory.rowCount, 1);
          assert.deepEqual(memory.rows[0], {
            owner_id: 'fixture-owner',
            source_message_id: trustedId,
          });
          for (const sourceMessageId of [foreignId, assistantId, randomUUID()]) {
            await assert.rejects(
              personal.manage(
                'memory_propose',
                { text: 'Untrusted source must not save' },
                { sourceMessageId },
              ),
              { statusCode: 400, message: 'This memory source is unavailable.' },
            );
          }
          for (const spoof of [{ sourceMessageId: foreignId }, { source_message_id: foreignId }]) {
            await assert.rejects(
              personal.manage(
                'memory_propose',
                { text: 'Model source must not save', ...spoof },
                { sourceMessageId: trustedId },
              ),
              z.ZodError,
            );
          }
          await assert.rejects(
            personal.manage(
              'memory_propose',
              { text: 'Invalid source must not save' },
              { sourceMessageId: 'not-an-id' },
            ),
            z.ZodError,
          );
          assert.equal((await pool.query('SELECT * FROM memory_facts')).rowCount, 1);
          await personal.manage(
            'memory_propose',
            { text: 'Explicit direct fixture detail' },
            { sourceMessageId: null },
          );
          await personal.manage('memory_propose', { text: 'Explicit legacy fixture detail' });
          const direct = await pool.query(
            'SELECT text FROM memory_facts WHERE source_message_id IS NULL ORDER BY text',
          );
          assert.deepEqual(direct.rows, [
            { text: 'Explicit direct fixture detail' },
            { text: 'Explicit legacy fixture detail' },
          ]);
        },
      );
      await t.test('profile values remain explicit and owned', async () => {
        assert.equal(
          (
            await request('PUT', '/api/profile', {
              name: 'Fixture owner',
              location: 'Lisbon',
              phone: '',
              preferences: 'Brief answers',
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await request('PUT', '/api/profile', {
              name: 'Fixture',
              location: '',
              phone: '',
              preferences: '',
              ownerId: 'another-owner',
            })
          ).statusCode,
          400,
        );
        const another = createPersonalService({
          pool,
          ownerId: 'another-owner',
          scheduler,
          submitTask: async () => '',
          refresh() {},
        });
        assert.equal((await another.getProfile()).name, '');
        assert.equal((await personal.getProfile()).name, 'Fixture owner');
      });
      await t.test('goal fields update independently and clearing a date is durable', async () => {
        const created = await request('POST', '/api/goals', {
          title: 'Write a fixture report',
          description: 'A synthetic goal',
          targetDate: '2027-02-15',
        });
        assert.equal(created.statusCode, 200);
        const goal = created.json();
        assert.equal(goal.progress, 0);
        assert.equal(goal.status, 'active');
        assert.equal(
          (await request('PATCH', `/api/goals/${goal.id}`, { progress: 35 })).statusCode,
          200,
        );
        const unchanged = (await request('GET', '/api/goals')).json()[0];
        assert.equal(unchanged.description, 'A synthetic goal');
        assert.equal(unchanged.targetDate, '2027-02-15');
        const updated = await request('PATCH', `/api/goals/${goal.id}`, {
          title: 'Complete a fixture report',
          description: 'Updated details',
          targetDate: null,
          nextAction: 'Review the draft',
          progress: 60,
          status: 'paused',
        });
        assert.equal(updated.statusCode, 200);
        assert.equal(updated.json().title, 'Complete a fixture report');
        const reloaded = (await request('GET', '/api/goals')).json()[0];
        assert.equal(reloaded.targetDate, null);
        assert.equal(reloaded.nextAction, 'Review the draft');
        assert.equal(reloaded.status, 'paused');
        assert.equal(
          (
            await request('PATCH', `/api/goals/${goal.id}`, { progress: 100, status: 'completed' })
          ).json().status,
          'completed',
        );
        for (const payload of [
          { progress: 101 },
          { progress: 2.5 },
          { targetDate: '2027-02-30' },
          { title: '  ' },
          {},
          { ownerId: 'another-owner' },
        ])
          assert.equal((await request('PATCH', `/api/goals/${goal.id}`, payload)).statusCode, 400);
        await pool.query('UPDATE goals SET owner_id=$2 WHERE id=$1', [goal.id, 'another-owner']);
        assert.equal(
          (await request('PATCH', `/api/goals/${goal.id}`, { progress: 10 })).statusCode,
          404,
        );
        assert.deepEqual((await request('GET', '/api/goals')).json(), []);
      });
      await t.test(
        'schedule editing, pause, resume and deletion agree with the recurring queue',
        async () => {
          const created = await request('POST', '/api/schedules', {
            title: 'Fixture routine',
            prompt: 'Prepare a synthetic summary',
            cron: '5 9 * * *',
            timeZone: 'Europe/Lisbon',
          });
          assert.equal(created.statusCode, 200);
          const schedule = created.json();
          assert.equal(schedule.enabled, true);
          assert.equal((await storedSchedule(schedule.id)).rowCount, 1);
          const edited = await request('PATCH', `/api/schedules/${schedule.id}`, {
            title: 'Weekly fixture',
            prompt: 'Prepare a weekly summary',
            cron: '15 18 * * 1',
            timeZone: 'Europe/Paris',
          });
          assert.equal(edited.statusCode, 200);
          assert.equal((await storedSchedule(schedule.id)).rows[0].cron, '15 18 * * 1');
          assert.equal((await storedSchedule(schedule.id)).rows[0].timezone, 'Europe/Paris');
          assert.equal(
            (await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: false })).json()
              .enabled,
            false,
          );
          assert.equal((await storedSchedule(schedule.id)).rowCount, 0);
          assert.equal((await request('GET', '/api/schedules')).json()[0].enabled, false);
          await personal.initialize({ workers: false });
          assert.equal((await storedSchedule(schedule.id)).rowCount, 0);
          assert.equal(
            (await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: true })).json()
              .enabled,
            true,
          );
          assert.equal((await storedSchedule(schedule.id)).rowCount, 1);
          await personal.manage('schedule_cancel', { id: schedule.id });
          assert.equal((await storedSchedule(schedule.id)).rowCount, 0);
          assert.equal((await request('GET', '/api/schedules')).json().length, 1);
          await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: true });
          assert.equal((await request('DELETE', `/api/schedules/${schedule.id}`)).statusCode, 200);
          assert.equal((await storedSchedule(schedule.id)).rowCount, 0);
          assert.deepEqual((await request('GET', '/api/schedules')).json(), []);
          await personal.initialize({ workers: false });
          assert.equal((await storedSchedule(schedule.id)).rowCount, 0);
          assert.equal((await request('DELETE', `/api/schedules/${schedule.id}`)).statusCode, 404);
        },
      );
      await t.test(
        'invalid or foreign schedule changes do not alter the saved schedule or queue',
        async () => {
          const schedule = (
            await request('POST', '/api/schedules', {
              title: 'Protected fixture',
              prompt: 'Synthetic only',
              cron: '0 9 1 1 *',
              timeZone: 'Europe/Lisbon',
            })
          ).json();
          for (const payload of [
            { cron: '* * * * * *' },
            { cron: '60 9 * * *' },
            { timeZone: 'Invalid/Zone' },
            { title: ' ' },
            { enabled: 'yes' },
            {},
          ])
            assert.equal(
              (await request('PATCH', `/api/schedules/${schedule.id}`, payload)).statusCode,
              400,
            );
          assert.equal((await storedSchedule(schedule.id)).rows[0].cron, '0 9 1 1 *');
          assert.equal(
            (await request('GET', '/api/schedules')).json()[0].timeZone,
            'Europe/Lisbon',
          );
          const originalSchedule = scheduler.schedule.bind(scheduler);
          let failOnce = true;
          t.mock.method(
            scheduler,
            'schedule',
            async (...args: Parameters<typeof scheduler.schedule>) => {
              if (failOnce) {
                failOnce = false;
                throw new Error('Fixture queue write failure');
              }
              return originalSchedule(...args);
            },
          );
          assert.equal(
            (await request('PATCH', `/api/schedules/${schedule.id}`, { cron: '0 10 1 1 *' }))
              .statusCode,
            500,
          );
          assert.equal((await storedSchedule(schedule.id)).rows[0].cron, '0 9 1 1 *');
          assert.equal((await request('GET', '/api/schedules')).json()[0].cron, '0 9 1 1 *');
          await pool.query('UPDATE schedules SET owner_id=$2 WHERE id=$1', [
            schedule.id,
            'another-owner',
          ]);
          assert.equal(
            (await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: false }))
              .statusCode,
            404,
          );
          assert.equal((await request('DELETE', `/api/schedules/${schedule.id}`)).statusCode, 404);
          assert.equal((await storedSchedule(schedule.id)).rowCount, 1);
          assert.deepEqual((await request('GET', '/api/schedules')).json(), []);
        },
      );
    } finally {
      await app.close();
      await scheduler.stop({ graceful: false });
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
