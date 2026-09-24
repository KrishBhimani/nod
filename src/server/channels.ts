import { createHmac, timingSafeEqual } from 'node:crypto';
import { Chat, ConsoleLogger } from 'chat';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { createWhatsAppAdapter } from '@chat-adapter/whatsapp';
import { createPostgresState } from '@chat-adapter/state-pg';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { ownerId } from './config.ts';
import { events } from './events.ts';

type Provider = 'telegram' | 'whatsapp';
type Environment = Record<string, string | undefined>;
interface ChannelOptions {
  submit: (text: string, sourceId: string, client: PoolClient) => Promise<string>;
  env?: Environment;
  intervalMs?: number;
}
interface ChannelIdentity { provider: Provider; account_id: string; sender_id: string; }
interface InboxRow extends ChannelIdentity { source_id: string; text: string; }
interface OutboxRow extends ChannelIdentity { message_id: string; thread_id: string; text: string; attachments: unknown[]; }

const logger = new ConsoleLogger('silent');
const telegramMessage = z.object({
  message_id: z.number().int().nonnegative(), date: z.number().int().positive(), text: z.string().trim().min(1).max(24000),
  from: z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), is_bot: z.literal(false), first_name: z.string().max(256) }),
  chat: z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), type: z.literal('private') }),
});
const whatsappMessage = z.object({
  id: z.string().min(1).max(256), from: z.string().regex(/^\d{7,15}$/), timestamp: z.string().regex(/^\d{1,12}$/),
  type: z.literal('text'), text: z.object({ body: z.string().trim().min(1).max(24000) }),
});
const whatsappEnvelope = z.object({
  object: z.literal('whatsapp_business_account'), entry: z.array(z.object({
    changes: z.array(z.object({ field: z.string(), value: z.object({
      metadata: z.object({ phone_number_id: z.string() }).optional(), messages: z.array(z.unknown()).max(100).optional(),
    }) })).max(100),
  })).max(100),
});

function sameSecret(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function channelConfiguration(env: Environment = process.env) {
  const telegramMissing = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET_TOKEN', 'TELEGRAM_ALLOWED_USER_ID'].filter(key => !env[key]);
  if (env.TELEGRAM_ALLOWED_USER_ID && !/^\d{1,16}$/.test(env.TELEGRAM_ALLOWED_USER_ID)) telegramMissing.push('TELEGRAM_ALLOWED_USER_ID');
  if (env.TELEGRAM_WEBHOOK_SECRET_TOKEN && !/^[A-Za-z0-9_-]{16,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET_TOKEN)) telegramMissing.push('TELEGRAM_WEBHOOK_SECRET_TOKEN');
  if (env.TELEGRAM_BOT_TOKEN && !/^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN)) telegramMissing.push('TELEGRAM_BOT_TOKEN');
  const whatsappMissing = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_ALLOWED_NUMBER'].filter(key => !env[key]);
  if (env.WHATSAPP_ALLOWED_NUMBER && !/^\d{7,15}$/.test(env.WHATSAPP_ALLOWED_NUMBER)) whatsappMissing.push('WHATSAPP_ALLOWED_NUMBER');
  if (env.WHATSAPP_PHONE_NUMBER_ID && !/^\d+$/.test(env.WHATSAPP_PHONE_NUMBER_ID)) whatsappMissing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (env.WHATSAPP_POLICY_CONFIRMED !== 'true') whatsappMissing.push('WHATSAPP_POLICY_CONFIRMED');
  return (['telegram', 'whatsapp'] as const).map(provider => {
    const enabled = env[`${provider.toUpperCase()}_ENABLED`] === 'true';
    const missing = provider === 'telegram' ? telegramMissing : whatsappMissing;
    return { provider, status: !enabled ? 'disabled' : missing.length ? 'setup_required' : 'configured', missing: enabled ? missing : [] };
  });
}

export function channelReply(text: string, hasAttachments = false) {
  const securePath = '(?:https?:\\/\\/[^\\s)]+)?\\/(?:credentials|approvals)\\/[^\\s)]+';
  const safe = text.replace(new RegExp(`\\[[^\\]]*\\]\\(${securePath}\\)|${securePath}`, 'g'), 'Open Sidekick on your Mac to continue securely.');
  return `${safe}${hasAttachments ? '\n\nAttachments are available in Sidekick on your Mac.' : ''}`.trim() || 'A reply is available in Sidekick on your Mac.';
}

export async function createChannels(pool: Pool, options: ChannelOptions) {
  const env = { ...(options.env ?? process.env) };
  const configuration = channelConfiguration(env);
  const configured = (provider: Provider) => configuration.some(channel => channel.provider === provider && channel.status === 'configured');
  const telegram = configured('telegram') ? createTelegramAdapter({
    botToken: env.TELEGRAM_BOT_TOKEN!, secretToken: env.TELEGRAM_WEBHOOK_SECRET_TOKEN!, allowedUserIds: [env.TELEGRAM_ALLOWED_USER_ID!],
    mode: 'webhook', allowUnverifiedWebhooks: false, apiUrl: 'https://api.telegram.org', logger,
  }) : undefined;
  const whatsapp = configured('whatsapp') ? createWhatsAppAdapter({
    accessToken: env.WHATSAPP_ACCESS_TOKEN!, appSecret: env.WHATSAPP_APP_SECRET!, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN!, apiUrl: 'https://graph.facebook.com', logger,
  }) : undefined;
  const state = createPostgresState({ client: pool, keyPrefix: 'sidekick-channels', logger });
  const bot = new Chat({ userName: 'Sidekick', adapters: { ...(telegram ? { telegram } : {}), ...(whatsapp ? { whatsapp } : {}) }, state, logger });
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
  await pool.query("UPDATE channel_outbox SET state='uncertain',reason='interrupted_send',updated_at=now() WHERE state='sending'");
  let closed = false;
  let running: Promise<void> | undefined;
  let drainRequested = false;
  let lastError: string | null = null;

  function permitted(row: ChannelIdentity) {
    return row.provider === 'telegram'
      ? Boolean(telegram && row.account_id === env.TELEGRAM_BOT_TOKEN!.split(':')[0] && row.sender_id === env.TELEGRAM_ALLOWED_USER_ID)
      : Boolean(whatsapp && row.account_id === env.WHATSAPP_PHONE_NUMBER_ID && row.sender_id === env.WHATSAPP_ALLOWED_NUMBER);
  }

  async function accept(provider: Provider, account: string, sender: string, id: string, threadId: string, text: string, sentAt: Date) {
    if (!Number.isFinite(sentAt.getTime()) || sentAt.getTime() > Date.now() + 300000) return;
    await pool.query(`INSERT INTO channel_inbox(source_id,provider,account_id,sender_id,thread_id,text,received_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_id) DO NOTHING`,
    [`channel:${provider}:${account}:${id}`, provider, account, sender, threadId, text, sentAt]);
  }

  async function drainInbox() {
    for (let index = 0; index < 25 && !closed; index++) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<InboxRow>("SELECT * FROM channel_inbox WHERE state='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1");
        const row = result.rows[0];
        if (!row) { await client.query('COMMIT'); break; }
        if (!permitted(row)) {
          await client.query("UPDATE channel_inbox SET state='discarded' WHERE source_id=$1", [row.source_id]);
        } else {
          const taskId = await options.submit(row.text, row.source_id, client);
          await client.query("UPDATE channel_inbox SET state='submitted',task_id=$2 WHERE source_id=$1", [row.source_id, taskId]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    }
  }

  async function drainOutbox() {
    await pool.query(`INSERT INTO channel_outbox(message_id,source_id)
      SELECT m.id,i.source_id FROM messages m JOIN channel_inbox i ON i.task_id=m.task_id
      WHERE m.role='assistant' AND m.owner_id=$1 AND i.state='submitted'
      ON CONFLICT(message_id) DO NOTHING`, [ownerId]);
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
      if (!reason && row.provider === 'whatsapp') {
        const latest = await pool.query(`SELECT max(received_at) AS at FROM channel_inbox
          WHERE provider='whatsapp' AND account_id=$1 AND sender_id=$2`, [row.account_id, row.sender_id]);
        if (!latest.rows[0]?.at || Date.now() - new Date(latest.rows[0].at).getTime() >= 86400000) reason = 'reply_window_closed';
      }
      if (reason) {
        await pool.query("UPDATE channel_outbox SET state='blocked',reason=$2,updated_at=now() WHERE message_id=$1", [row.message_id, reason]);
        continue;
      }
      try {
        await bot.initialize();
        const sent = await bot.thread(row.thread_id).post({ markdown: channelReply(row.text, Boolean(row.attachments?.length)) });
        await pool.query("UPDATE channel_outbox SET state='sent',provider_message_id=$2,updated_at=now() WHERE message_id=$1", [row.message_id, sent.id]);
      } catch {
        await pool.query("UPDATE channel_outbox SET state='uncertain',reason='send_not_confirmed',updated_at=now() WHERE message_id=$1", [row.message_id]);
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
      }
      catch { lastError = 'Channel processing needs attention. Check the local database and task service.'; }
      finally { running = undefined; }
    })();
    return running;
  }
  const onEvent = (event: { type?: string }) => { if (event.type === 'refresh') void drain(); };
  events.on('event', onEvent);
  const timer = setInterval(() => { void drain(); }, options.intervalMs ?? 2000);
  timer.unref();

  async function close() {
    closed = true;
    clearInterval(timer);
    events.off('event', onEvent);
    await running;
    await bot.shutdown();
  }

  function registerRoutes(app: FastifyInstance) {
    app.addHook('onClose', close);
    app.get('/api/channels', async () => ({
      channels: configuration, error: lastError,
      inbox: (await pool.query('SELECT state,count(*)::int AS count FROM channel_inbox GROUP BY state')).rows,
      deliveries: (await pool.query('SELECT state,count(*)::int AS count FROM channel_outbox GROUP BY state')).rows,
    }));
    app.register(async scope => {
      scope.removeContentTypeParser('application/json');
      scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 256 * 1024 }, (_request, body, done) => done(null, body));
      scope.post('/api/webhooks/telegram', async (request, reply) => {
        if (!telegram) return reply.code(404).send({ error: 'Channel is not configured.' });
        const secret = request.headers['x-telegram-bot-api-secret-token'];
        if (!sameSecret(typeof secret === 'string' ? secret : undefined, env.TELEGRAM_WEBHOOK_SECRET_TOKEN!)) return reply.code(401).send({ error: 'Invalid webhook.' });
        let payload: unknown;
        try { payload = JSON.parse(String(request.body)); } catch { return reply.code(400).send({ error: 'Invalid JSON.' }); }
        const update = z.object({ update_id: z.number().int().nonnegative(), message: z.unknown() }).safeParse(payload);
        const parsed = telegramMessage.safeParse(update.success ? update.data.message : undefined);
        if (parsed.success && String(parsed.data.from.id) === env.TELEGRAM_ALLOWED_USER_ID && String(parsed.data.chat.id) === env.TELEGRAM_ALLOWED_USER_ID) {
          const message = telegram.parseMessage(parsed.data);
          await accept('telegram', env.TELEGRAM_BOT_TOKEN!.split(':')[0], String(parsed.data.from.id), message.id, message.threadId, message.text, message.metadata.dateSent);
          void drain();
        }
        return { ok: true };
      });
      scope.get('/api/webhooks/whatsapp', async (request, reply) => {
        if (!whatsapp) return reply.code(404).send({ error: 'Channel is not configured.' });
        const query = z.object({ 'hub.mode': z.literal('subscribe'), 'hub.verify_token': z.string(), 'hub.challenge': z.string().regex(/^\d{1,256}$/) }).safeParse(request.query);
        if (!query.success || !sameSecret(query.data['hub.verify_token'], env.WHATSAPP_VERIFY_TOKEN!)) return reply.code(403).send({ error: 'Invalid webhook.' });
        return reply.type('text/plain').send(query.data['hub.challenge']);
      });
      scope.post('/api/webhooks/whatsapp', async (request, reply) => {
        if (!whatsapp) return reply.code(404).send({ error: 'Channel is not configured.' });
        const signature = request.headers['x-hub-signature-256'];
        const expected = `sha256=${createHmac('sha256', env.WHATSAPP_APP_SECRET!).update(Buffer.isBuffer(request.body) ? request.body : '').digest('hex')}`;
        if (!sameSecret(typeof signature === 'string' ? signature : undefined, expected)) return reply.code(401).send({ error: 'Invalid webhook.' });
        let payload: unknown;
        try { payload = JSON.parse(String(request.body)); } catch { return reply.code(400).send({ error: 'Invalid JSON.' }); }
        const envelope = whatsappEnvelope.safeParse(payload);
        if (envelope.success) for (const entry of envelope.data.entry) for (const change of entry.changes) {
          if (change.field !== 'messages' || change.value.metadata?.phone_number_id !== env.WHATSAPP_PHONE_NUMBER_ID) continue;
          for (const raw of change.value.messages ?? []) {
            const parsed = whatsappMessage.safeParse(raw);
            if (!parsed.success || parsed.data.from !== env.WHATSAPP_ALLOWED_NUMBER) continue;
            const message = whatsapp.parseMessage({ message: parsed.data, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!, userId: parsed.data.from });
            await accept('whatsapp', env.WHATSAPP_PHONE_NUMBER_ID!, parsed.data.from, message.id, message.threadId, message.text, message.metadata.dateSent);
          }
        }
        void drain();
        return { ok: true };
      });
    });
  }

  return { registerRoutes, drain, close };
}
