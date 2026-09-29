import type { Pool } from 'pg';
import type { Audit } from './e2e-fixtures.ts';

export function createChatEvidence(pool: Pool, audit: Audit) {
  const streams = new Set<string>();
  const states = new Map<string, string>();
  const eventIds = new Set<string>();
  const messageIds = new Set<string>();

  function accepted(requestId: string, payload: string) {
    try {
      const result = JSON.parse(payload);
      if (typeof result.threadId === 'string' && typeof result.turnId === 'string')
        audit('chat_request_accepted', {
          requestId,
          threadId: result.threadId,
          turnId: result.turnId,
        });
    } catch {}
  }

  function delta(event: {
    type?: string;
    threadId?: string;
    turnId?: string;
    streamId?: string;
    text?: string;
  }) {
    if (event.type !== 'delta' || !event.threadId || !event.turnId || !event.text) return;
    const key = `${event.threadId}:${event.turnId}:${event.streamId || 'default'}`;
    if (streams.has(key)) return;
    streams.add(key);
    audit('first_visible_delta', {
      threadId: event.threadId,
      turnId: event.turnId,
      streamId: event.streamId || '',
    });
  }

  async function sample() {
    const turns = await pool.query(
      'SELECT id,thread_id,status,source,created_at,started_at,finished_at FROM turns ORDER BY created_at,id',
    );
    for (const turn of turns.rows) {
      if (states.get(turn.id) === turn.status) continue;
      states.set(turn.id, turn.status);
      audit('turn_state', {
        threadId: turn.thread_id,
        turnId: turn.id,
        status: turn.status,
        source: turn.source,
        createdAt: turn.created_at.toISOString(),
        startedAt: turn.started_at?.toISOString() ?? null,
        finishedAt: turn.finished_at?.toISOString() ?? null,
      });
    }
    const events = await pool.query(
      'SELECT e.id,e.turn_id,u.thread_id,e.type,e.created_at FROM turn_events e JOIN turns u ON u.id=e.turn_id ORDER BY e.created_at,e.id',
    );
    for (const event of events.rows) {
      if (eventIds.has(event.id)) continue;
      eventIds.add(event.id);
      audit('turn_event', {
        threadId: event.thread_id,
        turnId: event.turn_id,
        eventId: event.id,
        type: event.type,
        createdAt: event.created_at.toISOString(),
      });
    }
    const messages = await pool.query(
      "SELECT id,thread_id,turn_id,created_at FROM messages WHERE role='assistant' ORDER BY created_at,id",
    );
    for (const message of messages.rows) {
      if (messageIds.has(message.id)) continue;
      messageIds.add(message.id);
      audit('assistant_message_saved', {
        threadId: message.thread_id,
        turnId: message.turn_id,
        messageId: message.id,
        createdAt: message.created_at.toISOString(),
      });
    }
  }

  return { accepted, delta, sample };
}
