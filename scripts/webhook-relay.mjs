import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function webhookRoute(method, target) {
  if (
    typeof target !== 'string' ||
    target.length > 8192 ||
    !target.startsWith('/') ||
    /[\\#\u0000-\u0020\u007f]/.test(target)
  )
    return false;
  const path = target.split('?')[0];
  if (method === 'POST' && path === '/api/webhooks/composio') return true;
  const match = /^\/api\/webhooks\/(telegram|whatsapp)\/[A-Za-z0-9_-]{43}$/.exec(path);
  return Boolean(match && (method === 'POST' || (method === 'GET' && match[1] === 'whatsapp')));
}

export function createWebhookRelay({ target = 'http://localhost:4330', fetch: send = fetch } = {}) {
  const origin = new URL(target);
  if (
    origin.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
    !origin.port ||
    ['4318', '4320'].includes(origin.port) ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error('The webhook relay requires a separate loopback application origin.');
  return createServer(async (request, response) => {
    const finish = (status, error) => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(JSON.stringify({ error }));
    };
    if (!webhookRoute(request.method, request.url)) {
      request.resume();
      finish(404, 'Route not found.');
      return;
    }
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
      request.destroy();
    };
    response.once('close', abort);
    const timer = setTimeout(abort, 30_000);
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 262_144) {
          finish(413, 'This request is too large.');
          return;
        }
        chunks.push(chunk);
      }
      if (request.method === 'GET' && size) {
        finish(400, 'This request is not permitted.');
        return;
      }
      const headers = new Headers();
      for (const key of [
        'content-type',
        'webhook-id',
        'webhook-timestamp',
        'webhook-signature',
        'x-telegram-bot-api-secret-token',
        'x-hub-signature-256',
      ]) {
        const value = request.headers[key];
        if (typeof value === 'string') headers.set(key, value);
      }
      const upstream = await send(new URL(request.url, origin), {
        method: request.method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
        ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      });
      const result = [];
      let length = 0;
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > 262_144) {
              await reader.cancel();
              finish(502, 'The webhook response could not be relayed.');
              return;
            }
            result.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(Buffer.concat(result));
    } catch {
      if (!response.headersSent && !response.destroyed)
        finish(502, 'The webhook request could not be relayed.');
    } finally {
      clearTimeout(timer);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 2) throw new Error('Usage: node scripts/webhook-relay.mjs');
    const server = createWebhookRelay();
    server.on('error', () => {
      console.error('The local webhook relay could not start.');
      process.exitCode = 1;
    });
    server.listen(4331, '127.0.0.1', () =>
      console.log('Webhook relay is ready at http://127.0.0.1:4331.'),
    );
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.on(signal, () => {
        server.close();
        server.closeAllConnections();
      });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
