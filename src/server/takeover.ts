import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Computer } from '../ports/computer.ts';
import { browserInputSchema as inputSchema } from '../shared/browser-input.ts';

export function createTakeover(dependencies: {
  pool: Pick<Pool, 'query'>;
  ownerId: string;
  computer: Pick<
    Computer,
    | 'takeControl'
    | 'control'
    | 'releaseControl'
    | 'openSignIn'
    | 'finishSignIn'
    | 'signInScreenshot'
    | 'signInControl'
  >;
  enabled(): boolean;
  pause(): Promise<{ threadId: string }>;
  resume(): Promise<{ ok: boolean }>;
  waitForThread(threadId: string): Promise<void>;
}) {
  let queue: Promise<unknown> = Promise.resolve();
  let session: { threadId: string; mode: 'manual' | 'sign_in'; expiresAt: number } | undefined;
  const signInAvailable = () =>
    Boolean(
      dependencies.computer.openSignIn &&
      dependencies.computer.finishSignIn &&
      dependencies.computer.signInScreenshot &&
      dependencies.computer.signInControl &&
      dependencies.computer.releaseControl,
    );
  const unavailable = () =>
    Object.assign(
      new Error(
        'The workspace browser is unavailable. Make sure its container is running, then try Take control again.',
      ),
      {
        statusCode: 409,
      },
    );
  const stale = () =>
    Object.assign(new Error('This browser control session is no longer active.'), {
      statusCode: 409,
    });
  function serialize<T>(operation: () => Promise<T>) {
    const next = queue.catch(() => {}).then(operation);
    queue = next;
    return next;
  }
  async function release() {
    const current = session;
    if (!current) return;
    if (!dependencies.computer.releaseControl) throw unavailable();
    try {
      await dependencies.computer.releaseControl(current.threadId);
    } catch {
      throw unavailable();
    }
    if (session === current) session = undefined;
  }
  async function pausedThread() {
    const thread = (
      await dependencies.pool.query(
        'SELECT id,status FROM threads WHERE owner_id=$1 AND archived_at IS NULL',
        [dependencies.ownerId],
      )
    ).rows[0] as { id: string; status: string } | undefined;
    return thread?.status === 'manual_control' ? thread.id : undefined;
  }
  async function state() {
    const threadId = await pausedThread();
    const paused = Boolean(threadId);
    if (session && (session.threadId !== threadId || session.expiresAt <= Date.now()))
      await release();
    return {
      paused,
      active: Boolean(session),
      mode: session?.mode ?? null,
      signInAvailable: signInAvailable(),
      resumable: paused,
    };
  }
  async function controlled() {
    await state();
    if (!session) throw stale();
    return session;
  }
  async function drain(threadId: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        dependencies.waitForThread(threadId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(unavailable()), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function acquire(requestedMode: 'manual' | 'sign_in' | 'auto', body: unknown) {
    z.object({})
      .strict()
      .parse(body ?? {});
    const mode =
      requestedMode === 'auto' ? (signInAvailable() ? 'sign_in' : 'manual') : requestedMode;
    return serialize(async () => {
      const open =
        mode === 'sign_in' ? dependencies.computer.openSignIn : dependencies.computer.takeControl;
      if (
        !open ||
        (mode === 'manual' && !dependencies.computer.control) ||
        (mode === 'sign_in' && !signInAvailable()) ||
        !dependencies.computer.releaseControl
      )
        throw unavailable();
      await release();
      const { threadId } = await dependencies.pause();
      await drain(threadId);
      try {
        await open.call(dependencies.computer, threadId);
      } catch {
        await dependencies.computer.releaseControl(threadId).catch(() => {});
        throw unavailable();
      }
      session = { threadId, mode, expiresAt: Date.now() + 30 * 60_000 };
      await controlled();
      return { mode, resumable: true };
    });
  }
  async function input(body: unknown) {
    const { input } = z.object({ input: inputSchema }).strict().parse(body);
    return serialize(async () => {
      const control = await controlled();
      const send =
        control.mode === 'sign_in'
          ? dependencies.computer.signInControl
          : dependencies.computer.control;
      if (!send) throw unavailable();
      try {
        await send.call(dependencies.computer, control.threadId, input);
      } catch {
        await release().catch(() => {});
        throw unavailable();
      }
      if ((await controlled()) !== control) throw stale();
      return { ok: true };
    });
  }
  async function screen(reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const controller = new AbortController();
    const abort = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.on('close', abort);
    try {
      const frame = await serialize(async () => {
        if (controller.signal.aborted) throw stale();
        const control = await controlled();
        if (control.mode !== 'sign_in') throw stale();
        if (!dependencies.computer.signInScreenshot) throw unavailable();
        let bytes: Buffer | null;
        try {
          bytes = await dependencies.computer.signInScreenshot(control.threadId, controller.signal);
        } catch {
          throw unavailable();
        }
        if (controller.signal.aborted || (await controlled()) !== control) throw stale();
        if (!bytes?.length) throw unavailable();
        return bytes;
      });
      return reply.type('image/png').header('X-Screen-State', 'live').send(frame);
    } finally {
      reply.raw.removeListener('close', abort);
    }
  }
  async function resume(body: unknown) {
    z.object({})
      .strict()
      .parse(body ?? {});
    return serialize(async () => {
      const threadId = await pausedThread();
      if (!threadId) throw stale();
      try {
        await dependencies.computer.finishSignIn?.(threadId);
      } catch {
        throw unavailable();
      }
      await release();
      return dependencies.resume();
    });
  }
  function registerRoutes(app: FastifyInstance) {
    for (const route of ['/api/browser/control', '/api/inspector/control']) {
      const guard = () => {
        if (route.startsWith('/api/inspector/') && !dependencies.enabled())
          throw Object.assign(new Error('Inspector is disabled.'), { statusCode: 404 });
      };
      app.get(route, async () => {
        guard();
        return serialize(() => state());
      });
      app.post(`${route}/start`, async (request) => {
        guard();
        return acquire('auto', request.body);
      });
      app.post(`${route}/sign-in`, async (request) => {
        guard();
        return acquire('sign_in', request.body);
      });
      app.post(`${route}/input`, async (request) => {
        guard();
        return input(request.body);
      });
      app.get(`${route}/sign-in-screen`, async (_request, reply) => {
        guard();
        return screen(reply);
      });
      app.post(`${route}/resume`, async (request) => {
        guard();
        return resume(request.body);
      });
    }
  }
  return { registerRoutes };
}
