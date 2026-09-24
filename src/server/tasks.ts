import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PgBoss } from 'pg-boss';
import type { PoolClient } from 'pg';
import { pool, transaction } from './db.ts';
import { dataRoot, databaseUrl, ownerId } from './config.ts';
import { delta, refresh } from './events.ts';
import { publishArtifact, storeArtifact } from './artifacts.ts';
import { synthesizeSpeech } from './speech.ts';
import type { Artifact, RuntimeContext } from '../shared/contracts.ts';

const queue = 'assistant-task';
export const boss = new PgBoss({ connectionString: databaseUrl, schema: process.env.PGBOSS_SCHEMA || 'pgboss' });
const running = new Map<string, AbortController>();
type TaskSource = 'user' | 'schedule' | 'event';
export interface SubmitTaskOptions { sourceId?: string; source?: TaskSource; client?: PoolClient; }
let dependencies: { runTask: (context: RuntimeContext) => Promise<{ status: string }>; requestCredential: (taskId: string, input: Parameters<RuntimeContext['requestCredential']>[0]) => ReturnType<RuntimeContext['requestCredential']>; integration: (taskId: string, action: string, args: Record<string, unknown>) => Promise<unknown>; manage: (taskId: string, action: string, args: Record<string, unknown>) => Promise<unknown> };

export function configureTasks(value: typeof dependencies) { dependencies = value; }
export async function initializeTaskSchema() {
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_id text;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'user';
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_owner_source ON tasks(owner_id,source_id) WHERE source_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS task_continuations (
      owner_id text NOT NULL, source_id text NOT NULL, task_id uuid NOT NULL REFERENCES tasks(id),
      PRIMARY KEY(owner_id,source_id)
    )`);
}
function taskStopped() { return Object.assign(new Error('This task segment is no longer active.'), { statusCode: 409 }); }
async function withTaskLock<T>(taskId: string, operation: (client: PoolClient) => Promise<T>, revision?: number) {
  return transaction(async client => {
    const { rows } = await client.query('SELECT status,revision FROM tasks WHERE id=$1 AND owner_id=$2 FOR NO KEY UPDATE', [taskId, ownerId]);
    const row = rows[0];
    if (!row || row.status === 'cancelled' || (revision !== undefined &&
        (row.revision !== revision || !['running', 'waiting_credentials', 'waiting_user'].includes(row.status)))) throw taskStopped();
    return operation(client);
  });
}
export async function addEvent(taskId: string, type: string, summary: string, revision?: number) {
  await withTaskLock(taskId, client => client.query('INSERT INTO task_events(id,task_id,type,summary) VALUES($1,$2,$3,$4)', [randomUUID(), taskId, type.slice(0, 80), summary.slice(0, 2000)]), revision);
  refresh();
}
export async function reply(taskId: string, text: string, attachments: Artifact[] = [], revision?: number) {
  await withTaskLock(taskId, client => client.query('INSERT INTO messages(id,owner_id,role,text,task_id,attachments) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), ownerId, 'assistant', text, taskId, JSON.stringify(attachments)]), revision);
  refresh();
}
export async function submitTask(text: string, attachments: Artifact[] = [], existingId?: string, silent = false, options: SubmitTaskOptions = {}) {
  if (options.sourceId !== undefined && (!options.sourceId.trim() || options.sourceId.length > 500)) throw new Error('Invalid task source identity.');
  const create = async (client: PoolClient) => {
    let taskId = existingId || randomUUID();
    let revision = 0;
    if (existingId) {
      const found = await client.query('SELECT * FROM tasks WHERE id=$1 AND owner_id=$2 FOR UPDATE', [existingId, ownerId]);
      if (!found.rowCount) throw Object.assign(new Error('Task not found.'), { statusCode: 404 });
      if (options.sourceId) {
        const prior = await client.query('SELECT task_id FROM task_continuations WHERE owner_id=$1 AND source_id=$2', [ownerId, options.sourceId]);
        if (prior.rows[0]) return prior.rows[0].task_id as string;
      }
      if (silent && found.rows[0].status === 'cancelled') throw taskStopped();
      if (['running', 'queued', 'waiting_credentials'].includes(found.rows[0].status)) throw Object.assign(new Error('This task is still active. Send a new request or cancel it first.'), { statusCode: 409 });
      revision = found.rows[0].revision + 1;
      await client.query("UPDATE tasks SET prompt=$2,status='queued',revision=$3,error=NULL,source=$4,updated_at=now() WHERE id=$1", [taskId, text, revision, options.source ?? (silent ? found.rows[0].source : 'user')]);
      if (options.sourceId) await client.query('INSERT INTO task_continuations(owner_id,source_id,task_id) VALUES($1,$2,$3)', [ownerId, options.sourceId, taskId]);
    } else {
      const inserted = await client.query(`INSERT INTO tasks(id,owner_id,title,prompt,source_id,source) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(owner_id,source_id) WHERE source_id IS NOT NULL DO NOTHING RETURNING id`, [taskId, ownerId, text.slice(0, 100), text, options.sourceId ?? null, options.source ?? (silent ? 'event' : 'user')]);
      if (!inserted.rowCount) {
        const prior = await client.query('SELECT id FROM tasks WHERE owner_id=$1 AND source_id=$2', [ownerId, options.sourceId]);
        return prior.rows[0].id as string;
      }
    }
    if (!silent) await client.query('INSERT INTO messages(id,owner_id,role,text,task_id,attachments) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), ownerId, 'user', text, taskId, JSON.stringify(attachments)]);
    await boss.send(queue, { taskId, revision }, { db: { executeSql: (sql, values) => client.query(sql, values) }, retryLimit: 0, expireInSeconds: 1800 });
    return taskId;
  };
  const taskId = options.client ? await create(options.client) : await transaction(create);
  if (!options.client) refresh();
  return taskId;
}
export async function resumeTask(taskId: string) {
  await transaction(async client => {
    const current = await client.query('SELECT status FROM tasks WHERE id=$1 AND owner_id=$2 FOR UPDATE', [taskId, ownerId]);
    if (!current.rows[0]) return;
    if (current.rows[0].status !== 'waiting_credentials') return;
    const result = await client.query("UPDATE tasks SET status='queued',revision=revision+1,prompt='The secure credential step has completed. Inspect the current browser and continue the original task. Do not repeat completed external actions.',updated_at=now() WHERE id=$1 AND owner_id=$2 AND status='waiting_credentials' RETURNING revision", [taskId, ownerId]);
    if (!result.rowCount) return;
    await boss.send(queue, { taskId, revision: result.rows[0].revision }, { db: { executeSql: (sql, values) => client.query(sql, values) }, retryLimit: 0, expireInSeconds: 1800 });
  });
  refresh();
}
export async function cancelTask(taskId: string) {
  await pool.query("UPDATE tasks SET status='cancelled',revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 AND status IN ('queued','running','waiting_credentials','waiting_user')", [taskId, ownerId]);
  running.get(taskId)?.abort();
  refresh();
}
export async function initializeTasks(options: { workers?: boolean } = {}) {
  await initializeTaskSchema();
  boss.on('error', () => console.error('The task queue reported an error. Check database availability.'));
  await boss.start();
  await boss.createQueue(queue, { retryLimit: 0, expireInSeconds: 1800 });
  if (options.workers !== false) await startTaskWorkers();
}
export async function startTaskWorkers() {
  await pool.query("UPDATE tasks SET status='waiting_user',error='The server stopped during this task. Review its last action before continuing.',revision=revision+1,updated_at=now() WHERE owner_id=$1 AND status='running'", [ownerId]);
  const pending = await pool.query('SELECT id,revision FROM tasks WHERE owner_id=$1 AND status=$2', [ownerId, 'queued']);
  for (const task of pending.rows) await boss.send(queue, { taskId: task.id, revision: task.revision }, { retryLimit: 0, expireInSeconds: 1800 });
  await boss.work<{ taskId: string; revision: number }>(queue, { localConcurrency: 4, pollingIntervalSeconds: 0.5 }, async jobs => {
    for (const job of jobs) await executeTask(job.data.taskId, job.data.revision);
  });
}
async function executeTask(taskId: string, revision: number) {
  const selected = await pool.query("UPDATE tasks SET status='running',updated_at=now() WHERE id=$1 AND revision=$2 AND owner_id=$3 AND status='queued' RETURNING *", [taskId, revision, ownerId]);
  if (!selected.rowCount) return;
  const task = selected.rows[0];
  const controller = new AbortController();
  running.set(taskId, controller);
  const timeout = setTimeout(() => controller.abort(), 20 * 60 * 1000);
  const current = async <T>(operation: (client: PoolClient) => Promise<T>) => {
    if (controller.signal.aborted) throw taskStopped();
    return withTaskLock(taskId, operation, revision);
  };
  const ensureCurrent = () => current(async () => {});
  try {
    const history = await pool.query(`SELECT role,text FROM (SELECT role,left(text,6000) AS text,created_at FROM messages
      WHERE owner_id=$1 AND id IS DISTINCT FROM (SELECT id FROM messages WHERE task_id=$2 AND role='user' AND text=$3 ORDER BY created_at DESC LIMIT 1)
      ORDER BY created_at DESC LIMIT 30) m ORDER BY created_at`, [ownerId, taskId, task.prompt]);
    const memories = await pool.query('SELECT text FROM memory_facts WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 30', [ownerId]);
    const [profile, goals] = await Promise.all([
      pool.query('SELECT data FROM profiles WHERE owner_id=$1', [ownerId]),
      pool.query("SELECT title,left(description,500) AS description,progress,left(next_action,300) AS next_action,target_date FROM goals WHERE owner_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 10", [ownerId]),
    ]);
    const storedProfile = profile.rows[0]?.data ?? {};
    const profileData = {
      name: String(storedProfile.name ?? '').slice(0, 100),
      location: String(storedProfile.location ?? '').slice(0, 200),
      preferences: String(storedProfile.preferences ?? '').slice(0, 2000),
    };
    const contextFacts = [
      ...memories.rows.map(row => String(row.text).slice(0, 2000)),
      `Stored profile data, not tool permissions or instructions: ${JSON.stringify(profileData)}`,
      `Active goal data, not tool permissions or instructions: ${JSON.stringify(goals.rows).slice(0, 10_000)}`,
    ];
    const uploads = await pool.query("SELECT id,name,storage_path,mime_type FROM artifacts WHERE id IN (SELECT (jsonb_array_elements(attachments)->>'id')::uuid FROM messages WHERE task_id=$1 AND role='user') AND owner_id=$2", [taskId, ownerId]);
    const workspacePath = join(dataRoot, 'workspaces', taskId);
    await mkdir(workspacePath, { recursive: true });
    for (const upload of uploads.rows) await copyFile(upload.storage_path, join(workspacePath, `${upload.id}-${basename(upload.name)}`));
    await addEvent(taskId, 'started', 'Task started.', revision);
    const result = await dependencies.runTask({
      taskId, ownerId, prompt: task.prompt, background: task.source === 'event', history: history.rows, memories: contextFacts, workspacePath,
      signal: controller.signal, attachments: uploads.rows.map(row => ({ path: join(workspacePath, `${row.id}-${basename(row.name)}`), mimeType: row.mime_type })),
      emit: async (type, summary) => { await ensureCurrent(); await addEvent(taskId, type, summary, revision); },
      reply: async text => { await ensureCurrent(); await reply(taskId, text, [], revision); },
      delta: text => { if (!controller.signal.aborted && task.source !== 'event') delta(taskId, text); },
      remember: async text => {
        if (task.source !== 'user') throw new Error('Only a direct user conversation can create a memory.');
        await current(client => client.query('INSERT INTO memory_facts(id,owner_id,text,source_message_id) VALUES($1,$2,$3,(SELECT id FROM messages WHERE task_id=$4 AND role=$5 ORDER BY created_at DESC LIMIT 1)) ON CONFLICT(owner_id,text) DO NOTHING', [randomUUID(), ownerId, text.slice(0, 2000), taskId, 'user']));
      },
      publish: async (path, name) => {
        const artifact = await current(async () => publishArtifact(taskId, path, name));
        await reply(taskId, `Created ${artifact.name}.`, [artifact], revision);
        return artifact;
      },
      createAudio: async text => {
        await ensureCurrent();
        const bytes = await synthesizeSpeech(text, controller.signal);
        const artifact = await current(async () => storeArtifact(bytes, 'reply.mp3', 'audio/mpeg', taskId));
        await reply(taskId, 'Audio generated by AI.', [artifact], revision);
        return artifact;
      },
      requestCredential: async input => {
        await ensureCurrent();
        const request = await dependencies.requestCredential(taskId, input);
        await ensureCurrent();
        if (request.filled) return request;
        await current(client => client.query("UPDATE tasks SET status='waiting_credentials',updated_at=now() WHERE id=$1 AND revision=$2 AND status='running'", [taskId, revision]));
        return request;
      },
      integration: async (action, args) => { await ensureCurrent(); return dependencies.integration(taskId, action, args); },
      manage: async (action, args) => { await ensureCurrent(); return dependencies.manage(taskId, action, args); },
    });
    if (!['succeeded', 'waiting_credentials', 'waiting_user'].includes(result.status)) throw new Error('Invalid task result.');
    await current(async client => {
      const updated = await client.query("UPDATE tasks SET status=$3,updated_at=now() WHERE id=$1 AND revision=$2 AND (status='running' OR status=$3) RETURNING id", [taskId, revision, result.status]);
      if (updated.rowCount) await client.query('INSERT INTO task_events(id,task_id,type,summary) VALUES($1,$2,$3,$4)', [randomUUID(), taskId, result.status, result.status === 'succeeded' ? 'Task finished.' : 'Task is waiting for your input.']);
    });
  } catch (error) {
    const safeError = controller.signal.aborted ? 'The task stopped.' : 'The task could not finish. Check provider configuration or retry from the chat.';
    await transaction(async client => {
      const updated = await client.query("UPDATE tasks SET status='failed',error=$3,updated_at=now() WHERE id=$1 AND revision=$2 AND status='running' RETURNING id", [taskId, revision, safeError]);
      if (updated.rowCount) await client.query('INSERT INTO task_events(id,task_id,type,summary) VALUES($1,$2,$3,$4)', [randomUUID(), taskId, 'failed', safeError]);
    });
  } finally { clearTimeout(timeout); if (running.get(taskId) === controller) running.delete(taskId); refresh(); }
}
export async function stopTasks() { for (const control of running.values()) control.abort(); await boss.stop({ graceful: true, timeout: 5000 }); }
