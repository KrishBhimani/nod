import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { activeThread } from './thread.ts';
import { createInspectorRedactor } from './inspector-redaction.ts';

export function registerBugReport(
  app: FastifyInstance,
  options: {
    pool: Pool;
    ownerId: string;
    captureEnabled(): boolean;
    secrets?: string[];
    provider?: string;
    model?: string;
  },
) {
  const redact = createInspectorRedactor(options.secrets, { string: 64_000, payload: 160_000 });
  app.get('/api/conversation/bug-report', async (_request, reply) => {
    const thread = await activeThread(options.pool, options.ownerId);
    const values = [options.ownerId, thread.id];
    const [
      messages,
      turns,
      events,
      records,
      prompts,
      approvals,
      notifications,
      profile,
      goals,
      schedules,
    ] = await Promise.all([
      options.pool.query(
        `SELECT id,role,text,turn_id,attachments,reaction,assistant_reaction,reply_to_message_id,created_at
           FROM messages WHERE owner_id=$1 AND thread_id=$2 ORDER BY created_at,id`,
        values,
      ),
      options.pool.query(
        `SELECT id,source,prompt,channel,status,waiting_reason,background,read_only,error,created_at,started_at,finished_at
           FROM turns WHERE owner_id=$1 AND thread_id=$2 ORDER BY created_at,id`,
        values,
      ),
      options.pool.query(
        `SELECT e.id,e.turn_id,e.type,e.summary,e.created_at FROM turn_events e
           JOIN turns t ON t.id=e.turn_id AND t.owner_id=$1 AND t.thread_id=$2
           ORDER BY e.created_at,e.id`,
        values,
      ),
      options.pool.query(
        `SELECT id,turn_id,kind,name,status,input,output,error,usage,duration_ms,started_at,finished_at
           FROM inspector_records WHERE owner_id=$1 AND thread_id=$2 AND recorded_at >= now()-interval '7 days'
           ORDER BY started_at,id`,
        values,
      ),
      options.pool.query(
        `SELECT id,turn_id,payload,provider,model,created_at FROM inspector_prompts
           WHERE owner_id=$1 AND thread_id=$2 AND created_at >= now()-interval '7 days'
           ORDER BY created_at,id`,
        values,
      ),
      options.pool.query(
        `SELECT id,turn_id,execution_turn_id,action,args,status,result,expires_at
           FROM approvals WHERE owner_id=$1 AND thread_id=$2 ORDER BY expires_at,id`,
        values,
      ),
      options.pool.query(
        `SELECT n.id,n.turn_id,n.summary,n.decision,n.reason,n.feedback,n.kind,n.created_at
           FROM notifications n JOIN turns t ON t.id=n.turn_id AND t.owner_id=$1 AND t.thread_id=$2
           WHERE n.owner_id=$1 ORDER BY n.created_at,n.id`,
        values,
      ),
      options.pool.query('SELECT data FROM profiles WHERE owner_id=$1', [options.ownerId]),
      options.pool.query(
        'SELECT id,title,description,progress,status,next_action,target_date,updated_at FROM goals WHERE owner_id=$1 ORDER BY updated_at,id',
        [options.ownerId],
      ),
      options.pool.query(
        'SELECT id,title,prompt,kind,enabled,time_zone,next_run_at FROM schedules WHERE owner_id=$1 ORDER BY id',
        [options.ownerId],
      ),
    ]);
    reply.header('Cache-Control', 'no-store');
    return {
      purpose: 'Explain an incorrect Otto answer using the saved conversation and trace.',
      generatedAt: new Date().toISOString(),
      threadId: thread.id,
      provider: options.provider,
      model: options.model,
      coverage: {
        toolAndPromptCaptureEnabled: options.captureEnabled(),
        traceRetentionDays: 7,
        note: 'Values are masked and may be shortened. Private Pi session contents, hidden model reasoning, attachment bytes, and expired traces are unavailable.',
      },
      messages: messages.rows.map(redact),
      turns: turns.rows.map(redact),
      events: events.rows.map(redact),
      trace: records.rows.map(redact),
      prompts: prompts.rows.map(redact),
      approvals: approvals.rows.map(redact),
      notificationDecisions: notifications.rows.map(redact),
      memory: {
        profile: redact(profile.rows[0]?.data ?? {}),
        goals: goals.rows.map(redact),
        schedules: schedules.rows.map(redact),
      },
    };
  });
}
