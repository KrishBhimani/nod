import { resolve } from 'node:path';
import { pool } from './db.ts';
import { port } from './config.ts';
import { createApplication, createDefaultAdapters } from './composition.ts';

const { app } = await createApplication(createDefaultAdapters());
if (process.env.NODE_ENV !== 'production') {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: {
      middlewareMode: true,
      hmr: { server: app.server },
      watch: { ignored: ['**/.local/**', '**/.env*'] },
      fs: {
        deny: [
          '.env',
          '.env.*',
          '**/.git/**',
          '**/.local/**',
          '**/src/server/**',
          '**/src/runtime/**',
          '**/src/providers/**',
          '**/src/ports/**',
          '**/*.pem',
        ],
      },
    },
    appType: 'spa',
  });
  await app.register((await import('@fastify/middie')).default);
  app.use((request, response, next) =>
    request.url?.startsWith('/api/') ? next() : vite.middlewares(request, response, next),
  );
  app.addHook('preClose', async () => {
    await vite.close();
  });
} else {
  await app.register((await import('@fastify/static')).default, {
    root: resolve('dist/web'),
    index: 'index.html',
    wildcard: false,
  });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith('/api/')
      ? reply.code(404).send({ error: 'Route not found.' })
      : reply.sendFile('index.html'),
  );
}
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
await app.listen({ port, host: '127.0.0.1' });
console.log(`Sidekick is ready at http://localhost:${port}`);
