import type { Pool } from 'pg';
import { isMessageReaction, reactionEmoji } from '../shared/emoji.ts';
import type { AgentReactionResult, MessageReaction } from '../shared/contracts.ts';
import { currentConversationSql, lockConversation } from './conversations.ts';

export interface AgentReactionInput {
  taskId: string;
  revision: number;
  messageId: string;
  reaction: MessageReaction | null;
  visibleMessageIds: readonly string[];
  signal?: AbortSignal;
}

export function createAgentReactionService(dependencies: {
  pool: Pool;
  ownerId: string;
  refresh(): void;
}) {
  async function react(input: AgentReactionInput): Promise<AgentReactionResult> {
    input.signal?.throwIfAborted();
    if (input.reaction !== null && !isMessageReaction(input.reaction))
      throw new Error('Choose one emoji reaction.');
    if (!input.visibleMessageIds.includes(input.messageId))
      throw new Error('The message is not in this conversation context.');
    const client = await dependencies.pool.connect();
    let result: AgentReactionResult;
    try {
      await client.query('BEGIN');
      await lockConversation(client, dependencies.ownerId);
      input.signal?.throwIfAborted();
      const current = await client.query(
        `SELECT t.channel,t.source,t.conversation_revision FROM tasks t
         WHERE t.id=$1 AND t.owner_id=$2 AND t.revision=$3 AND t.status='running'
           AND ${currentConversationSql()} FOR NO KEY UPDATE`,
        [input.taskId, dependencies.ownerId, input.revision],
      );
      if (!current.rowCount) throw new Error('This task segment is no longer active.');
      input.signal?.throwIfAborted();
      const task = current.rows[0];
      if (task.channel !== 'web' || task.source !== 'user') {
        result = { status: 'skipped', reason: 'unavailable' };
      } else {
        const target = await client.query(
          `SELECT m.assistant_reaction,m.assistant_reacted_at FROM messages m
           JOIN tasks t ON t.id=m.task_id
           WHERE m.id=$1 AND m.owner_id=$2 AND m.role='user' AND t.owner_id=$2
             AND t.channel='web' AND t.conversation_revision=$3 AND ${currentConversationSql()}
           FOR UPDATE OF m`,
          [input.messageId, dependencies.ownerId, task.conversation_revision],
        );
        if (!target.rowCount) throw new Error('The message cannot receive this reaction.');
        const message = target.rows[0];
        const unchanged =
          input.reaction === null
            ? message.assistant_reaction === null
            : message.assistant_reaction !== null &&
              reactionEmoji(message.assistant_reaction) === reactionEmoji(input.reaction);
        if (unchanged) result = { status: 'unchanged' };
        else if (input.reaction === null) {
          await client.query('UPDATE messages SET assistant_reaction=NULL WHERE id=$1', [
            input.messageId,
          ]);
          result = { status: 'updated' };
        } else if (message.assistant_reacted_at || message.assistant_reaction) {
          result = { status: 'skipped', reason: 'already_reacted' };
        } else {
          const recent = await client.query(
            `SELECT m.id FROM messages m JOIN tasks t ON t.id=m.task_id
             WHERE m.owner_id=$1 AND t.owner_id=$1 AND t.channel='web'
               AND ${currentConversationSql()} AND m.assistant_reacted_at > clock_timestamp()-interval '5 minutes'
             LIMIT 1`,
            [dependencies.ownerId],
          );
          if (recent.rowCount) result = { status: 'skipped', reason: 'cooldown' };
          else {
            await client.query(
              'UPDATE messages SET assistant_reaction=$2,assistant_reacted_at=clock_timestamp() WHERE id=$1',
              [input.messageId, reactionEmoji(input.reaction)],
            );
            result = { status: 'updated' };
          }
        }
      }
      input.signal?.throwIfAborted();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (result.status === 'updated') dependencies.refresh();
    return result;
  }
  return { react };
}
