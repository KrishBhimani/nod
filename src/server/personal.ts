import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from './db.ts';
import { ownerId } from './config.ts';
import { boss, submitTask } from './tasks.ts';
import { refresh } from './events.ts';
import type { FastifyInstance } from 'fastify';

const profileSchema = z.object({ name: z.string().max(100), location: z.string().max(200), phone: z.string().max(40), preferences: z.string().max(4000) }).strict();
const scheduleSchema = z.object({ title: z.string().min(1).max(100), prompt: z.string().min(1).max(6000), cron: z.string().max(100), timeZone: z.string().max(100) }).strict();
const goalSchema = z.object({ title: z.string().min(1).max(150), description: z.string().max(6000).default(''), targetDate: z.string().nullable().optional() }).strict();

export async function initializePersonal() {
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
  await boss.createQueue('scheduled-task', { retryLimit: 0 });
  await boss.work<{ scheduleId: string }>('scheduled-task', async jobs => {
    for (const job of jobs) {
      const result = await pool.query('SELECT * FROM schedules WHERE id=$1 AND owner_id=$2 AND enabled=true', [job.data.scheduleId, ownerId]);
      if (result.rowCount) await submitTask(`Scheduled task: ${result.rows[0].title}\n${result.rows[0].prompt}\nOnly send a message if there is a useful result, a problem or a necessary question.`, [], undefined, true, { sourceId: `schedule:${job.id}`, source: 'schedule' });
    }
  });
  const saved = await listSchedules();
  for (const schedule of saved) if (schedule.enabled) await boss.schedule('scheduled-task', schedule.cron, { scheduleId: schedule.id }, { key: schedule.id, tz: schedule.timeZone });
}

export async function getProfile() {
  const result = await pool.query('SELECT data FROM profiles WHERE owner_id=$1', [ownerId]);
  return { name: '', location: '', phone: '', preferences: '', ...result.rows[0]?.data };
}
async function setProfile(raw: unknown) {
  const data = profileSchema.parse(raw);
  await pool.query('INSERT INTO profiles(owner_id,data) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET data=$2', [ownerId, data]);
  refresh(); return data;
}
export async function listGoals() {
  return (await pool.query('SELECT id,title,description,progress,status,next_action AS "nextAction",target_date AS "targetDate",updated_at AS "updatedAt" FROM goals WHERE owner_id=$1 ORDER BY updated_at DESC', [ownerId])).rows;
}
async function createGoal(raw: unknown) {
  const input = goalSchema.parse(raw);
  const id = randomUUID();
  await pool.query('INSERT INTO goals(id,owner_id,title,description,target_date) VALUES($1,$2,$3,$4,$5)', [id, ownerId, input.title, input.description, input.targetDate || null]);
  refresh(); return { id, ...input };
}
async function updateGoal(raw: unknown) {
  const input = z.object({ id: z.uuid(), progress: z.number().int().min(0).max(100).optional(), nextAction: z.string().max(2000).optional(), status: z.enum(['active', 'paused', 'completed']).optional() }).strict().parse(raw);
  const result = await pool.query('UPDATE goals SET progress=COALESCE($3,progress),next_action=COALESCE($4,next_action),status=COALESCE($5,status),updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING id', [input.id, ownerId, input.progress, input.nextAction, input.status]);
  if (!result.rowCount) throw Object.assign(new Error('Goal not found.'), { statusCode: 404 });
  refresh(); return { ok: true };
}
export async function listSchedules() {
  return (await pool.query('SELECT id,title,prompt,cron,time_zone AS "timeZone",enabled FROM schedules WHERE owner_id=$1 ORDER BY created_at DESC', [ownerId])).rows;
}
async function createSchedule(raw: unknown) {
  const input = scheduleSchema.parse(raw);
  new Intl.DateTimeFormat('en', { timeZone: input.timeZone });
  if (input.cron.trim().split(/\s+/).length !== 5) throw Object.assign(new Error('Use a five-field cron schedule.'), { statusCode: 400 });
  const id = randomUUID();
  await boss.schedule('scheduled-task', input.cron, { scheduleId: id }, { key: id, tz: input.timeZone });
  try {
    await pool.query('INSERT INTO schedules(id,owner_id,title,prompt,cron,time_zone) VALUES($1,$2,$3,$4,$5,$6)', [id, ownerId, input.title, input.prompt, input.cron, input.timeZone]);
  } catch (error) { await boss.unschedule('scheduled-task', id); throw error; }
  refresh(); return { id, ...input, enabled: true };
}
async function cancelSchedule(id: string) {
  z.uuid().parse(id);
  const result = await pool.query('UPDATE schedules SET enabled=false WHERE id=$1 AND owner_id=$2 RETURNING id', [id, ownerId]);
  if (!result.rowCount) throw Object.assign(new Error('Schedule not found.'), { statusCode: 404 });
  await boss.unschedule('scheduled-task', id);
  refresh(); return { ok: true };
}
export async function managePersonal(action: string, args: Record<string, unknown>) {
  if (action === 'profile_get') return getProfile();
  if (action === 'profile_update') return setProfile({ ...await getProfile(), ...args });
  if (action === 'goal_list') return listGoals();
  if (action === 'goal_create') return createGoal(args);
  if (action === 'goal_update') return updateGoal(args);
  if (action === 'schedule_list') return listSchedules();
  if (action === 'schedule_create') return createSchedule(args);
  if (action === 'schedule_cancel') return cancelSchedule(String(args.id || ''));
  if (action === 'memory_propose') {
    const text = z.string().trim().min(1).max(2000).parse(args.text);
    await pool.query('INSERT INTO memory_facts(id,owner_id,text) VALUES($1,$2,$3) ON CONFLICT(owner_id,text) DO NOTHING', [randomUUID(), ownerId, text]);
    return { ok: true };
  }
  if (action === 'history_search') {
    const query = z.string().min(1).max(200).parse(args.query);
    const tasks = await pool.query("SELECT id,title,status,created_at FROM tasks WHERE owner_id=$1 AND to_tsvector('simple',title || ' ' || prompt) @@ plainto_tsquery('simple',$2) ORDER BY created_at DESC LIMIT 15", [ownerId, query]);
    const messages = await pool.query("SELECT role,text,task_id FROM messages WHERE owner_id=$1 AND to_tsvector('simple',text) @@ plainto_tsquery('simple',$2) ORDER BY created_at DESC LIMIT 15", [ownerId, query]);
    return { tasks: tasks.rows, messages: messages.rows };
  }
  throw new Error('This personal-data action is not available.');
}
export function registerPersonalRoutes(app: FastifyInstance) {
  app.get('/api/profile', getProfile);
  app.put('/api/profile', request => setProfile(request.body));
  app.get('/api/goals', listGoals);
  app.post('/api/goals', request => createGoal(request.body));
  app.patch('/api/goals/:id', request => updateGoal({ ...(request.body as object), id: (request.params as { id: string }).id }));
  app.get('/api/schedules', listSchedules);
  app.post('/api/schedules', request => createSchedule(request.body));
  app.delete<{ Params: { id: string } }>('/api/schedules/:id', request => cancelSchedule(request.params.id));
}
