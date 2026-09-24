import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { createReadStream } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { pool } from './db.ts';
import { configuration, ownerId, port } from './config.ts';
import { events } from './events.ts';
import { artifactView, maxFileSize, storeArtifact } from './artifacts.ts';
import { cancelTask, submitUserMessage } from './tasks.ts';
import { registerLocalAccess } from './access.ts';
import type { SpeechService } from './speech.ts';
import type { Computer } from '../ports/computer.ts';
import type { Configuration } from '../shared/contracts.ts';

export interface AppDependencies {
  speech?: SpeechService;
  computer?: Pick<Computer, 'screenshot' | 'status' | 'screenStatus'>;
  runtime?: { status(): { browser: string; workspace: string; activeTasks?: number } };
  configuration?: () => Configuration;
  onboard?: (timeZone?: string) => Promise<unknown>;
}

export async function createApp(dependencies: AppDependencies = {}) {
  const publicConfiguration = dependencies.configuration ?? configuration;
  const speech = () => {
    if (!dependencies.speech)
      throw Object.assign(new Error('Speech is not configured.'), { statusCode: 503 });
    return dependencies.speech;
  };
  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    trustProxy: false,
    forceCloseConnections: true,
  });
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
  });
  registerLocalAccess(app, port);
  app.setErrorHandler((error, _request, reply) => {
    const known = error instanceof Error ? (error as Error & { statusCode?: number }) : undefined;
    const status = error instanceof z.ZodError ? 400 : known?.statusCode || 500;
    const routing = known as (Error & { code?: string; choices?: unknown[] }) | undefined;
    reply.code(status).send({
      ...(status === 409 && routing?.code === 'task_selection_required'
        ? { code: routing.code, choices: routing.choices }
        : {}),
      error:
        error instanceof z.ZodError
          ? 'Check the supplied values.'
          : status < 500
            ? known?.message
            : 'This request could not be completed. Check the local service and try again.',
    });
  });
  await app.register(multipart, { limits: { fileSize: maxFileSize, files: 1, fields: 5 } });
  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });
  app.get('/api/state', async () => {
    const [messages, tasks] = await Promise.all([
      pool.query(
        `SELECT id,role,text,task_id AS "taskId",created_at AS "createdAt",attachments,stream_id AS "streamId",reaction FROM (SELECT * FROM messages WHERE owner_id=$1 ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT 150) m ORDER BY date_trunc('milliseconds',created_at),id`,
        [ownerId],
      ),
      pool.query(
        'SELECT id,title,status,error,created_at AS "createdAt",updated_at AS "updatedAt" FROM tasks WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 50',
        [ownerId],
      ),
    ]);
    return { messages: messages.rows, tasks: tasks.rows, configuration: publicConfiguration() };
  });
  app.get('/api/messages', async (request) => {
    const query = z
      .object({
        before: z.iso.datetime({ offset: true }).optional(),
        beforeId: z.uuid().optional(),
      })
      .parse(request.query);
    const rows = await pool.query(
      `SELECT id,role,text,task_id AS "taskId",created_at AS "createdAt",attachments,stream_id AS "streamId",reaction FROM messages
      WHERE owner_id=$1 AND ($2::timestamptz IS NULL OR date_trunc('milliseconds',created_at) < $2 OR (date_trunc('milliseconds',created_at) = $2 AND $3::uuid IS NOT NULL AND id < $3))
      ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT 60`,
      [ownerId, query.before ?? null, query.beforeId ?? null],
    );
    return rows.rows.reverse();
  });
  app.post<{ Params: { id: string } }>('/api/messages/:id/reaction', async (request, reply) => {
    const { reaction } = z
      .object({ reaction: z.enum(['like', 'dislike', 'heart']).nullable() })
      .strict()
      .parse(request.body);
    const result = await pool.query(
      "UPDATE messages SET reaction=$1 WHERE id=$2 AND owner_id=$3 AND role='assistant' RETURNING id",
      [reaction, z.uuid().parse(request.params.id), ownerId],
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'Message not found.' });
    events.emit('event', { type: 'refresh' });
    return { ok: true, reaction };
  });
  app.post('/api/onboarding', async (request) => {
    const { timeZone } = z
      .object({ timeZone: z.string().max(100).optional() })
      .strict()
      .parse(request.body);
    if (timeZone) {
      try {
        new Intl.DateTimeFormat('en', { timeZone });
      } catch {
        throw Object.assign(new Error('Choose a valid time zone.'), { statusCode: 400 });
      }
    }
    if (!dependencies.onboard)
      throw Object.assign(new Error('Setup is unavailable.'), { statusCode: 503 });
    return dependencies.onboard(timeZone);
  });
  app.post('/api/messages', async (request) => {
    if (!publicConfiguration().llmReady)
      throw Object.assign(
        new Error('Configure an agent provider before starting a conversation.'),
        { statusCode: 503 },
      );
    const input = z
      .object({
        text: z.string().trim().max(24000).default(''),
        attachmentIds: z.array(z.uuid()).max(5).default([]),
        taskId: z.uuid().optional(),
        forceNew: z.boolean().optional(),
      })
      .strict()
      .refine((value) => value.text.length > 0 || value.attachmentIds.length > 0)
      .parse(request.body);
    const result = await pool.query(
      'SELECT * FROM artifacts WHERE id=ANY($1::uuid[]) AND owner_id=$2',
      [input.attachmentIds, ownerId],
    );
    if (result.rowCount !== input.attachmentIds.length)
      throw Object.assign(new Error('An attachment is unavailable.'), { statusCode: 400 });
    const prompt =
      input.text || 'Review the attached files and briefly describe what they contain.';
    return submitUserMessage(prompt, result.rows.map(artifactView), {
      taskId: input.taskId,
      forceNew: input.forceNew,
      channel: 'web',
    });
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const result = await pool.query(
      'SELECT id,title,status,error,created_at AS "createdAt",updated_at AS "updatedAt" FROM tasks WHERE id=$1 AND owner_id=$2',
      [z.uuid().parse(request.params.id), ownerId],
    );
    return result.rows[0] ?? reply.code(404).send({ error: 'Task not found.' });
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (request) => {
    await cancelTask(z.uuid().parse(request.params.id));
    return { ok: true };
  });
  app.get('/api/events', async (request, reply) => {
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: unknown) => {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: 'refresh' });
    events.on('event', send);
    const timer = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000);
    reply.raw.on('close', () => {
      streams.delete(reply.raw);
      clearInterval(timer);
      events.off('event', send);
    });
  });
  app.post('/api/uploads', async (request) => {
    const file = await request.file();
    if (!file) throw Object.assign(new Error('Choose a file to upload.'), { statusCode: 400 });
    return storeArtifact(await file.toBuffer(), file.filename, file.mimetype);
  });
  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (request, reply) => {
    const result = await pool.query('SELECT * FROM artifacts WHERE id=$1 AND owner_id=$2', [
      z.uuid().parse(request.params.id),
      ownerId,
    ]);
    const file = result.rows[0];
    if (!file) return reply.code(404).send({ error: 'File not found.' });
    const inline = /^(image\/(png|jpeg|webp|gif)|audio\/(mpeg|wav|webm|ogg|mp4))$/.test(
      file.mime_type,
    );
    reply
      .header('Content-Type', file.mime_type)
      .header(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      )
      .header('Content-Security-Policy', "default-src 'none'; sandbox");
    return reply.send(createReadStream(file.storage_path));
  });
  app.post('/api/speech/transcribe', async (request) => {
    const file = await request.file();
    if (!file || !file.mimetype.startsWith('audio/'))
      throw Object.assign(new Error('Choose an audio recording.'), { statusCode: 400 });
    const bytes = await file.toBuffer();
    return {
      text: await speech().transcribe({
        bytes,
        mimeType: file.mimetype,
        fileName: file.filename || 'recording.webm',
      }),
    };
  });
  app.post('/api/speech/speak', async (request) => {
    const { text } = z.object({ text: z.string().min(1).max(3000) }).parse(request.body);
    const audio = await speech().synthesize(text);
    return storeArtifact(audio.bytes, audio.fileName, audio.mimeType);
  });
  app.get('/api/inspector', async (_request, reply) => {
    if (!publicConfiguration().inspectorEnabled)
      return reply.code(404).send({ error: 'Inspector is disabled.' });
    const tasks = await pool.query(
      'SELECT id,title,status,error,created_at AS "createdAt",updated_at AS "updatedAt" FROM tasks WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 50',
      [ownerId],
    );
    const events = await pool.query(
      'SELECT e.id,e.task_id AS "taskId",e.type,e.summary,e.created_at AS "createdAt" FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.owner_id=$1 ORDER BY e.created_at DESC LIMIT 200',
      [ownerId],
    );
    const runtime = dependencies.runtime?.status() ?? {
      browser: dependencies.computer?.status() ?? 'Not configured',
      workspace: 'Not configured',
    };
    return {
      tasks: tasks.rows,
      events: events.rows,
      artifacts: (
        await pool.query(
          'SELECT * FROM artifacts WHERE owner_id=$1 AND task_id IS NOT NULL ORDER BY created_at DESC LIMIT 50',
          [ownerId],
        )
      ).rows.map((row) => ({ ...artifactView(row), taskId: row.task_id })),
      runtime: { ...runtime, database: 'PostgreSQL connected' },
    };
  });
  app.get<{ Querystring: { taskId: string } }>('/api/inspector/screen', async (request, reply) => {
    if (!publicConfiguration().inspectorEnabled)
      return reply.code(404).send({ error: 'Inspector is disabled.' });
    const id = z.uuid().parse(request.query.taskId);
    const task = await pool.query('SELECT id FROM tasks WHERE id=$1 AND owner_id=$2', [
      id,
      ownerId,
    ]);
    if (!task.rowCount) return reply.code(404).send({ error: 'Task not found.' });
    const screen = await dependencies.computer?.screenshot(id);
    if (!screen) return reply.code(404).send({ error: 'This task has no browser screen yet.' });
    const screenStatus = dependencies.computer?.screenStatus?.(id);
    reply.header('X-Screen-State', screenStatus?.state ?? 'live');
    if (screenStatus?.capturedAt) reply.header('X-Screen-Captured-At', screenStatus.capturedAt);
    return reply.type('image/png').send(screen);
  });
  app.get(
    '/api/memory',
    async () =>
      (
        await pool.query(
          'SELECT id,text,source_message_id AS "sourceMessageId",created_at AS "createdAt" FROM memory_facts WHERE owner_id=$1 ORDER BY created_at DESC',
          [ownerId],
        )
      ).rows,
  );
  app.delete<{ Params: { id: string } }>('/api/memory/:id', async (request) => {
    await pool.query('DELETE FROM memory_facts WHERE id=$1 AND owner_id=$2', [
      z.uuid().parse(request.params.id),
      ownerId,
    ]);
    return { ok: true };
  });
  return app;
}
