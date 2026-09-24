import type { FastifyInstance } from 'fastify';

export function registerLocalAccess(app: FastifyInstance, port: number) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store').header('Content-Security-Policy', "frame-ancestors 'none'");
    const path = request.url.split('?')[0];
    if (request.method === 'POST' && ['/api/webhooks/composio', '/api/webhooks/telegram', '/api/webhooks/whatsapp'].includes(path)) return;
    if (request.method === 'GET' && path === '/api/webhooks/whatsapp') return;
    if (!hosts.has(request.headers.host || '')) return reply.code(403).send({ error: 'Sidekick is only available on localhost.' });
    if (request.headers.origin) {
      let origin: URL;
      try { origin = new URL(request.headers.origin); } catch { return reply.code(403).send({ error: 'Invalid origin.' }); }
      if (origin.protocol !== 'http:' || !hosts.has(origin.host)) return reply.code(403).send({ error: 'This origin is not permitted.' });
    }
    if (request.headers['sec-fetch-site'] === 'cross-site' && request.url.split('?')[0] !== '/api/connections/callback') return reply.code(403).send({ error: 'Cross-site requests are not permitted.' });
  });
}
