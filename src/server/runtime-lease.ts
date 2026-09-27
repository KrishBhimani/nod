import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export function createRuntimeLease(options: {
  expiresAt: string;
  fence: () => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let expiry = Date.parse(options.expiresAt);
  let fenced = false;
  if (!Number.isFinite(expiry) || expiry <= now() || expiry > now() + 65_000)
    throw new Error('The runtime lease is invalid.');
  let timer: ReturnType<typeof setTimeout>;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        if (fenced) return;
        fenced = true;
        options.fence();
      },
      Math.max(0, expiry - now()),
    );
    timer.unref();
  }
  schedule();
  return {
    register(app: FastifyInstance) {
      app.addHook('onRequest', async (_request, reply) => {
        if (fenced || now() >= expiry)
          return reply.code(503).send({ error: 'The account runtime is restarting.' });
      });
      app.post('/api/runtime/lease', async (request, reply) => {
        const input = z.object({ expiresAt: z.iso.datetime() }).strict().parse(request.body);
        const next = Date.parse(input.expiresAt);
        if (fenced || now() >= expiry || next <= expiry || next > now() + 65_000)
          return reply.code(409).send({ error: 'The runtime lease cannot be renewed.' });
        expiry = next;
        schedule();
        return { ok: true };
      });
      app.post('/api/runtime/wake', async () => ({ ok: true }));
    },
    close() {
      clearTimeout(timer);
    },
  };
}
