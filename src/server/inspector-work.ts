import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { InspectorReviewStatus, InspectorWorkResponse } from '../shared/inspector-work.ts';
import { currentConversationSql } from './conversations.ts';
import { createInspectorRedactor } from './inspector-redaction.ts';

export function createInspectorWork(
  pool: Pick<Pool, 'query'>,
  options: {
    ownerId: string;
    enabled(): boolean;
    reviewStatus(): Promise<InspectorReviewStatus>;
    secrets?: string[];
  },
) {
  const redact = createInspectorRedactor(options.secrets);
  function text(value: unknown, fallback: string) {
    const safe = redact(typeof value === 'string' ? value : fallback);
    return (typeof safe === 'string' ? safe : JSON.stringify(safe))
      .replace(/\s+/g, ' ')
      .slice(0, 220);
  }
  async function read(): Promise<InspectorWorkResponse> {
    const [active, upcoming, decisions, review] = await Promise.all([
      pool.query(
        `WITH base AS (
          SELECT t.id AS "taskId",COALESCE(o.id,t.id) AS group_id,t.status,
            left(COALESCE(o.title,s.title,CASE WHEN n.kind='review' THEN 'Review goals and recent updates'
              WHEN n.kind='external' THEN 'App update' WHEN t.source='event' THEN 'Background follow-up' ELSE t.title END),500) AS title,
            CASE WHEN s.task_id IS NOT NULL THEN 'schedule' WHEN n.kind='review' THEN 'review'
              WHEN t.source='event' THEN 'event' ELSE 'conversation' END AS source,
            t.waiting_reason AS "waitingReason",t.updated_at AS "updatedAt",
            CASE t.status WHEN 'running' THEN 0 WHEN 'waiting_user' THEN 1 WHEN 'waiting_credentials' THEN 1 ELSE 2 END AS priority,
            (SELECT count(*)::int FROM pending_task_inputs p JOIN messages m ON m.id=p.message_id AND m.owner_id=p.owner_id
             WHERE p.owner_id=$1 AND p.task_id=t.id AND p.state='pending') AS pending
          FROM tasks t
          LEFT JOIN outcomes o ON o.id=t.outcome_id AND o.owner_id=t.owner_id AND o.channel=t.channel
            AND o.conversation_revision=t.conversation_revision
          LEFT JOIN LATERAL (SELECT title,task_id FROM schedule_runs WHERE task_id=t.id AND owner_id=$1 ORDER BY created_at DESC LIMIT 1) s ON true
          LEFT JOIN LATERAL (SELECT COALESCE(to_jsonb(n)->>'kind','external') AS kind FROM notifications n
            WHERE n.task_id=t.id AND n.owner_id=$1 ORDER BY n.created_at DESC LIMIT 1) n ON true
          WHERE t.owner_id=$1 AND ${currentConversationSql()} AND t.status IN ('running','queued','waiting_user','waiting_credentials')
        ), grouped AS (
          SELECT *,row_number() OVER(PARTITION BY group_id ORDER BY priority,"updatedAt" DESC,"taskId") AS rank,
            count(*) OVER(PARTITION BY group_id)::int AS executions,
            sum(pending) OVER(PARTITION BY group_id)::int AS "queuedInputs" FROM base
        ) SELECT "taskId",title,status,source,"waitingReason","updatedAt",executions,"queuedInputs",count(*) OVER()::int AS total
          FROM grouped WHERE rank=1 ORDER BY priority,"updatedAt" DESC,"taskId" LIMIT 12`,
        [options.ownerId],
      ),
      pool.query(
        `SELECT id,left(title,500) AS title,next_run_at AS "runAt",time_zone AS "timeZone",job_id IS NOT NULL AS queued,
          count(*) OVER()::int AS total FROM schedules WHERE owner_id=$1 AND enabled
          ORDER BY next_run_at ASC NULLS LAST,id LIMIT 8`,
        [options.ownerId],
      ),
      pool.query(
        `SELECT n.id,COALESCE(to_jsonb(n)->>'kind','external') AS kind,n.decision,left(n.reason,500) AS reason,
          n.created_at AS "createdAt",t.id AS "taskId",count(*) OVER()::int AS total
          FROM notifications n LEFT JOIN tasks t ON t.id=n.task_id AND t.owner_id=n.owner_id
          WHERE n.owner_id=$1 AND n.created_at>now()-interval '24 hours'
          ORDER BY n.created_at DESC,n.id DESC LIMIT 8`,
        [options.ownerId],
      ),
      options.reviewStatus().catch(() => null),
    ]);
    return {
      scope: 'owner',
      active: active.rows.map(({ total: _total, ...row }) => ({
        ...row,
        title: text(row.title, 'Current work'),
        updatedAt: row.updatedAt.toISOString(),
      })),
      activeTotal: active.rows[0]?.total ?? 0,
      upcoming: upcoming.rows.map(({ total: _total, ...row }) => ({
        ...row,
        title: text(row.title, 'Scheduled work'),
        runAt: row.runAt?.toISOString() ?? null,
      })),
      upcomingTotal: upcoming.rows[0]?.total ?? 0,
      review,
      decisions: decisions.rows.map(({ total: _total, ...row }) => ({
        ...row,
        reason: text(row.reason, 'Reviewed'),
        createdAt: row.createdAt.toISOString(),
      })),
      decisionsTotal: decisions.rows[0]?.total ?? 0,
      decisionWindowHours: 24,
    };
  }
  function registerRoutes(app: FastifyInstance) {
    app.get('/api/inspector/work', async (request, reply) => {
      if (!options.enabled()) return reply.code(404).send({ error: 'Inspector is disabled.' });
      z.object({}).strict().parse(request.query);
      reply.header('Cache-Control', 'no-store');
      return read();
    });
  }
  return { read, registerRoutes };
}
