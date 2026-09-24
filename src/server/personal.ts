import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import type { FastifyInstance } from 'fastify';
import type { submitTask } from './tasks.ts';

const profileSchema = z
  .object({
    name: z.string().max(100),
    location: z.string().max(200),
    phone: z.string().max(40),
    preferences: z.string().max(4000),
  })
  .strict();
const scheduleSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).max(6000),
    cron: z.string().trim().min(1).max(100),
    timeZone: z.string().trim().min(1).max(100),
  })
  .strict();
const goalSchema = z
  .object({
    title: z.string().trim().min(1).max(150),
    description: z.string().max(6000).default(''),
    targetDate: z.iso.date().nullable().optional(),
  })
  .strict();
const goalUpdateSchema = goalSchema
  .partial()
  .extend({
    description: z.string().max(6000).optional(),
    progress: z.number().int().min(0).max(100).optional(),
    nextAction: z.string().max(2000).optional(),
    status: z.enum(['active', 'paused', 'completed']).optional(),
  })
  .strict();
const scheduleUpdateSchema = scheduleSchema
  .partial()
  .extend({ enabled: z.boolean().optional() })
  .strict();
const goalColumns =
  'id,title,description,progress,status,next_action AS "nextAction",target_date AS "targetDate",updated_at AS "updatedAt"';
const scheduleColumns = 'id,title,prompt,cron,time_zone AS "timeZone",enabled';
const scheduledQueue = 'scheduled-task';

interface PersonalDependencies {
  pool: Pool;
  ownerId: string;
  scheduler: Pick<PgBoss, 'createQueue' | 'work' | 'schedule' | 'unschedule' | 'previewSchedule'>;
  submitTask: typeof submitTask;
  refresh(): void;
}

export function createPersonalService(dependencies: PersonalDependencies) {
  const { pool, ownerId, scheduler, submitTask, refresh } = dependencies;

  async function initialize(options: { workers?: boolean } = {}) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS profiles (owner_id text PRIMARY KEY, data jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS goals (
        id uuid PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL, description text NOT NULL,
        progress integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'active', next_action text NOT NULL DEFAULT '',
        target_date text, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id uuid PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL, prompt text NOT NULL,
        cron text NOT NULL, time_zone text NOT NULL, enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await scheduler.createQueue(scheduledQueue, { retryLimit: 0 });
    if (options.workers !== false)
      await scheduler.work<{ scheduleId: string }>(scheduledQueue, async (jobs) => {
        for (const job of jobs) {
          const result = await pool.query(
            'SELECT * FROM schedules WHERE id=$1 AND owner_id=$2 AND enabled=true',
            [job.data.scheduleId, ownerId],
          );
          if (result.rowCount)
            await submitTask(
              `Scheduled task: ${result.rows[0].title}\n${result.rows[0].prompt}\nOnly send a message if there is a useful result, a problem or a necessary question.`,
              [],
              undefined,
              true,
              { sourceId: `schedule:${job.id}`, source: 'schedule' },
            );
        }
      });
    for (const schedule of await listSchedules()) await applySchedule(schedule);
  }

  async function getProfile() {
    const result = await pool.query('SELECT data FROM profiles WHERE owner_id=$1', [ownerId]);
    return { name: '', location: '', phone: '', preferences: '', ...result.rows[0]?.data };
  }

  async function setProfile(raw: unknown) {
    const data = profileSchema.parse(raw);
    await pool.query(
      'INSERT INTO profiles(owner_id,data) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET data=$2',
      [ownerId, data],
    );
    refresh();
    return data;
  }

  async function listGoals() {
    return (
      await pool.query(
        `SELECT ${goalColumns} FROM goals WHERE owner_id=$1 ORDER BY updated_at DESC,id`,
        [ownerId],
      )
    ).rows;
  }

  async function createGoal(raw: unknown) {
    const input = goalSchema.parse(raw);
    const result = await pool.query(
      `INSERT INTO goals(id,owner_id,title,description,target_date) VALUES($1,$2,$3,$4,$5) RETURNING ${goalColumns}`,
      [randomUUID(), ownerId, input.title, input.description, input.targetDate ?? null],
    );
    refresh();
    return result.rows[0];
  }

  async function updateGoal(id: string, raw: unknown) {
    z.uuid().parse(id);
    const input = goalUpdateSchema.parse(raw);
    if (!Object.keys(input).length)
      throw Object.assign(new Error('Choose a goal detail to update.'), { statusCode: 400 });
    const result = await pool.query(
      `UPDATE goals SET title=COALESCE($3,title),description=COALESCE($4,description),
      progress=COALESCE($5,progress),next_action=COALESCE($6,next_action),status=COALESCE($7,status),
      target_date=CASE WHEN $8 THEN $9 ELSE target_date END,updated_at=now()
      WHERE id=$1 AND owner_id=$2 RETURNING ${goalColumns}`,
      [
        id,
        ownerId,
        input.title,
        input.description,
        input.progress,
        input.nextAction,
        input.status,
        'targetDate' in input,
        input.targetDate,
      ],
    );
    if (!result.rowCount) throw Object.assign(new Error('Goal not found.'), { statusCode: 404 });
    refresh();
    return result.rows[0];
  }

  async function listSchedules() {
    return (
      await pool.query(
        `SELECT ${scheduleColumns} FROM schedules WHERE owner_id=$1 ORDER BY created_at DESC,id`,
        [ownerId],
      )
    ).rows;
  }

  function validateSchedule(input: z.infer<typeof scheduleSchema>) {
    if (input.cron.split(/\s+/).length !== 5)
      throw Object.assign(new Error('Use a five-field cron schedule.'), { statusCode: 400 });
    try {
      scheduler.previewSchedule(input.cron, { tz: input.timeZone, count: 1 });
    } catch {
      throw Object.assign(new Error('Check the schedule and time zone.'), { statusCode: 400 });
    }
  }

  async function applySchedule(schedule: {
    id: string;
    enabled: boolean;
    cron: string;
    timeZone: string;
  }) {
    if (schedule.enabled)
      await scheduler.schedule(
        scheduledQueue,
        schedule.cron,
        { scheduleId: schedule.id },
        { key: schedule.id, tz: schedule.timeZone },
      );
    else await scheduler.unschedule(scheduledQueue, schedule.id);
  }

  async function createSchedule(raw: unknown) {
    const input = scheduleSchema.parse(raw);
    validateSchedule(input);
    const id = randomUUID();
    await scheduler.schedule(
      scheduledQueue,
      input.cron,
      { scheduleId: id },
      { key: id, tz: input.timeZone },
    );
    try {
      const result = await pool.query(
        `INSERT INTO schedules(id,owner_id,title,prompt,cron,time_zone) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${scheduleColumns}`,
        [id, ownerId, input.title, input.prompt, input.cron, input.timeZone],
      );
      refresh();
      return result.rows[0];
    } catch (error) {
      await scheduler.unschedule(scheduledQueue, id);
      throw error;
    }
  }

  async function updateSchedule(id: string, raw: unknown) {
    z.uuid().parse(id);
    const input = scheduleUpdateSchema.parse(raw);
    if (!Object.keys(input).length)
      throw Object.assign(new Error('Choose a schedule detail to update.'), { statusCode: 400 });
    const client = await pool.connect();
    let previous: { id: string; enabled: boolean; cron: string; timeZone: string } | undefined;
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT ${scheduleColumns} FROM schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
        [id, ownerId],
      );
      if (!found.rowCount)
        throw Object.assign(new Error('Schedule not found.'), { statusCode: 404 });
      const next = { ...found.rows[0], ...input };
      validateSchedule(next);
      previous = found.rows[0];
      await applySchedule(next);
      const result = await client.query(
        `UPDATE schedules SET title=$3,prompt=$4,cron=$5,time_zone=$6,enabled=$7 WHERE id=$1 AND owner_id=$2 RETURNING ${scheduleColumns}`,
        [id, ownerId, next.title, next.prompt, next.cron, next.timeZone, next.enabled],
      );
      await client.query('COMMIT');
      refresh();
      return result.rows[0];
    } catch (error) {
      try {
        if (previous) await applySchedule(previous);
      } finally {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function deleteSchedule(id: string) {
    z.uuid().parse(id);
    const client = await pool.connect();
    let previous: { id: string; enabled: boolean; cron: string; timeZone: string } | undefined;
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT ${scheduleColumns} FROM schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
        [id, ownerId],
      );
      if (!found.rowCount)
        throw Object.assign(new Error('Schedule not found.'), { statusCode: 404 });
      previous = found.rows[0];
      await scheduler.unschedule(scheduledQueue, id);
      await client.query('DELETE FROM schedules WHERE id=$1 AND owner_id=$2', [id, ownerId]);
      await client.query('COMMIT');
      refresh();
      return { ok: true };
    } catch (error) {
      try {
        if (previous) await applySchedule(previous);
      } finally {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function manage(
    action: string,
    args: Record<string, unknown>,
    provenance?: { sourceMessageId: string | null },
  ) {
    if (action === 'profile_get') return getProfile();
    if (action === 'profile_update') return setProfile({ ...(await getProfile()), ...args });
    if (action === 'goal_list') return listGoals();
    if (action === 'goal_create') return createGoal(args);
    if (action === 'goal_update') {
      const { id, ...input } = args;
      return updateGoal(String(id || ''), input);
    }
    if (action === 'schedule_list') return listSchedules();
    if (action === 'schedule_create') return createSchedule(args);
    if (action === 'schedule_update') {
      const { id, ...input } = args;
      return updateSchedule(String(id || ''), input);
    }
    if (action === 'schedule_cancel')
      return updateSchedule(String(args.id || ''), { enabled: false });
    if (action === 'memory_propose') {
      const { text } = z
        .object({ text: z.string().trim().min(1).max(2000) })
        .strict()
        .parse(args);
      const sourceMessageId = z
        .uuid()
        .nullable()
        .parse(provenance?.sourceMessageId ?? null);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (sourceMessageId) {
          const source = await client.query(
            "SELECT id FROM messages WHERE id=$1 AND owner_id=$2 AND role='user' FOR SHARE",
            [sourceMessageId, ownerId],
          );
          if (!source.rowCount)
            throw Object.assign(new Error('This memory source is unavailable.'), {
              statusCode: 400,
            });
        }
        await client.query(
          'INSERT INTO memory_facts(id,owner_id,text,source_message_id) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,text) DO NOTHING',
          [randomUUID(), ownerId, text, sourceMessageId],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      refresh();
      return { ok: true };
    }
    if (action === 'history_search') {
      const query = z.string().min(1).max(200).parse(args.query);
      const tasks = await pool.query(
        "SELECT id,title,status,created_at FROM tasks WHERE owner_id=$1 AND to_tsvector('simple',title || ' ' || prompt) @@ plainto_tsquery('simple',$2) ORDER BY created_at DESC LIMIT 15",
        [ownerId, query],
      );
      const messages = await pool.query(
        "SELECT role,text,task_id FROM messages WHERE owner_id=$1 AND to_tsvector('simple',text) @@ plainto_tsquery('simple',$2) ORDER BY created_at DESC LIMIT 15",
        [ownerId, query],
      );
      return { tasks: tasks.rows, messages: messages.rows };
    }
    throw new Error('This personal-data action is not available.');
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/profile', getProfile);
    app.put('/api/profile', (request) => setProfile(request.body));
    app.get('/api/goals', listGoals);
    app.post('/api/goals', (request) => createGoal(request.body));
    app.patch<{ Params: { id: string } }>('/api/goals/:id', (request) =>
      updateGoal(request.params.id, request.body),
    );
    app.get('/api/schedules', listSchedules);
    app.post('/api/schedules', (request) => createSchedule(request.body));
    app.patch<{ Params: { id: string } }>('/api/schedules/:id', (request) =>
      updateSchedule(request.params.id, request.body),
    );
    app.delete<{ Params: { id: string } }>('/api/schedules/:id', (request) =>
      deleteSchedule(request.params.id),
    );
  }

  return { initialize, getProfile, listGoals, listSchedules, manage, registerRoutes };
}
