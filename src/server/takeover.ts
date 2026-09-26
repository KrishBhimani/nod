import type { FastifyInstance } from 'fastify';
import { createHash, randomInt } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Computer } from '../ports/computer.ts';
import { browserInputSchema as inputSchema } from '../shared/browser-input.ts';

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
  const workspaceId = `manual-${createHash('sha256').update(dependencies.ownerId).digest('hex').slice(0, 32)}`;
  let controlRevision = randomInt(1, 2 ** 48);
  const queues = new Map<string, Promise<unknown>>();
  const leases = new Map<
    string,
    {
      revision: number;
      until: number;
      mode: 'manual' | 'sign_in';
      taskRevision?: number;
      terminalStatus?: string;
    }
  >();
  const terminalStatuses = ['succeeded', 'failed', 'cancelled'];
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
      if (taskId === workspaceId || lease.terminalStatus) await dependencies.computer.close(taskId);
    } catch {
      throw unavailable();
    }
    if (leases.get(taskId) === lease) leases.delete(taskId);
  }
  async function state(taskId: string, acquiring = false) {
    if (taskId === workspaceId) {
      const lease = leases.get(taskId);
      const active = Boolean(lease && lease.until > Date.now());
      if (!active) await releaseLease(taskId);
      return {
        paused: active,
        active,
        revision: active ? lease!.revision : null,
        mode: active ? lease!.mode : null,
        signInAvailable: signInAvailable(),
        resumable: false,
      };
    }
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
      !terminalStatuses.includes(row.status) &&
      !(row.status === 'waiting_user' && ['manual_control', 'browser'].includes(row.waiting_reason))
    ) {
      await releaseLease(taskId);
      throw Object.assign(
        new Error(
          'Finish the pending request in chat or Vault before taking control of this browser.',
        ),
        { statusCode: 409 },
      );
    }
    const paused = row.status === 'waiting_user' && row.waiting_reason === 'manual_control';
    const lease = leases.get(taskId);
    const active =
      lease &&
      lease.until > Date.now() &&
      (lease.terminalStatus
        ? lease.terminalStatus === row.status && lease.taskRevision === row.revision
        : paused && lease.revision === row.revision);
    if (!active) await releaseLease(taskId);
    return {
      paused,
      active: Boolean(active),
      revision: active ? lease.revision : paused ? (row.revision as number) : null,
      mode: active ? lease.mode : null,
      signInAvailable: signInAvailable(),
      resumable: !terminalStatuses.includes(row.status),
    };
  }
  async function current(taskId: string, revision: number, requireLease = false) {
    const result = await state(taskId);
    if (
      (!result.paused && !result.active) ||
      result.revision !== revision ||
      (requireLease && !result.active)
    )
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
        const { taskId } = z
          .object({ taskId: z.union([z.uuid(), z.literal('workspace')]) })
          .parse(params);
        return taskId === 'workspace' ? workspaceId : taskId;
      };
      app.get(route, async (request) => {
        const taskId = identify(request.params);
        return serialize(taskId, () => state(taskId));
      });
      function acquire(requestedMode: 'manual' | 'sign_in' | 'auto') {
        return async (request: { params: unknown; body: unknown }) => {
          const taskId = identify(request.params);
          z.object({}).strict().parse(request.body);
          const mode =
            requestedMode === 'auto' ? (signInAvailable() ? 'sign_in' : 'manual') : requestedMode;
          return serialize(taskId, async () => {
            const open =
              mode === 'sign_in'
                ? dependencies.computer.openSignIn
                : dependencies.computer.takeControl;
            if (
              !open ||
              (mode === 'manual' && !dependencies.computer.control) ||
              (mode === 'sign_in' && !signInAvailable()) ||
              !dependencies.computer.releaseControl ||
              (taskId === workspaceId && mode !== 'sign_in')
            )
              throw unavailable();
            await state(taskId, true);
            const terminal =
              taskId === workspaceId
                ? undefined
                : (
                    await dependencies.pool.query(
                      'SELECT status,revision FROM tasks WHERE id=$1 AND owner_id=$2',
                      [taskId, dependencies.ownerId],
                    )
                  ).rows.find((row) => terminalStatuses.includes(row.status));
            const { revision } =
              taskId === workspaceId || terminal
                ? { revision: ++controlRevision }
                : await dependencies.pause(taskId);
            await releaseLease(taskId);
            if (taskId === workspaceId) {
              try {
                await dependencies.computer.close(taskId);
              } catch {
                throw unavailable();
              }
            }
            const verify = async () => {
              if (taskId === workspaceId) return;
              if (!terminal) return current(taskId, revision);
              const result = await dependencies.pool.query(
                'SELECT status,revision FROM tasks WHERE id=$1 AND owner_id=$2',
                [taskId, dependencies.ownerId],
              );
              if (
                result.rows[0]?.status !== terminal.status ||
                result.rows[0]?.revision !== terminal.revision
              )
                throw stale();
            };
            if (taskId !== workspaceId) await drain(taskId);
            await verify();
            try {
              await open.call(dependencies.computer, taskId);
              await verify();
              leases.set(taskId, {
                revision,
                until: Date.now() + leaseDuration,
                mode,
                ...(terminal
                  ? { taskRevision: terminal.revision, terminalStatus: terminal.status }
                  : {}),
              });
              return { revision, mode, resumable: taskId !== workspaceId && !terminal };
            } catch {
              await dependencies.computer.releaseControl(taskId).catch(() => {});
              if (taskId === workspaceId || terminal)
                await dependencies.computer.close(taskId).catch(() => {});
              throw unavailable();
            }
          });
        };
      }
      app.post(`${route}/start`, acquire('auto'));
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
          const control = await current(taskId, revision);
          if (!dependencies.computer.releaseControl) throw unavailable();
          if (taskId === workspaceId) {
            await releaseLease(taskId);
            return { ok: true };
          }
          try {
            await dependencies.computer.finishSignIn?.(taskId);
            try {
              await current(taskId, revision);
            } catch (error) {
              await dependencies.computer.close(taskId);
              throw error;
            }
            await dependencies.computer.releaseControl(taskId);
            if (!control.resumable) await current(taskId, revision, true);
          } catch {
            throw unavailable();
          }
          leases.delete(taskId);
          if (!control.resumable) return { ok: true };
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
