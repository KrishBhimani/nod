import type { Pool } from 'pg';
import { z } from 'zod';
import type { RuntimeObservation } from '../ports/agent.ts';
import type { InspectorObservationsResponse, ModelUsage, ToolCall } from '../shared/inspector.ts';
import { createInspectorRedactor, inspectorPayloadLimit } from './inspector-redaction.ts';

export const inspectorRetentionDays = 7;
export { inspectorPayloadLimit };
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.object({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  totalTokens: count,
  costUsd: z.number().nonnegative().finite().nullable(),
  costSource: z.enum(['sdk_estimate', 'unavailable']),
});
const iso = (value: string | Date) => new Date(value).toISOString();
const time = z.iso.datetime({ offset: true });

export function createInspectorStore(
  pool: Pool,
  options: { ownerId: string; enabled(): boolean; secrets?: string[] },
) {
  const redact = createInspectorRedactor(options.secrets);
  let lastPruned = 0;
  let pruning: Promise<void> | undefined;
  async function prune() {
    if (pruning) return pruning;
    if (Date.now() - lastPruned < 60 * 60_000) return;
    pruning = pool
      .query(
        "DELETE FROM inspector_records WHERE owner_id=$1 AND recorded_at < now() - interval '7 days'",
        [options.ownerId],
      )
      .then(() => {
        lastPruned = Date.now();
      })
      .finally(() => {
        pruning = undefined;
      });
    return pruning;
  }
  async function record(taskId: string, revision: number, event: RuntimeObservation) {
    if (!options.enabled()) return;
    z.uuid().parse(taskId);
    z.uuid().parse(event.id);
    count.parse(revision);
    await prune();
    if (event.type === 'tool_start') {
      const name = z.string().min(1).max(100).parse(event.name);
      await pool.query(
        `INSERT INTO inspector_records(id,owner_id,task_id,revision,kind,name,status,input,started_at)
        SELECT $1,$2,id,$4,'tool',$5,'running',$6,$7 FROM tasks
        WHERE id=$3 AND owner_id=$2 AND revision=$4 AND status='running'
        ON CONFLICT(id) DO NOTHING`,
        [
          event.id,
          options.ownerId,
          taskId,
          revision,
          name,
          JSON.stringify(redact(event.input)),
          iso(time.parse(event.startedAt)),
        ],
      );
    } else if (event.type === 'tool_end') {
      const result = z.enum(['succeeded', 'failed', 'cancelled']).parse(event.status);
      const duration = z.number().nonnegative().finite().parse(event.durationMs);
      await pool.query(
        `UPDATE inspector_records r SET
          status=CASE WHEN t.revision=r.revision AND t.status NOT IN ('cancelled','failed') THEN $5 ELSE 'interrupted' END,
          output=CASE WHEN t.revision=r.revision AND t.status NOT IN ('cancelled','failed') THEN $6::jsonb ELSE NULL END,
          error=CASE WHEN t.revision=r.revision AND t.status NOT IN ('cancelled','failed') THEN $7 ELSE 'The task segment changed before its result was recorded.' END,
          duration_ms=$8,finished_at=$9
        FROM tasks t WHERE r.id=$1 AND r.owner_id=$2 AND r.task_id=$3 AND r.revision=$4
          AND r.kind='tool' AND r.status='running' AND t.id=r.task_id AND t.owner_id=$2`,
        [
          event.id,
          options.ownerId,
          taskId,
          revision,
          result,
          event.output === undefined ? null : JSON.stringify(redact(event.output)),
          event.error ? String(redact(event.error)).slice(0, 1000) : null,
          duration,
          iso(time.parse(event.finishedAt)),
        ],
      );
    } else {
      const usage = usageSchema.parse(event);
      if (usage.costSource === 'unavailable') usage.costUsd = null;
      if (usage.costUsd === null) usage.costSource = 'unavailable';
      usage.provider = String(redact(usage.provider));
      usage.model = String(redact(usage.model));
      await pool.query(
        `INSERT INTO inspector_records(id,owner_id,task_id,revision,kind,name,status,usage,started_at,finished_at)
        SELECT $1,$2,id,$4,'model','model_request','succeeded',$5,$6,$6 FROM tasks
        WHERE id=$3 AND owner_id=$2 AND revision >= $4 ON CONFLICT(id) DO NOTHING`,
        [
          event.id,
          options.ownerId,
          taskId,
          revision,
          JSON.stringify(usage),
          iso(time.parse(event.createdAt)),
        ],
      );
    }
  }
  async function recover() {
    await prune();
    await pool.query(
      `UPDATE inspector_records SET status='interrupted',finished_at=now(),
      error='The server stopped before this call completed.' WHERE owner_id=$1 AND kind='tool' AND status='running'`,
      [options.ownerId],
    );
  }
  async function finishSegment(taskId: string, revision: number) {
    if (!options.enabled()) return;
    await pool.query(
      `UPDATE inspector_records SET status='interrupted',finished_at=now(),
      error='The task segment ended without a recorded result.'
      WHERE owner_id=$1 AND task_id=$2 AND revision=$3 AND kind='tool' AND status='running'`,
      [options.ownerId, taskId, revision],
    );
  }
  async function read(
    taskId: string,
    cursor: { before?: string; beforeId?: string } = {},
  ): Promise<InspectorObservationsResponse | null> {
    z.uuid().parse(taskId);
    await prune();
    const owner = await pool.query('SELECT id FROM tasks WHERE id=$1 AND owner_id=$2', [
      taskId,
      options.ownerId,
    ]);
    if (!owner.rowCount) return null;
    const [records, totals] = await Promise.all([
      pool.query(
        `SELECT r.*,
          CASE WHEN r.status='running' AND (t.revision<>r.revision OR t.status IN ('failed','cancelled','succeeded')) THEN 'interrupted' ELSE r.status END AS current_status
        FROM inspector_records r JOIN tasks t ON t.id=r.task_id
        WHERE r.owner_id=$1 AND r.task_id=$2 AND r.recorded_at >= now() - interval '7 days'
          AND ($3::timestamptz IS NULL OR r.started_at < $3 OR (r.started_at=$3 AND r.id<$4::uuid))
        ORDER BY r.started_at DESC,r.id DESC LIMIT 101`,
        [options.ownerId, taskId, cursor.before ?? null, cursor.beforeId ?? null],
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE kind='tool')::int AS calls,
          count(*) FILTER (WHERE kind='model')::int AS "modelRequests",
          coalesce(sum((usage->>'inputTokens')::bigint),0)::float8 AS "inputTokens",
          coalesce(sum((usage->>'outputTokens')::bigint),0)::float8 AS "outputTokens",
          coalesce(sum((usage->>'cacheReadTokens')::bigint),0)::float8 AS "cacheReadTokens",
          coalesce(sum((usage->>'cacheWriteTokens')::bigint),0)::float8 AS "cacheWriteTokens",
          coalesce(sum((usage->>'totalTokens')::bigint),0)::float8 AS "totalTokens",
          sum((usage->>'costUsd')::numeric)::float8 AS "knownCostUsd",
          count(*) FILTER (WHERE kind='model' AND (usage->>'costUsd') IS NULL)::int AS "unpricedRequests"
        FROM inspector_records WHERE owner_id=$1 AND task_id=$2 AND recorded_at >= now() - interval '7 days'`,
        [options.ownerId, taskId],
      ),
    ]);
    const page = records.rows.slice(0, 100);
    const calls: ToolCall[] = page
      .filter((row) => row.kind === 'tool')
      .map((row) => ({
        id: row.id,
        taskId: row.task_id,
        revision: row.revision,
        name: row.name,
        input: redact(row.input),
        output: row.output === null ? null : redact(row.output),
        status: row.current_status,
        startedAt: iso(row.started_at),
        finishedAt: row.finished_at ? iso(row.finished_at) : null,
        durationMs: row.duration_ms,
        error: row.error ? String(redact(row.error)) : null,
      }));
    const usage: ModelUsage[] = page
      .filter((row) => row.kind === 'model')
      .map((row) => ({
        ...row.usage,
        id: row.id,
        taskId: row.task_id,
        revision: row.revision,
        createdAt: iso(row.started_at),
      }));
    const hasOlder = records.rows.length > 100;
    const last = page.at(-1);
    return {
      calls,
      usage,
      summary: totals.rows[0],
      hasOlder,
      ...(hasOlder && last ? { nextBefore: iso(last.started_at), nextBeforeId: last.id } : {}),
    };
  }
  return { record, read, recover, finishSegment };
}

export type InspectorStore = ReturnType<typeof createInspectorStore>;
