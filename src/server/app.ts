import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from './db.ts';
import { configuration, ownerId, port } from './config.ts';
import { events } from './events.ts';
import { artifactView, maxFileSize, storeArtifact } from './artifacts.ts';
import { cancelTask, submitTask } from './tasks.ts';
import { registerLocalAccess } from './access.ts';
import { synthesizeSpeech } from './speech.ts';
import { getScreenshot, runtimeStatus } from '../runtime/index.ts';

export async function createApp() {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: false, forceCloseConnections: true });
  registerLocalAccess(app, port);
  app.setErrorHandler((error, _request, reply) => {
    const known = error instanceof Error ? error as Error & { statusCode?: number } : undefined;
    const status = error instanceof z.ZodError ? 400 : known?.statusCode || 500;
    reply.code(status).send({ error: error instanceof z.ZodError ? 'Check the supplied values.' : status < 500 ? known?.message : 'This request could not be completed. Check the local service and try again.' });
  });
  await app.register(multipart, { limits: { fileSize: maxFileSize, files: 1, fields: 5 } });
  app.get('/api/health', async () => { await pool.query('SELECT 1'); return { ok: true }; });
  app.get('/api/state', async () => {
    const [messages, tasks] = await Promise.all([
      pool.query('SELECT id,role,text,task_id AS "taskId",created_at AS "createdAt",attachments FROM (SELECT * FROM messages WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 150) m ORDER BY created_at', [ownerId]),
      pool.query('SELECT id,title,status,error,created_at AS "createdAt",updated_at AS "updatedAt" FROM tasks WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 50', [ownerId]),
    ]);
    return { messages: messages.rows, tasks: tasks.rows, configuration: configuration() };
  });
  app.post('/api/messages', async request => {
    if (!configuration().llmReady) throw Object.assign(new Error('Add an OpenAI or Anthropic API key to the local environment, then restart Sidekick.'), { statusCode: 503 });
    const input = z.object({ text: z.string().trim().min(1).max(24000), attachmentIds: z.array(z.uuid()).max(5).default([]), taskId: z.uuid().optional() }).strict().parse(request.body);
    const result = await pool.query('SELECT * FROM artifacts WHERE id=ANY($1::uuid[]) AND owner_id=$2', [input.attachmentIds, ownerId]);
    if (result.rowCount !== input.attachmentIds.length) throw Object.assign(new Error('An attachment is unavailable.'), { statusCode: 400 });
    return { taskId: await submitTask(input.text, result.rows.map(artifactView), input.taskId) };
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async request => { await cancelTask(z.uuid().parse(request.params.id)); return { ok: true }; });
  app.get('/api/events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: unknown) => { if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); };
    send({ type: 'refresh' });
    events.on('event', send);
    const timer = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000);
    reply.raw.on('close', () => { clearInterval(timer); events.off('event', send); });
  });
  app.post('/api/uploads', async request => {
    const file = await request.file();
    if (!file) throw Object.assign(new Error('Choose a file to upload.'), { statusCode: 400 });
    return storeArtifact(await file.toBuffer(), file.filename, file.mimetype);
  });
  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (request, reply) => {
    const result = await pool.query('SELECT * FROM artifacts WHERE id=$1 AND owner_id=$2', [z.uuid().parse(request.params.id), ownerId]);
    const file = result.rows[0];
    if (!file) return reply.code(404).send({ error: 'File not found.' });
    const inline = /^(image\/(png|jpeg|webp|gif)|audio\/(mpeg|wav|webm|ogg|mp4))$/.test(file.mime_type);
    reply.header('Content-Type', file.mime_type).header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`).header('Content-Security-Policy', "default-src 'none'; sandbox");
    return reply.send(createReadStream(file.storage_path));
  });
  app.post('/api/speech/transcribe', async request => {
    if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error('OpenAI speech is not configured.'), { statusCode: 503 });
    const file = await request.file();
    if (!file || !file.mimetype.startsWith('audio/')) throw Object.assign(new Error('Choose an audio recording.'), { statusCode: 400 });
    const bytes = await file.toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: file.mimetype }), file.filename || 'recording.webm');
    form.append('model', process.env.STT_MODEL || 'gpt-4o-mini-transcribe');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('Speech transcription failed.');
    const result = await response.json() as { text: string };
    return { text: result.text };
  });
  app.post('/api/speech/speak', async request => {
    const { text } = z.object({ text: z.string().min(1).max(3000) }).parse(request.body);
    return storeArtifact(await synthesizeSpeech(text), 'reply.mp3', 'audio/mpeg');
  });
  app.get('/api/inspector', async (_request, reply) => {
    if (!configuration().inspectorEnabled) return reply.code(404).send({ error: 'Inspector is disabled.' });
    const tasks = await pool.query('SELECT id,title,status,error,created_at AS "createdAt",updated_at AS "updatedAt" FROM tasks WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 50', [ownerId]);
    const events = await pool.query('SELECT e.id,e.task_id AS "taskId",e.type,e.summary,e.created_at AS "createdAt" FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.owner_id=$1 ORDER BY e.created_at DESC LIMIT 200', [ownerId]);
    return { tasks: tasks.rows, events: events.rows, runtime: { ...runtimeStatus(), database: 'PostgreSQL connected' } };
  });
  app.get<{ Querystring: { taskId: string } }>('/api/inspector/screen', async (request, reply) => {
    if (!configuration().inspectorEnabled) return reply.code(404).send({ error: 'Inspector is disabled.' });
    const id = z.uuid().parse(request.query.taskId);
    const task = await pool.query('SELECT id FROM tasks WHERE id=$1 AND owner_id=$2', [id, ownerId]);
    if (!task.rowCount) return reply.code(404).send({ error: 'Task not found.' });
    const screen = await getScreenshot(id);
    if (!screen) return reply.code(404).send({ error: 'This task has no browser screen yet.' });
    return reply.type('image/png').send(screen);
  });
  app.get('/api/memory', async () => (await pool.query('SELECT id,text,source_message_id AS "sourceMessageId",created_at AS "createdAt" FROM memory_facts WHERE owner_id=$1 ORDER BY created_at DESC', [ownerId])).rows);
  app.delete<{ Params: { id: string } }>('/api/memory/:id', async request => { await pool.query('DELETE FROM memory_facts WHERE id=$1 AND owner_id=$2', [z.uuid().parse(request.params.id), ownerId]); return { ok: true }; });
  return app;
}
