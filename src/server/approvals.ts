import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { pool, transaction } from './db.ts';
import { ownerId } from './config.ts';
import { refresh } from './events.ts';
import { reply, submitTask } from './tasks.ts';

export interface ApprovalExecutionContext {
  taskId: string;
  sourceMessageId: string | null;
}

export async function createApprovals(
  execute: (
    action: string,
    args: Record<string, unknown>,
    context: ApprovalExecutionContext,
  ) => Promise<unknown>,
  preflight?: (action: string, args: Record<string, unknown>) => Promise<void>,
) {
  await pool.query(`CREATE TABLE IF NOT EXISTS approvals (
    id uuid PRIMARY KEY, owner_id text NOT NULL, task_id uuid NOT NULL REFERENCES tasks(id),
    action text NOT NULL, args jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
    expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes'
  )`);
  await pool.query(
    'ALTER TABLE approvals ADD COLUMN IF NOT EXISTS task_revision integer NOT NULL DEFAULT 0',
  );
  await pool.query(
    'ALTER TABLE approvals ADD COLUMN IF NOT EXISTS source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL',
  );
  await pool.query("UPDATE approvals SET status='uncertain' WHERE status='executing'");
  async function request(taskId: string, action: string, args: Record<string, unknown>) {
    const id = randomUUID();
    await transaction(async (client) => {
      const task = await client.query(
        "SELECT revision FROM tasks WHERE id=$1 AND owner_id=$2 AND status='running' FOR UPDATE",
        [taskId, ownerId],
      );
      if (!task.rowCount)
        throw Object.assign(new Error('This task is no longer running.'), { statusCode: 409 });
      await client.query(
        `INSERT INTO approvals(id,owner_id,task_id,action,args,task_revision,source_message_id)
         VALUES($1,$2,$3,$4,$5,$6,(SELECT id FROM messages WHERE task_id=$3 AND owner_id=$2 AND role='user' ORDER BY created_at DESC,id DESC LIMIT 1))`,
        [id, ownerId, taskId, action, args, task.rows[0].revision],
      );
      await client.query(
        "UPDATE tasks SET status='waiting_user',waiting_reason='approval',waiting_question=NULL,updated_at=now() WHERE id=$1",
        [taskId],
      );
    });
    refresh();
    return { requiresApproval: true, url: `/approvals/${id}` };
  }
  function registerRoutes(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>('/api/approvals/:id', async (request) => {
      const result = await pool.query(
        "SELECT id,action,args,CASE WHEN expires_at<now() AND status='pending' THEN 'expired' ELSE status END AS status FROM approvals WHERE id=$1 AND owner_id=$2",
        [z.uuid().parse(request.params.id), ownerId],
      );
      if (!result.rowCount)
        throw Object.assign(new Error('Action not found.'), { statusCode: 404 });
      return result.rows[0];
    });
    app.post<{ Params: { id: string } }>('/api/approvals/:id', async (request) => {
      const input = z.object({ approved: z.boolean() }).strict().parse(request.body);
      const approval = await transaction(async (client) => {
        if (input.approved && preflight) {
          const pending = await client.query(
            "SELECT action,args FROM approvals WHERE id=$1 AND owner_id=$2 AND status='pending' AND expires_at>now() AND EXISTS(SELECT 1 FROM tasks WHERE tasks.id=approvals.task_id AND tasks.status='waiting_user' AND tasks.revision=approvals.task_revision) FOR UPDATE",
            [z.uuid().parse(request.params.id), ownerId],
          );
          if (pending.rows[0]) await preflight(pending.rows[0].action, pending.rows[0].args);
        }
        const result = await client.query(
          "UPDATE approvals SET status=$3 WHERE id=$1 AND owner_id=$2 AND status='pending' AND expires_at>now() AND EXISTS(SELECT 1 FROM tasks WHERE tasks.id=approvals.task_id AND tasks.status='waiting_user' AND tasks.revision=approvals.task_revision) RETURNING *",
          [z.uuid().parse(request.params.id), ownerId, input.approved ? 'executing' : 'declined'],
        );
        if (!result.rowCount)
          throw Object.assign(
            new Error('This action is expired, already handled, or its task was cancelled.'),
            { statusCode: 409 },
          );
        const approval = result.rows[0];
        if (!input.approved) {
          await client.query(
            'INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,$2,$3,$4,$5)',
            [randomUUID(), ownerId, 'assistant', 'I left that action unchanged.', approval.task_id],
          );
          await submitTask(
            `The user declined ${approval.action}. Do not execute it or ask for it again. Continue only with other already authorized parts of the task, or finish quietly.`,
            [],
            approval.task_id,
            true,
            { sourceId: `approval:${approval.id}:declined`, client },
          );
        }
        return approval;
      });
      if (!input.approved) {
        refresh();
        return { ok: true };
      }
      try {
        const result = await execute(approval.action, approval.args, {
          taskId: approval.task_id,
          sourceMessageId: approval.source_message_id,
        });
        await transaction(async (client) => {
          const task = await client.query(
            'SELECT status,revision FROM tasks WHERE id=$1 FOR UPDATE',
            [approval.task_id],
          );
          await client.query("UPDATE approvals SET status='completed' WHERE id=$1", [approval.id]);
          if (
            !task.rowCount ||
            task.rows[0].revision !== approval.task_revision ||
            task.rows[0].status !== 'waiting_user'
          )
            return;
          await submitTask(
            `The user approved ${approval.action}, and the trusted connector executed it once. Do not repeat it. Continue from this result: ${JSON.stringify(result).slice(0, 18000)}`,
            [],
            approval.task_id,
            true,
            { sourceId: `approval:${approval.id}:completed`, client },
          );
        });
      } catch {
        await pool.query(
          "UPDATE approvals SET status='uncertain' WHERE id=$1 AND status='executing'",
          [approval.id],
        );
        throw Object.assign(
          new Error(
            'The action outcome needs review. Check the connected service before retrying.',
          ),
          { statusCode: 502 },
        );
      }
      refresh();
      return { ok: true };
    });
  }
  return { request, registerRoutes };
}
