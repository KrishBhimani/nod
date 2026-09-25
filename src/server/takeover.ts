import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Computer } from '../ports/computer.ts';

const inputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('click'),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .strict(),
  z.object({ action: z.literal('type'), text: z.string().min(1).max(8192) }).strict(),
  z
    .object({
      action: z.literal('press'),
      key: z.enum([
        'Enter',
        'Tab',
        'Shift+Tab',
        'Escape',
        'Backspace',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'ControlOrMeta+A',
      ]),
    })
    .strict(),
  z.object({ action: z.literal('scroll'), direction: z.enum(['up', 'down']) }).strict(),
]);
const revisionSchema = z.number().int().nonnegative();
const leaseDuration = 30 * 60_000;

export function createTakeover(dependencies: {
  pool: Pick<Pool, 'query'>;
  ownerId: string;
  computer: Pick<
    Computer,
    | 'takeControl'
    | 'control'
    | 'releaseControl'
    | 'close'
    | 'openSignIn'
    | 'finishSignIn'
    | 'signInScreenshot'
    | 'signInControl'
  >;
  enabled(): boolean;
  pause(taskId: string): Promise<{ revision: number }>;
  resume(taskId: string, revision: number): Promise<{ ok: boolean }>;
  waitForTask(taskId: string): Promise<void>;
}) {
  const queues = new Map<string, Promise<unknown>>();
  const leases = new Map<string, { revision: number; until: number; mode: 'manual' | 'sign_in' }>();
  const signInAvailable = () =>
    Boolean(
      dependencies.computer.openSignIn &&
      dependencies.computer.finishSignIn &&
      dependencies.computer.signInScreenshot &&
      dependencies.computer.signInControl &&
      dependencies.computer.releaseControl,
    );
  const unavailable = () =>
    Object.assign(new Error('Browser control is not available. Try taking control again.'), {
      statusCode: 409,
    });
  const stale = () =>
    Object.assign(new Error('This browser control session is no longer active.'), {
      statusCode: 409,
    });
  function serialize<T>(taskId: string, operation: () => Promise<T>) {
    const next = (queues.get(taskId) ?? Promise.resolve()).catch(() => {}).then(operation);
    queues.set(taskId, next);
    void next
      .finally(() => {
        if (queues.get(taskId) === next) queues.delete(taskId);
      })
      .catch(() => {});
    return next;
  }
  async function releaseLease(taskId: string) {
    const lease = leases.get(taskId);
    if (!lease) return;
    if (!dependencies.computer.releaseControl) throw unavailable();
    try {
      await dependencies.computer.releaseControl(taskId);
    } catch {
      throw unavailable();
    }
    if (leases.get(taskId) === lease) leases.delete(taskId);
  }
  async function state(taskId: string, acquiring = false) {
    const result = await dependencies.pool.query(
      'SELECT status,revision,waiting_reason FROM tasks WHERE id=$1 AND owner_id=$2',
      [taskId, dependencies.ownerId],
    );
    if (!result.rows[0]) {
      await releaseLease(taskId);
      throw Object.assign(new Error('Task not found.'), { statusCode: 404 });
    }
    const row = result.rows[0];
    if (
      acquiring &&
      !['running', 'queued'].includes(row.status) &&
      !(row.status === 'waiting_user' && ['manual_control', 'browser'].includes(row.waiting_reason))
    )
      throw stale();
    const paused = row.status === 'waiting_user' && row.waiting_reason === 'manual_control';
    const lease = leases.get(taskId);
    const active = paused && lease && lease.revision === row.revision && lease.until > Date.now();
    if (!active) await releaseLease(taskId);
    return {
      paused,
      active: Boolean(active),
      revision: paused ? (row.revision as number) : null,
      mode: active ? lease.mode : null,
      signInAvailable: signInAvailable(),
    };
  }
  async function current(taskId: string, revision: number, requireLease = false) {
    const result = await state(taskId);
    if (!result.paused || result.revision !== revision || (requireLease && !result.active))
      throw stale();
    return result;
  }
  async function drain(taskId: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        dependencies.waitForTask(taskId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(unavailable()), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function registerRoutes(app: FastifyInstance) {
    for (const route of ['/api/browser/control/:taskId', '/api/inspector/control/:taskId']) {
      const identify = (params: unknown) => {
        if (route.startsWith('/api/inspector/') && !dependencies.enabled())
          throw Object.assign(new Error('Inspector is disabled.'), { statusCode: 404 });
        return z.object({ taskId: z.uuid() }).parse(params).taskId;
      };
      app.get(route, async (request) => {
        const taskId = identify(request.params);
        return serialize(taskId, () => state(taskId));
      });
      function acquire(mode: 'manual' | 'sign_in') {
        return async (request: { params: unknown; body: unknown }) => {
          const taskId = identify(request.params);
          if (mode === 'sign_in') z.object({}).strict().parse(request.body);
          return serialize(taskId, async () => {
            const open =
              mode === 'sign_in'
                ? dependencies.computer.openSignIn
                : dependencies.computer.takeControl;
            if (
              !open ||
              (mode === 'manual' && !dependencies.computer.control) ||
              (mode === 'sign_in' && !signInAvailable()) ||
              !dependencies.computer.releaseControl
            )
              throw unavailable();
            await state(taskId, true);
            const { revision } = await dependencies.pause(taskId);
            await releaseLease(taskId);
            await drain(taskId);
            await current(taskId, revision);
            try {
              await open.call(dependencies.computer, taskId);
              await current(taskId, revision);
              leases.set(taskId, { revision, until: Date.now() + leaseDuration, mode });
              return { revision };
            } catch {
              await dependencies.computer.releaseControl(taskId).catch(() => {});
              throw unavailable();
            }
          });
        };
      }
      app.post(`${route}/start`, acquire('manual'));
      app.post(`${route}/sign-in`, acquire('sign_in'));
      app.post(`${route}/input`, async (request) => {
        const taskId = identify(request.params);
        const { revision, input } = z
          .object({ revision: revisionSchema, input: inputSchema })
          .strict()
          .parse(request.body);
        return serialize(taskId, async () => {
          const lease = await current(taskId, revision, true);
          const control =
            lease.mode === 'sign_in'
              ? dependencies.computer.signInControl
              : dependencies.computer.control;
          if (!control) throw unavailable();
          try {
            await control.call(dependencies.computer, taskId, input);
            await current(taskId, revision, true);
            return { ok: true };
          } catch {
            await releaseLease(taskId).catch(() => {});
            throw unavailable();
          }
        });
      });
      app.get(`${route}/sign-in-screen`, async (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        const taskId = identify(request.params);
        const { revision } = z
          .object({ revision: z.coerce.number().int().nonnegative() })
          .strict()
          .parse(request.query);
        const controller = new AbortController();
        const abort = () => {
          if (!reply.raw.writableEnded) controller.abort();
        };
        reply.raw.on('close', abort);
        try {
          const screen = await serialize(taskId, async () => {
            if (controller.signal.aborted) throw stale();
            const lease = await current(taskId, revision, true);
            if (lease.mode !== 'sign_in') throw stale();
            if (!dependencies.computer.signInScreenshot) throw unavailable();
            let frame: Buffer | null;
            try {
              frame = await dependencies.computer.signInScreenshot(taskId, controller.signal);
            } catch {
              throw unavailable();
            }
            const latest = await current(taskId, revision, true);
            if (controller.signal.aborted || latest.mode !== 'sign_in') throw stale();
            if (!frame?.length) throw unavailable();
            return frame;
          });
          return reply.type('image/png').header('X-Screen-State', 'live').send(screen);
        } finally {
          reply.raw.removeListener('close', abort);
        }
      });
      app.post(`${route}/resume`, async (request) => {
        const taskId = identify(request.params);
        const { revision } = z.object({ revision: revisionSchema }).strict().parse(request.body);
        return serialize(taskId, async () => {
          await current(taskId, revision);
          if (!dependencies.computer.releaseControl) throw unavailable();
          try {
            await dependencies.computer.finishSignIn?.(taskId);
            try {
              await current(taskId, revision);
            } catch (error) {
              await dependencies.computer.close(taskId);
              throw error;
            }
            await dependencies.computer.releaseControl(taskId);
          } catch {
            throw unavailable();
          }
          leases.delete(taskId);
          try {
            await current(taskId, revision);
          } catch (error) {
            await dependencies.computer.close(taskId);
            throw error;
          }
          return dependencies.resume(taskId, revision);
        });
      });
    }
  }
  return { registerRoutes };
}
