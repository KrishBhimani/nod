import { createHmac, timingSafeEqual } from 'node:crypto';
import { Chat, ConsoleLogger } from 'chat';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { createWhatsAppAdapter } from '@chat-adapter/whatsapp';
import { createPostgresState } from '@chat-adapter/state-pg';
import type { Pool } from 'pg';
import { z } from 'zod';
import type {
  InboundMessage,
  MessagingChannel,
  MessagingTransport,
  MessagingWebhookResult,
} from '../../ports/messaging.ts';

type Environment = Record<string, string | undefined>;

const logger = new ConsoleLogger('silent');
const telegramMessage = z.object({
  message_id: z.number().int().nonnegative(),
  date: z.number().int().positive(),
  text: z.string().trim().min(1).max(24000),
  from: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    is_bot: z.literal(false),
    first_name: z.string().max(256),
  }),
  chat: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    type: z.literal('private'),
  }),
});
const whatsappMessage = z.object({
  id: z.string().min(1).max(256),
  from: z.string().regex(/^\d{7,15}$/),
  timestamp: z.string().regex(/^\d{1,12}$/),
  type: z.literal('text'),
  text: z.object({ body: z.string().trim().min(1).max(24000) }),
});
const whatsappEnvelope = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              field: z.string(),
              value: z.object({
                metadata: z.object({ phone_number_id: z.string() }).optional(),
                messages: z.array(z.unknown()).max(100).optional(),
              }),
            }),
          )
          .max(100),
      }),
    )
    .max(100),
});

function sameSecret(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function channelConfiguration(env: Environment) {
  const telegramMissing = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET_TOKEN',
    'TELEGRAM_ALLOWED_USER_ID',
  ].filter((key) => !env[key]);
  if (env.TELEGRAM_ALLOWED_USER_ID && !/^\d{1,16}$/.test(env.TELEGRAM_ALLOWED_USER_ID))
    telegramMissing.push('TELEGRAM_ALLOWED_USER_ID');
  if (
    env.TELEGRAM_WEBHOOK_SECRET_TOKEN &&
    !/^[A-Za-z0-9_-]{16,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET_TOKEN)
  )
    telegramMissing.push('TELEGRAM_WEBHOOK_SECRET_TOKEN');
  if (env.TELEGRAM_BOT_TOKEN && !/^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN))
    telegramMissing.push('TELEGRAM_BOT_TOKEN');
  const whatsappMissing = [
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_ALLOWED_NUMBER',
  ].filter((key) => !env[key]);
  if (env.WHATSAPP_ALLOWED_NUMBER && !/^\d{7,15}$/.test(env.WHATSAPP_ALLOWED_NUMBER))
    whatsappMissing.push('WHATSAPP_ALLOWED_NUMBER');
  if (env.WHATSAPP_PHONE_NUMBER_ID && !/^\d+$/.test(env.WHATSAPP_PHONE_NUMBER_ID))
    whatsappMissing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (env.WHATSAPP_POLICY_CONFIRMED !== 'true') whatsappMissing.push('WHATSAPP_POLICY_CONFIRMED');
  return (['telegram', 'whatsapp'] as const).map((provider) => {
    const enabled = env[`${provider.toUpperCase()}_ENABLED`] === 'true';
    const missing = provider === 'telegram' ? telegramMissing : whatsappMissing;
    return {
      provider,
      status: (!enabled
        ? 'disabled'
        : missing.length
          ? 'setup_required'
          : 'configured') as MessagingChannel['status'],
      missing: enabled ? missing : [],
    };
  });
}

export function createChatSdkTransport(pool: Pool, environment: Environment): MessagingTransport {
  const env = { ...environment };
  const configuration = channelConfiguration(env);
  const configured = (provider: string) =>
    configuration.some(
      (channel) => channel.provider === provider && channel.status === 'configured',
    );
  const telegram = configured('telegram')
    ? createTelegramAdapter({
        botToken: env.TELEGRAM_BOT_TOKEN!,
        secretToken: env.TELEGRAM_WEBHOOK_SECRET_TOKEN!,
        allowedUserIds: [env.TELEGRAM_ALLOWED_USER_ID!],
        mode: 'webhook',
        allowUnverifiedWebhooks: false,
        apiUrl: 'https://api.telegram.org',
        logger,
      })
    : undefined;
  const whatsapp = configured('whatsapp')
    ? createWhatsAppAdapter({
        accessToken: env.WHATSAPP_ACCESS_TOKEN!,
        appSecret: env.WHATSAPP_APP_SECRET!,
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!,
        verifyToken: env.WHATSAPP_VERIFY_TOKEN!,
        apiUrl: 'https://graph.facebook.com',
        logger,
      })
    : undefined;
  const state = createPostgresState({ client: pool, keyPrefix: 'sidekick-channels', logger });
  const bot = new Chat({
    userName: 'Sidekick',
    adapters: { ...(telegram ? { telegram } : {}), ...(whatsapp ? { whatsapp } : {}) },
    state,
    logger,
  });
  const channels: MessagingChannel[] = configuration.map((channel) => ({
    id: channel.provider,
    status: channel.status,
    missing: channel.missing,
    accountId:
      channel.provider === 'telegram'
        ? env.TELEGRAM_BOT_TOKEN?.split(':')[0]
        : env.WHATSAPP_PHONE_NUMBER_ID,
    allowedSenderIds: [
      channel.provider === 'telegram' ? env.TELEGRAM_ALLOWED_USER_ID : env.WHATSAPP_ALLOWED_NUMBER,
    ].filter((value): value is string => Boolean(value)),
    ...(channel.provider === 'whatsapp' ? { replyWindowMs: 86400000 } : {}),
  }));
  const error = (status: number, message: string): MessagingWebhookResult => ({
    status,
    body: { error: message },
  });
  const accepted = (messages: InboundMessage[] = []): MessagingWebhookResult => ({
    status: 200,
    body: { ok: true },
    messages,
  });
  let closed = false;
  return {
    channels,
    async receive(request) {
      if (!configured(request.channelId)) return error(404, 'Channel is not configured.');
      if (request.channelId === 'whatsapp' && request.method === 'GET') {
        const query = z
          .object({
            'hub.mode': z.literal('subscribe'),
            'hub.verify_token': z.string(),
            'hub.challenge': z.string().regex(/^\d{1,256}$/),
          })
          .safeParse(request.query);
        if (
          !query.success ||
          !sameSecret(query.data['hub.verify_token'], env.WHATSAPP_VERIFY_TOKEN!)
        )
          return error(403, 'Invalid webhook.');
        return { status: 200, body: query.data['hub.challenge'], contentType: 'text/plain' };
      }
      if (request.method !== 'POST') return error(405, 'This webhook method is unavailable.');
      if (request.channelId === 'telegram') {
        const secret = request.headers['x-telegram-bot-api-secret-token'];
        if (
          !sameSecret(
            typeof secret === 'string' ? secret : undefined,
            env.TELEGRAM_WEBHOOK_SECRET_TOKEN!,
          )
        )
          return error(401, 'Invalid webhook.');
      } else {
        const signature = request.headers['x-hub-signature-256'];
        const expected = `sha256=${createHmac('sha256', env.WHATSAPP_APP_SECRET!).update(request.body).digest('hex')}`;
        if (!sameSecret(typeof signature === 'string' ? signature : undefined, expected))
          return error(401, 'Invalid webhook.');
      }
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(request.body).toString());
      } catch {
        return error(400, 'Invalid JSON.');
      }
      if (request.channelId === 'telegram' && telegram) {
        const update = z
          .object({ update_id: z.number().int().nonnegative(), message: z.unknown() })
          .safeParse(payload);
        const parsed = telegramMessage.safeParse(update.success ? update.data.message : undefined);
        if (!parsed.success || String(parsed.data.from.id) !== String(parsed.data.chat.id))
          return accepted();
        const message = telegram.parseMessage(parsed.data);
        return accepted([
          {
            channelId: 'telegram',
            accountId: env.TELEGRAM_BOT_TOKEN!.split(':')[0],
            senderId: String(parsed.data.from.id),
            messageId: message.id,
            threadId: message.threadId,
            text: message.text,
            sentAt: message.metadata.dateSent,
          },
        ]);
      }
      const messages: InboundMessage[] = [];
      const envelope = whatsappEnvelope.safeParse(payload);
      if (envelope.success && whatsapp)
        for (const entry of envelope.data.entry)
          for (const change of entry.changes) {
            if (change.field !== 'messages' || !change.value.metadata?.phone_number_id) continue;
            for (const raw of change.value.messages ?? []) {
              const parsed = whatsappMessage.safeParse(raw);
              if (!parsed.success) continue;
              const accountId = change.value.metadata.phone_number_id;
              const message = whatsapp.parseMessage({
                message: parsed.data,
                phoneNumberId: accountId,
                userId: parsed.data.from,
              });
              messages.push({
                channelId: 'whatsapp',
                accountId,
                senderId: parsed.data.from,
                messageId: message.id,
                threadId: message.threadId,
                text: message.text,
                sentAt: message.metadata.dateSent,
              });
            }
          }
      return accepted(messages);
    },
    async post(input) {
      if (
        !channels.some(
          (channel) =>
            channel.id === input.channelId &&
            channel.status === 'configured' &&
            channel.accountId === input.accountId,
        )
      )
        throw new Error('Channel is not configured.');
      await bot.initialize();
      const sent = await bot.thread(input.threadId).post({ markdown: input.text });
      return { id: sent.id };
    },
    async close() {
      if (!closed) {
        closed = true;
        await bot.shutdown();
      }
    },
  };
}
