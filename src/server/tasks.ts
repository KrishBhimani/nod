import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PgBoss } from 'pg-boss';
import type { PoolClient } from 'pg';
import { pool, transaction } from './db.ts';
import { dataRoot, databaseUrl, ownerId } from './config.ts';
import { delta, refresh } from './events.ts';
import { publishArtifact, storeArtifact } from './artifacts.ts';
import type { SpeechService } from './speech.ts';
import type { Artifact } from '../shared/contracts.ts';
import type { RuntimeContext, RuntimeResult } from '../ports/agent.ts';

const queue = 'assistant-task';
export const boss = new PgBoss({
  connectionString: databaseUrl,
  schema: process.env.PGBOSS_SCHEMA || 'pgboss',
});
const running = new Map<string, AbortController>();
type TaskSource = 'user' | 'schedule' | 'event';
export interface SubmitTaskOptions {
  sourceId?: string;
  source?: TaskSource;
  channel?: string;
  client?: PoolClient;
}
export interface TaskDependencies {
  runTask: (
    context: RuntimeContext,
  ) => Promise<{ status: string; waitingFor?: RuntimeResult['waitingFor']; question?: string }>;
  speech: Pick<SpeechService, 'synthesize'>;
  requestCredential: (
    taskId: string,
    input: Parameters<RuntimeContext['requestCredential']>[0],
  ) => ReturnType<RuntimeContext['requestCredential']>;
  integration: (taskId: string, action: string, args: Record<string, unknown>) => Promise<unknown>;
  manage: (
    taskId: string,
    action: string,
    args: Record<string, unknown>,
    provenance: { taskId: string; sourceMessageId: string | null },
  ) => Promise<unknown>;
}
export async function initializeTaskSchema() {
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_id text;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'user';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'web';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS waiting_reason text;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS waiting_question text;
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_owner_source ON tasks(owner_id,source_id) WHERE source_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS task_continuations (
      owner_id text NOT NULL, source_id text NOT NULL, task_id uuid NOT NULL REFERENCES tasks(id),
      PRIMARY KEY(owner_id,source_id)
    );
    UPDATE tasks SET waiting_reason='question',waiting_question=(SELECT text FROM messages WHERE task_id=tasks.id AND role='assistant' ORDER BY created_at DESC LIMIT 1)
    WHERE status='waiting_user' AND waiting_reason IS NULL AND error IS NULL
    AND (SELECT summary FROM task_events WHERE task_id=tasks.id AND type='tool_start' ORDER BY created_at DESC LIMIT 1)='ask user'`);
}
function taskStopped() {
  return Object.assign(new Error('This task segment is no longer active.'), { statusCode: 409 });
}
async function withTaskLock<T>(
  taskId: string,
  operation: (client: PoolClient) => Promise<T>,
  revision?: number,
) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      'SELECT status,revision FROM tasks WHERE id=$1 AND owner_id=$2 FOR NO KEY UPDATE',
      [taskId, ownerId],
    );
    const row = rows[0];
    if (
      !row ||
      row.status === 'cancelled' ||
      (revision !== undefined &&
        (row.revision !== revision ||
          !['running', 'waiting_credentials', 'waiting_user'].includes(row.status)))
    )
      throw taskStopped();
    return operation(client);
  });
}
export async function addEvent(taskId: string, type: string, summary: string, revision?: number) {
  await withTaskLock(
    taskId,
    (client) =>
      client.query('INSERT INTO task_events(id,task_id,type,summary) VALUES($1,$2,$3,$4)', [
        randomUUID(),
        taskId,
        type.slice(0, 80),
        summary.slice(0, 2000),
      ]),
    revision,
  );
  refresh();
}
export async function reply(
  taskId: string,
  text: string,
  attachments: Artifact[] = [],
  revision?: number,
  streamId?: string,
) {
  await withTaskLock(
    taskId,
    (client) =>
      client.query(
        'INSERT INTO messages(id,owner_id,role,text,task_id,attachments,stream_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          ownerId,
          'assistant',
          text,
          taskId,
          JSON.stringify(attachments),
          streamId ?? null,
        ],
      ),
    revision,
  );
  refresh();
}
export async function submitTask(
  text: string,
  attachments: Artifact[] = [],
  existingId?: string,
  silent = false,
  options: SubmitTaskOptions = {},
) {
  if (options.sourceId !== undefined && (!options.sourceId.trim() || options.sourceId.length > 500))
    throw new Error('Invalid task source identity.');
  if (options.channel !== undefined && !/^[a-z][a-z0-9:_-]{0,79}$/.test(options.channel))
    throw new Error('Invalid conversation channel.');
  const create = async (client: PoolClient) => {
    let taskId = existingId || randomUUID();
    let revision = 0;
    if (existingId) {
      const found = await client.query(
        'SELECT * FROM tasks WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [existingId, ownerId],
      );
      if (!found.rowCount) throw Object.assign(new Error('Task not found.'), { statusCode: 404 });
      if (options.sourceId) {
        const prior = await client.query(
          'SELECT task_id FROM task_continuations WHERE owner_id=$1 AND source_id=$2',
          [ownerId, options.sourceId],
        );
        if (prior.rows[0]) return prior.rows[0].task_id as string;
      }
      if (silent && found.rows[0].status === 'cancelled') throw taskStopped();
      if (['running', 'queued', 'waiting_credentials'].includes(found.rows[0].status))
        throw Object.assign(
          new Error('This task is still active. Send a new request or cancel it first.'),
          { statusCode: 409 },
        );
      revision = found.rows[0].revision + 1;
      await client.query(
        "UPDATE tasks SET prompt=$2,status='queued',revision=$3,error=NULL,source=$4,waiting_reason=NULL,waiting_question=NULL,updated_at=now() WHERE id=$1",
        [taskId, text, revision, options.source ?? (silent ? found.rows[0].source : 'user')],
      );
      if (options.sourceId)
        await client.query(
          'INSERT INTO task_continuations(owner_id,source_id,task_id) VALUES($1,$2,$3)',
          [ownerId, options.sourceId, taskId],
        );
    } else {
      const inserted = await client.query(
        `INSERT INTO tasks(id,owner_id,title,prompt,source_id,source,channel) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(owner_id,source_id) WHERE source_id IS NOT NULL DO NOTHING RETURNING id`,
        [
          taskId,
          ownerId,
          text.slice(0, 100),
          text,
          options.sourceId ?? null,
          options.source ?? (silent ? 'event' : 'user'),
          options.channel ?? 'web',
        ],
      );
      if (!inserted.rowCount) {
        const prior = await client.query(
          'SELECT id FROM tasks WHERE owner_id=$1 AND source_id=$2',
          [ownerId, options.sourceId],
        );
        return prior.rows[0].id as string;
      }
    }
    if (!silent)
      await client.query(
        'INSERT INTO messages(id,owner_id,role,text,task_id,attachments) VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(), ownerId, 'user', text, taskId, JSON.stringify(attachments)],
      );
    await boss.send(
      queue,
      { taskId, revision },
      {
        db: { executeSql: (sql, values) => client.query(sql, values) },
        retryLimit: 0,
        expireInSeconds: 1800,
      },
    );
    return taskId;
  };
  const taskId = options.client ? await create(options.client) : await transaction(create);
  if (!options.client) refresh();
  return taskId;
}
export interface SubmitUserMessageOptions {
  taskId?: string;
  forceNew?: boolean;
  sourceId?: string;
  channel?: string;
  client?: PoolClient;
}
function isShortAnswer(text: string, attachments: Artifact[]) {
  const value = text.trim();
  if (
    !value ||
    attachments.length ||
    value.length > 120 ||
    value.split(/\s+/).length > 8 ||
    value.endsWith('?')
  )
    return false;
  if (
    /\b(?:open|install|send|create|write|research|search|find|download|delete|remove|run|execute|browse|visit|check|summarize|summarise|translate|book|schedule|remind|click|navigate|reply|show|tell|connect|plan|calculate|compute|describe|explain|draft|compare|convert|fix|update|edit|change|build|generate|solve|analyze|analyse|use|do|help|start|stop|cancel|restart|weather|sign in|log in|abre|instala|envia|cria|pesquisa|procura|apaga|remove|executa|visita|verifica|resume|traduz|reserva|agenda|clica|navega|responde|mostra|liga|planeia|calcula|descreve|explica|compara|corrige)\b/i.test(
      value.replace(/^i use\s+/i, ''),
    )
  )
    return false;
  if (
    /^(?:my (?:name|username|email|phone|number|location|budget) is|i(?:'m| am| live in| prefer| like| use| work)|o meu (?:nome|número|numero|email) é|chamo-me|vivo em|moro em|prefiro)\s+/i.test(
      value,
    )
  )
    return true;
  if (
    /^(?:yes|no|yep|nope|sure|ok|okay|go ahead|sim|não|claro)(?:[, ]+(?:please|thanks|thank you|obrigado|obrigada))?[.!]?$/i.test(
      value,
    )
  )
    return true;
  if (
    /^(?:@?[\p{L}\p{N}_][\p{L}\p{N}_.-]*|[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/u.test(
      value,
    )
  )
    return true;
  if (
    /^\p{Lu}[\p{L}\p{M}'’-]*(?:\s+(?:(?:de|da|do|dos|das|van|von)\s+)?\p{Lu}[\p{L}\p{M}'’-]*){1,3}$/u.test(
      value,
    )
  )
    return true;
  if (
    /^(?:[$€£]\s*)?\d[\d.,:/ -]*(?:\s*(?:am|pm|euros?|dollars?|usd|eur|gbp|minutes?|hours?|days?|people|pessoas))?$/i.test(
      value,
    )
  )
    return true;
  return /^(?:(?:on|at|by|next|this|na|no|próxima|próximo)\s+)?(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hoje|amanhã|segunda|terça|quarta|quinta|sexta|sábado|domingo)(?:\s+(?:at|às))?(?:\s+\d{1,2}(?::\d{2})?(?:\s*[ap]m)?)?$/i.test(
    value,
  );
}
export async function submitUserMessage(
  text: string,
  attachments: Artifact[] = [],
  options: SubmitUserMessageOptions = {},
): Promise<{ taskId: string; continued: boolean }> {
  const route = async (client: PoolClient) => {
    const channel = options.channel ?? 'web';
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `message:${ownerId}:${channel}`,
    ]);
    if (options.sourceId) {
      const prior = await client.query(
        `SELECT task_id AS id,true AS continued FROM task_continuations WHERE owner_id=$1 AND source_id=$2
        UNION ALL SELECT id,false AS continued FROM tasks WHERE owner_id=$1 AND source_id=$2 LIMIT 1`,
        [ownerId, options.sourceId],
      );
      if (prior.rows[0])
        return {
          taskId: prior.rows[0].id as string,
          continued: prior.rows[0].continued as boolean,
        };
    }
    let existingId = options.taskId;
    if (existingId) {
      const selected = await client.query(
        'SELECT channel,waiting_reason FROM tasks WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [existingId, ownerId],
      );
      if (!selected.rows[0] || selected.rows[0].channel !== channel)
        throw Object.assign(new Error('Task not found in this conversation.'), { statusCode: 404 });
      if (selected.rows[0].waiting_reason === 'approval')
        throw Object.assign(new Error('Review the requested action before continuing this task.'), {
          statusCode: 409,
        });
    } else if (!options.forceNew && isShortAnswer(text, attachments)) {
      const waiting = await client.query(
        `SELECT id,title,waiting_question AS question FROM tasks WHERE owner_id=$1 AND channel=$2
        AND status='waiting_user' AND waiting_reason='question' ORDER BY updated_at DESC LIMIT 10 FOR UPDATE`,
        [ownerId, channel],
      );
      if (waiting.rows.length > 1)
        throw Object.assign(new Error('Which task is this answer for?'), {
          statusCode: 409,
          code: 'task_selection_required',
          choices: waiting.rows,
        });
      existingId = waiting.rows[0]?.id;
    }
    const taskId = await submitTask(text, attachments, existingId, false, {
      sourceId: options.sourceId,
      source: 'user',
      channel,
      client,
    });
    return { taskId, continued: Boolean(existingId) };
  };
  const result = options.client ? await route(options.client) : await transaction(route);
  if (!options.client) refresh();
  return result;
}
export async function restartOnboarding() {
  const result = await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `message:${ownerId}:web`,
    ]);
    const superseded = await client.query(
      "UPDATE tasks SET status='cancelled',revision=revision+1,updated_at=now() WHERE owner_id=$1 AND source='user' AND channel='web' AND source_id LIKE 'onboarding:%' AND status IN ('queued','running','waiting_user','waiting_credentials') RETURNING id",
      [ownerId],
    );
    const next = await submitUserMessage(
      'Help me get set up. Use what you already know about me, help me connect the tools I need, and ask one short question about what I want to work on. Do not repeat questions I have already answered.',
      [],
      { forceNew: true, channel: 'web', sourceId: `onboarding:${randomUUID()}`, client },
    );
    return { ...next, superseded: superseded.rows.map((row) => row.id as string) };
  });
  for (const id of result.superseded) running.get(id)?.abort();
  refresh();
  return { taskId: result.taskId, continued: result.continued };
}
export async function resumeTask(taskId: string) {
  await transaction(async (client) => {
    const current = await client.query(
      'SELECT status FROM tasks WHERE id=$1 AND owner_id=$2 FOR UPDATE',
      [taskId, ownerId],
    );
    if (!current.rows[0]) return;
    if (current.rows[0].status !== 'waiting_credentials') return;
    const result = await client.query(
      "UPDATE tasks SET status='queued',revision=revision+1,waiting_reason=NULL,waiting_question=NULL,prompt='The secure credential step has completed. Inspect the current browser and continue the original task. Do not repeat completed external actions.',updated_at=now() WHERE id=$1 AND owner_id=$2 AND status='waiting_credentials' RETURNING revision",
      [taskId, ownerId],
    );
    if (!result.rowCount) return;
    await boss.send(
      queue,
      { taskId, revision: result.rows[0].revision },
      {
        db: { executeSql: (sql, values) => client.query(sql, values) },
        retryLimit: 0,
        expireInSeconds: 1800,
      },
    );
  });
  refresh();
}
export async function cancelTask(taskId: string) {
  await pool.query(
    "UPDATE tasks SET status='cancelled',revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 AND status IN ('queued','running','waiting_credentials','waiting_user')",
    [taskId, ownerId],
  );
  running.get(taskId)?.abort();
  refresh();
}
export async function retryTaskCredentials(taskId: string, expectedRevision: number) {
  await transaction(async (client) => {
    const result = await client.query(
      "UPDATE tasks SET status='queued',revision=revision+1,waiting_reason=NULL,waiting_question=NULL,prompt='The previous secure sign-in link expired. Inspect the current browser and request a fresh secure credential link if sign-in is still required. Do not repeat completed actions.',updated_at=now() WHERE id=$1 AND owner_id=$2 AND revision=$3 AND status='waiting_credentials' RETURNING revision",
      [taskId, ownerId, expectedRevision],
    );
    if (!result.rowCount) throw taskStopped();
    await boss.send(
      queue,
      { taskId, revision: result.rows[0].revision },
      {
        db: { executeSql: (sql, values) => client.query(sql, values) },
        retryLimit: 0,
        expireInSeconds: 1800,
      },
    );
  });
  refresh();
}
export async function initializeTasks() {
  await initializeTaskSchema();
  boss.on('error', () =>
    console.error('The task queue reported an error. Check database availability.'),
  );
  await boss.start();
  await boss.createQueue(queue, { retryLimit: 0, expireInSeconds: 1800 });
}
export async function startTaskWorkers(dependencies: TaskDependencies) {
  await pool.query(
    "UPDATE tasks SET status='waiting_user',waiting_reason='recovery',waiting_question=NULL,error='The server stopped during this task. Review its last action before continuing.',revision=revision+1,updated_at=now() WHERE owner_id=$1 AND status='running'",
    [ownerId],
  );
  const pending = await pool.query(
    'SELECT id,revision FROM tasks WHERE owner_id=$1 AND status=$2',
    [ownerId, 'queued'],
  );
  for (const task of pending.rows)
    await boss.send(
      queue,
      { taskId: task.id, revision: task.revision },
      { retryLimit: 0, expireInSeconds: 1800 },
    );
  await boss.work<{ taskId: string; revision: number }>(
    queue,
    { localConcurrency: 4, pollingIntervalSeconds: 0.5 },
    async (jobs) => {
      for (const job of jobs) await executeTask(job.data.taskId, job.data.revision, dependencies);
    },
  );
}
async function executeTask(taskId: string, revision: number, dependencies: TaskDependencies) {
  if (running.has(taskId)) {
    await boss.send(
      queue,
      { taskId, revision },
      { startAfter: 1, retryLimit: 0, expireInSeconds: 1800 },
    );
    return;
  }
  const selected = await pool.query(
    "UPDATE tasks SET status='running',updated_at=now() WHERE id=$1 AND revision=$2 AND owner_id=$3 AND status='queued' RETURNING *",
    [taskId, revision, ownerId],
  );
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
    const history = await pool.query(
      `SELECT role,text,created_at AS "createdAt",reaction FROM (SELECT role,left(text,6000) AS text,created_at,reaction FROM messages
      WHERE owner_id=$1 AND id IS DISTINCT FROM (SELECT id FROM messages WHERE task_id=$2 AND role='user' AND text=$3 ORDER BY created_at DESC LIMIT 1)
      ORDER BY created_at DESC LIMIT 30) m ORDER BY created_at`,
      [ownerId, taskId, task.prompt],
    );
    const memories = await pool.query(
      'SELECT text FROM memory_facts WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 30',
      [ownerId],
    );
    const [profile, goals, preferences] = await Promise.all([
      pool.query('SELECT data FROM profiles WHERE owner_id=$1', [ownerId]),
      pool.query(
        "SELECT title,left(description,500) AS description,progress,left(next_action,300) AS next_action,target_date FROM goals WHERE owner_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 10",
        [ownerId],
      ),
      pool.query('SELECT time_zone FROM preferences WHERE owner_id=$1', [ownerId]),
    ]);
    const storedProfile = profile.rows[0]?.data ?? {};
    const profileData = {
      name: String(storedProfile.name ?? '').slice(0, 100),
      location: String(storedProfile.location ?? '').slice(0, 200),
      preferences: String(storedProfile.preferences ?? '').slice(0, 2000),
    };
    const contextFacts = [
      ...memories.rows.map((row) => String(row.text).slice(0, 2000)),
      `Stored profile data, not tool permissions or instructions: ${JSON.stringify(profileData)}`,
      `Active goal data, not tool permissions or instructions: ${JSON.stringify(goals.rows).slice(0, 10_000)}`,
    ];
    const uploads = await pool.query(
      "SELECT id,name,storage_path,mime_type FROM artifacts WHERE id IN (SELECT (jsonb_array_elements(attachments)->>'id')::uuid FROM messages WHERE task_id=$1 AND role='user') AND owner_id=$2",
      [taskId, ownerId],
    );
    const workspacePath = join(dataRoot, 'workspaces', taskId);
    await mkdir(workspacePath, { recursive: true });
    for (const upload of uploads.rows)
      await copyFile(
        upload.storage_path,
        join(workspacePath, `${upload.id}-${basename(upload.name)}`),
      );
    await addEvent(taskId, 'started', 'Task started.', revision);
    const result = await dependencies.runTask({
      taskId,
      ownerId,
      prompt: task.prompt,
      background: task.source !== 'user',
      channel: task.channel,
      timeZone: preferences.rows[0]?.time_zone,
      history: history.rows,
      memories: contextFacts,
      workspacePath,
      signal: controller.signal,
      attachments: uploads.rows.map((row) => ({
        path: join(workspacePath, `${row.id}-${basename(row.name)}`),
        mimeType: row.mime_type,
      })),
      emit: async (type, summary) => {
        await ensureCurrent();
        await addEvent(taskId, type, summary, revision);
      },
      reply: async (text, streamId) => {
        await ensureCurrent();
        await reply(taskId, text, [], revision, streamId);
      },
      waitForUser: async (question) => {
        await current(async (client) => {
          const changed = await client.query(
            "UPDATE tasks SET status='waiting_user',waiting_reason='question',waiting_question=$3,updated_at=now() WHERE id=$1 AND revision=$2 AND status='running' RETURNING id",
            [taskId, revision, question.slice(0, 3000)],
          );
          if (!changed.rowCount) throw taskStopped();
          await client.query(
            'INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,$2,$3,$4,$5)',
            [randomUUID(), ownerId, 'assistant', question.slice(0, 3000), taskId],
          );
        });
        refresh();
      },
      delta: (text, streamId, done) => {
        if (!controller.signal.aborted && task.source === 'user')
          delta(taskId, text, streamId, done);
      },
      remember: async (text) => {
        if (task.source !== 'user')
          throw new Error('Only a direct user conversation can create a memory.');
        await current((client) =>
          client.query(
            'INSERT INTO memory_facts(id,owner_id,text,source_message_id) VALUES($1,$2,$3,(SELECT id FROM messages WHERE task_id=$4 AND role=$5 ORDER BY created_at DESC LIMIT 1)) ON CONFLICT(owner_id,text) DO NOTHING',
            [randomUUID(), ownerId, text.slice(0, 2000), taskId, 'user'],
          ),
        );
      },
      publish: async (path, name) => {
        const artifact = await current(async () => publishArtifact(taskId, path, name));
        await reply(taskId, `Created ${artifact.name}.`, [artifact], revision);
        return artifact;
      },
      createAudio: async (text) => {
        await ensureCurrent();
        const audio = await dependencies.speech.synthesize(text, controller.signal);
        const artifact = await current(async () =>
          storeArtifact(audio.bytes, audio.fileName, audio.mimeType, taskId),
        );
        await reply(taskId, 'Audio generated by AI.', [artifact], revision);
        return artifact;
      },
      requestCredential: async (input) => {
        await ensureCurrent();
        const request = await dependencies.requestCredential(taskId, input);
        await ensureCurrent();
        if (request.filled) return request;
        await current((client) =>
          client.query(
            "UPDATE tasks SET status='waiting_credentials',waiting_reason='credentials',waiting_question=NULL,updated_at=now() WHERE id=$1 AND revision=$2 AND status='running'",
            [taskId, revision],
          ),
        );
        return request;
      },
      integration: async (action, args) => {
        await ensureCurrent();
        return dependencies.integration(taskId, action, args);
      },
      manage: async (action, args) => {
        const sourceMessageId = await current(async (client) => {
          if (task.source !== 'user') return null;
          const source = await client.query(
            "SELECT id FROM messages WHERE task_id=$1 AND owner_id=$2 AND role='user' ORDER BY created_at DESC,id DESC LIMIT 1",
            [taskId, ownerId],
          );
          return source.rows[0]?.id ?? null;
        });
        return dependencies.manage(taskId, action, args, { taskId, sourceMessageId });
      },
    });
    if (!['succeeded', 'waiting_credentials', 'waiting_user'].includes(result.status))
      throw new Error('Invalid task result.');
    await current(async (client) => {
      const updated = await client.query(
        "UPDATE tasks SET status=$3,waiting_reason=$4,waiting_question=$5,updated_at=now() WHERE id=$1 AND revision=$2 AND (status='running' OR status=$3) RETURNING id",
        [
          taskId,
          revision,
          result.status,
          result.waitingFor ?? null,
          result.question?.slice(0, 3000) ?? null,
        ],
      );
      if (updated.rowCount)
        await client.query('INSERT INTO task_events(id,task_id,type,summary) VALUES($1,$2,$3,$4)', [
          randomUUID(),
          taskId,
          result.status,
          result.status === 'succeeded' ? 'Task finished.' : 'Task is waiting for your input.',
        ]);
    });
  } catch (error) {
    const safeError = controller.signal.aborted
      ? 'The task stopped.'
      : 'I couldn’t finish this task. You can try again from the conversation.';
    await transaction(async (client) => {
      const updated = await client.query(
        "UPDATE tasks SET status='failed',error=$3,updated_at=now() WHERE id=$1 AND revision=$2 AND status='running' RETURNING id",
        [taskId, revision, safeError],
      );
      if (updated.rowCount)
        await client.query('INSERT INTO task_events(id,task_id,type,summary) VALUES($1,$2,$3,$4)', [
          randomUUID(),
          taskId,
          'failed',
          safeError,
        ]);
    });
  } finally {
    clearTimeout(timeout);
    if (running.get(taskId) === controller) running.delete(taskId);
    refresh();
  }
}
export async function stopTasks() {
  for (const control of running.values()) control.abort();
  await boss.stop({ graceful: true, timeout: 5000 });
}
