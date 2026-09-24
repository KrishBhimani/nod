import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { pool, initializeDatabase } from './db.ts';
import { dataRoot, ownerId, port } from './config.ts';
import { createApp } from './app.ts';
import { createVault } from './vault.ts';
import { createIntegrations } from './integrations.ts';
import { configureTasks, initializeTasks, resumeTask, startTaskWorkers, stopTasks, submitTask } from './tasks.ts';
import { injectCredentials, runTask } from '../runtime/index.ts';
import { initializePersonal, managePersonal, registerPersonalRoutes } from './personal.ts';
import { initializeHeartbeat, registerTriageRoutes, triageEvent } from './triage.ts';
import { createApprovals } from './approvals.ts';
import { createChannels } from './channels.ts';

await mkdir(dataRoot, { recursive: true, mode: 0o700 });
await initializeDatabase();
const vault = await createVault(pool, { resume: resumeTask, inject: injectCredentials });
const integrations = await createIntegrations(pool, { wake: triageEvent });
const approvals = await createApprovals((action, args) => action.startsWith('SIDEKICK_') ? managePersonal(action.slice(9), args) : integrations.executeApproved(ownerId, action, args));
configureTasks({
  runTask, manage: async (taskId, action, args) => {
    if (['profile_update', 'goal_create', 'goal_update', 'schedule_create', 'schedule_cancel', 'memory_propose'].includes(action)) return approvals.request(taskId, `SIDEKICK_${action}`, args);
    return managePersonal(action, args);
  },
  requestCredential: async (taskId, input) => {
    if (input.kind === 'password') {
      const matches = (await vault.list(ownerId)).filter(entry => entry.origin === input.origin);
      if (matches.length === 1) {
        try { await vault.fillSaved(taskId, ownerId, matches[0].id, input); return { filled: true }; } catch { }
      }
    }
    return vault.request(taskId, ownerId, input);
  },
  integration: async (taskId, action, args) => {
    const result = await integrations.execute(ownerId, action, args);
    if (result && typeof result === 'object' && 'requiresApproval' in result && result.requiresApproval) return approvals.request(taskId, action, args);
    return result;
  },
});
await initializeTasks({ workers: false });
await initializePersonal();
await initializeHeartbeat();
await startTaskWorkers();
const channels = await createChannels(pool, { submit: (text, sourceId, client) => submitTask(text, [], undefined, false, { sourceId, source: 'user', client }) });
const app = await createApp();
vault.registerRoutes(app);
integrations.registerRoutes(app);
approvals.registerRoutes(app);
channels.registerRoutes(app);
registerPersonalRoutes(app);
registerTriageRoutes(app);
if (process.env.NODE_ENV !== 'production') {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, hmr: { server: app.server }, watch: { ignored: ['**/.local/**', '**/.env*'] }, fs: { deny: ['.env', '.env.*', '**/.git/**', '**/.local/**', '**/src/server/**', '**/src/runtime/**', '**/*.pem'] } }, appType: 'spa' });
  await app.register((await import('@fastify/middie')).default);
  app.use((request, response, next) => request.url?.startsWith('/api/') ? next() : vite.middlewares(request, response, next));
  app.addHook('onClose', async () => { await vite.close(); });
} else {
  await app.register((await import('@fastify/static')).default, { root: resolve('dist/web'), index: 'index.html', wildcard: false });
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'Route not found.' }) : reply.sendFile('index.html'));
}
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stopTasks(); await app.close(); await pool.end(); process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
await app.listen({ port, host: '127.0.0.1' });
console.log(`Sidekick is ready at http://localhost:${port}`);
