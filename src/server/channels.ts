import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { InboundMessage, MessagingTransport } from '../ports/messaging.ts';

interface ChannelOptions {
  ownerId: string;
  transport: MessagingTransport;
  submit: (text: string, sourceId: string, client: PoolClient) => Promise<string>;
  subscribe: (listener: () => void) => () => void;
  intervalMs?: number;
}
interface ChannelIdentity {
  provider: string;
  account_id: string;
  sender_id: string;
}
interface InboxRow extends ChannelIdentity {
  source_id: string;
  text: string;
}
interface OutboxRow extends ChannelIdentity {
  message_id: string;
  thread_id: string;
  text: string;
  attachments: unknown[];
}
const messageSchema = z.object({
  channelId: z.string().regex(/^[a-z][a-z0-9_-]{0,50}$/),
  accountId: z.string().min(1).max(256),
  senderId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(1024),
  text: z.string().trim().min(1).max(24000),
  sentAt: z.date(),
});

export function channelReply(text: string, hasAttachments = false) {
  const securePath = '(?:https?:\\/\\/[^\\s)]+)?\\/(?:credentials|approvals)\\/[^\\s)]+';
  const safe = text.replace(
    new RegExp(`\\[[^\\]]*\\]\\(${securePath}\\)|${securePath}`, 'g'),
    'Open Sidekick on your Mac to continue securely.',
  );
  return (
    `${safe}${hasAttachments ? '\n\nAttachments are available in Sidekick on your Mac.' : ''}`.trim() ||
    'A reply is available in Sidekick on your Mac.'
  );
}

export async function createChannels(pool: Pool, options: ChannelOptions) {
  const { ownerId, transport } = options;
  const channels = transport.channels.map((channel) => ({
    ...channel,
    allowedSenderIds: [...channel.allowedSenderIds],
  }));
  const configuration = channels.map((channel) => ({
    provider: channel.id,
    status: channel.status,
    missing: channel.missing,
  }));
  await pool.query(`CREATE TABLE IF NOT EXISTS channel_inbox (
    source_id text PRIMARY KEY, provider text NOT NULL, account_id text NOT NULL, sender_id text NOT NULL,
    thread_id text NOT NULL, text text NOT NULL, received_at timestamptz NOT NULL,
    task_id uuid, state text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS channel_outbox (
    message_id uuid PRIMARY KEY, source_id text NOT NULL REFERENCES channel_inbox(source_id),
    state text NOT NULL DEFAULT 'pending', provider_message_id text, reason text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS channel_inbox_pending ON channel_inbox(state,created_at);
  CREATE INDEX IF NOT EXISTS channel_inbox_task ON channel_inbox(task_id);
  CREATE INDEX IF NOT EXISTS channel_outbox_pending ON channel_outbox(state,created_at)`);
  await pool.query(
    "UPDATE channel_outbox SET state='uncertain',reason='interrupted_send',updated_at=now() WHERE state='sending'",
  );
  let closed = false;
  let running: Promise<void> | undefined;
  let drainRequested = false;
  let lastError: string | null = null;

  function permitted(row: ChannelIdentity) {
    return channels.some(
      (channel) =>
        channel.id === row.provider &&
        channel.status === 'configured' &&
        channel.accountId === row.account_id &&
        channel.allowedSenderIds.includes(row.sender_id),
    );
  }

  async function accept(message: InboundMessage, channelId: string) {
    const parsed = messageSchema.safeParse(message);
    if (!parsed.success || parsed.data.channelId !== channelId) return;
    const { accountId, senderId, messageId, threadId, text, sentAt } = parsed.data;
    if (
      !permitted({ provider: channelId, account_id: accountId, sender_id: senderId }) ||
      sentAt.getTime() > Date.now() + 300000
    )
      return;
    await pool.query(
      `INSERT INTO channel_inbox(source_id,provider,account_id,sender_id,thread_id,text,received_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_id) DO NOTHING`,
      [
        `channel:${channelId}:${accountId}:${messageId}`,
        channelId,
        accountId,
        senderId,
        threadId,
        text,
        sentAt,
      ],
    );
  }

  async function drainInbox() {
    for (let index = 0; index < 25 && !closed; index++) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<InboxRow>(
          "SELECT * FROM channel_inbox WHERE state='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
        );
        const row = result.rows[0];
        if (!row) {
          await client.query('COMMIT');
          break;
        }
        if (!permitted(row)) {
          await client.query("UPDATE channel_inbox SET state='discarded' WHERE source_id=$1", [
            row.source_id,
          ]);
        } else {
          const taskId = await options.submit(row.text, row.source_id, client);
          await client.query(
            "UPDATE channel_inbox SET state='submitted',task_id=$2 WHERE source_id=$1",
            [row.source_id, taskId],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async function drainOutbox() {
    await pool.query(
      `INSERT INTO channel_outbox(message_id,source_id)
      SELECT m.id,i.source_id FROM messages m JOIN channel_inbox i ON i.task_id=m.task_id
      WHERE m.role='assistant' AND m.owner_id=$1 AND i.state='submitted'
      ON CONFLICT(message_id) DO NOTHING`,
      [ownerId],
    );
    for (let index = 0; index < 25 && !closed; index++) {
      const result = await pool.query<OutboxRow>(`WITH claimed AS (
        UPDATE channel_outbox SET state='sending',updated_at=now() WHERE message_id=(
          SELECT message_id FROM channel_outbox WHERE state='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
        ) RETURNING message_id,source_id
      ) SELECT c.message_id,i.provider,i.account_id,i.sender_id,i.thread_id,m.text,m.attachments
        FROM claimed c JOIN channel_inbox i ON i.source_id=c.source_id JOIN messages m ON m.id=c.message_id`);
      const row = result.rows[0];
      if (!row) break;
      let reason: string | null = permitted(row) ? null : 'channel_access_changed';
      const replyWindowMs = channels.find((channel) => channel.id === row.provider)?.replyWindowMs;
      if (!reason && replyWindowMs !== undefined) {
        const latest = await pool.query(
          `SELECT max(received_at) AS at FROM channel_inbox
          WHERE provider=$1 AND account_id=$2 AND sender_id=$3`,
          [row.provider, row.account_id, row.sender_id],
        );
        if (
          !latest.rows[0]?.at ||
          Date.now() - new Date(latest.rows[0].at).getTime() >= replyWindowMs
        )
          reason = 'reply_window_closed';
      }
      if (reason) {
        await pool.query(
          "UPDATE channel_outbox SET state='blocked',reason=$2,updated_at=now() WHERE message_id=$1",
          [row.message_id, reason],
        );
        continue;
      }
      try {
        const sent = await transport.post({
          channelId: row.provider,
          accountId: row.account_id,
          threadId: row.thread_id,
          text: channelReply(row.text, Boolean(row.attachments?.length)),
        });
        await pool.query(
          "UPDATE channel_outbox SET state='sent',provider_message_id=$2,updated_at=now() WHERE message_id=$1",
          [row.message_id, sent.id],
        );
      } catch {
        await pool.query(
          "UPDATE channel_outbox SET state='uncertain',reason='send_not_confirmed',updated_at=now() WHERE message_id=$1",
          [row.message_id],
        );
      }
    }
  }

  function drain() {
    if (closed) return Promise.resolve();
    drainRequested = true;
    if (running) return running;
    running = (async () => {
      try {
        while (drainRequested && !closed) {
          drainRequested = false;
          await drainInbox();
          await drainOutbox();
        }
        lastError = null;
      } catch {
        lastError =
          'Channel processing needs attention. Check the local database and task service.';
      } finally {
        running = undefined;
      }
    })();
    return running;
  }
  const unsubscribe = options.subscribe(() => {
    void drain();
  });
  const timer = setInterval(() => {
    void drain();
  }, options.intervalMs ?? 2000);
  timer.unref();

  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    unsubscribe();
    await running;
    await transport.close();
  }

  function registerRoutes(app: FastifyInstance) {
    app.addHook('onClose', close);
    app.get('/api/channels', async () => ({
      channels: configuration,
      error: lastError,
      inbox: (
        await pool.query('SELECT state,count(*)::int AS count FROM channel_inbox GROUP BY state')
      ).rows,
      deliveries: (
        await pool.query('SELECT state,count(*)::int AS count FROM channel_outbox GROUP BY state')
      ).rows,
    }));
    app.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser(
        '*',
        { parseAs: 'buffer', bodyLimit: 256 * 1024 },
        (_request, body, done) => done(null, body),
      );
      scope.route<{ Params: { provider: string } }>({
        method: ['GET', 'POST'],
        url: '/api/webhooks/:provider',
        async handler(request, reply) {
          const channelId = request.params.provider;
          if (
            !channels.some((channel) => channel.id === channelId && channel.status === 'configured')
          )
            return reply.code(404).send({ error: 'Channel is not configured.' });
          const result = await transport.receive({
            channelId,
            method: request.method,
            headers: request.headers,
            query: request.query,
            body: Buffer.isBuffer(request.body) ? request.body : new Uint8Array(),
          });
          if (result.status >= 200 && result.status < 300) {
            for (const message of result.messages ?? []) await accept(message, channelId);
            if (result.messages?.length) void drain();
          }
          if (result.contentType) reply.type(result.contentType);
          return reply.code(result.status).send(result.body);
        },
      });
    });
  }

  return { registerRoutes, drain, close };
}
