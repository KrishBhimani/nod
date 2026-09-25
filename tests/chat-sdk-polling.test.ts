import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { createChatSdkTransport } from '../src/providers/chat-sdk/index.ts';

test('Telegram polling retries initialization after a transient database failure', async () => {
  let attempts = 0,
    requests = 0;
  const pool = {
    query: async (sql: string) => {
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS channel_poll_offsets')) {
        attempts++;
        if (attempts === 1) throw new Error('synthetic database outage');
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  const transport = createChatSdkTransport(
    pool,
    {
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_MODE: 'polling',
      TELEGRAM_BOT_TOKEN: '987:fixture-not-live',
      TELEGRAM_WEBHOOK_SECRET_TOKEN: 'fixture-webhook-secret-32-characters',
      TELEGRAM_ALLOWED_USER_ID: '123456',
    },
    {
      fetch: async () => {
        requests++;
        return Response.json({ ok: true, result: [] });
      },
    },
  );
  try {
    await assert.rejects(
      transport.poll!(async () => {}),
      /Telegram polling is unavailable/,
    );
    assert.equal(requests, 0);
    await transport.poll!(async () => {});
    await transport.poll!(async () => {});
    assert.equal(attempts, 2);
    assert.equal(requests, 2);
  } finally {
    await transport.close();
  }
});
