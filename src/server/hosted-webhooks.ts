import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { IntegrationProvider } from '../ports/integrations.ts';
import type { TenantRuntimeHost } from '../ports/tenant-runtime.ts';

export function channelWebhookToken(
  master: Uint8Array,
  environment: string,
  ownerId: string,
  provider: 'telegram' | 'whatsapp',
) {
  return createHmac('sha256', master)
    .update(JSON.stringify(['sidekick-webhook-v1', environment, z.uuid().parse(ownerId), provider]))
    .digest('base64url');
}

export function createHostedWebhooks(options: {
  integrations: Pick<IntegrationProvider, 'verifyWebhook' | 'webhooksConfigured'>;
  runtimes: TenantRuntimeHost;
  masterKey: Uint8Array;
  environment: string;
  listOwners(): Promise<string[]>;
  hasOwner(ownerId: string): Promise<boolean>;
}) {
  return async (request: Request) => {
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length > 262_144)
      return Response.json({ error: 'This request is too large.' }, { status: 413 });
    const headers = new Headers();
    for (const key of [
      'content-type',
      'webhook-id',
      'webhook-timestamp',
      'webhook-signature',
      'x-telegram-bot-api-secret-token',
      'x-hub-signature-256',
    ]) {
      const value = request.headers.get(key);
      if (value) headers.set(key, value);
    }
    let ownerId: string | undefined;
    let path = url.pathname;
    if (path === '/api/webhooks/composio' && request.method === 'POST') {
      if (!options.integrations.webhooksConfigured)
        return Response.json({ error: 'Webhooks are unavailable.' }, { status: 503 });
      try {
        const event = await options.integrations.verifyWebhook(
          Buffer.from(body).toString('utf8'),
          Object.fromEntries(headers),
        );
        ownerId = z.uuid().parse(event.ownerId);
      } catch {
        return Response.json({ error: 'Invalid webhook signature or payload.' }, { status: 401 });
      }
    } else {
      const match = /^\/api\/webhooks\/(telegram|whatsapp)\/([A-Za-z0-9_-]{43})$/.exec(path);
      if (
        !match ||
        (request.method !== 'POST' && !(request.method === 'GET' && match[1] === 'whatsapp'))
      )
        return Response.json({ error: 'Route not found.' }, { status: 404 });
      for (const owner of await options.listOwners()) {
        const token = channelWebhookToken(
          options.masterKey,
          options.environment,
          owner,
          match[1] as 'telegram' | 'whatsapp',
        );
        if (timingSafeEqual(Buffer.from(token), Buffer.from(match[2]))) ownerId = owner;
      }
      path = `/api/webhooks/${match[1]}`;
    }
    if (!ownerId || !(await options.hasOwner(ownerId)))
      return Response.json({ ok: true }, { status: 202 });
    return options.runtimes.fetch(
      ownerId,
      new Request(`http://sidekick.runtime${path}${url.search}`, {
        method: request.method,
        headers,
        signal: request.signal,
        ...(request.method === 'POST' ? { body } : {}),
      }),
      { developer: false, kind: 'webhook' },
    );
  };
}
