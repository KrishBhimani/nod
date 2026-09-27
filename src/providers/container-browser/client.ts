import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BrowserActionError, type Computer } from '../../ports/computer.ts';
import { taskId } from '../../ports/task-identity.ts';
import type { CommandProcess } from '../command-process.ts';
import { loginInspectionSchema } from '../agent-browser/login.ts';
import {
  browserRequest,
  browserResponse,
  imageBytes,
  requestBytes,
  responseBytes,
  type BrowserCall,
  type BrowserMetadata,
  type BrowserResponse,
} from './protocol.ts';

export function createBridgeComputer(options: {
  namespace: string;
  launch(input: BrowserCall): CommandProcess;
  available?(input: BrowserCall): boolean;
  timeoutMs?: number;
  drainTimeoutMs?: number;
}): Computer & { quiesce(): Promise<boolean> } {
  let disposed = false;
  let uncertain = false;
  let sequence = 0;
  let activitySequence = 0;
  let statusSequence = 0;
  let currentSession: ReturnType<NonNullable<Computer['currentSession']>>;
  let status = 'Workspace browser is ready.';
  const screens = new Map<
    string,
    { sequence: number; value: ReturnType<NonNullable<Computer['screenStatus']>> }
  >();
  const pending = new Set<Promise<unknown>>();
  const cancellations = new Set<() => void>();
  let disposing: Promise<void> | undefined;

  function updateMetadata(value: BrowserMetadata, order: number, input: BrowserCall) {
    if (
      (input.method === 'act' ||
        (input.method === 'close' && input.taskId === currentSession?.taskId)) &&
      order >= activitySequence
    ) {
      activitySequence = order;
      currentSession = value.currentSession ?? undefined;
    } else if (!activitySequence && value.currentSession) {
      currentSession = value.currentSession;
    }
    if (order >= statusSequence) {
      statusSequence = order;
      status = value.status;
    }
    if (value.screen && order >= (screens.get(value.screen.taskId)?.sequence ?? 0)) {
      const { taskId: id, ...screen } = value.screen;
      screens.set(id, { sequence: order, value: screen });
      if (screens.size > 256) screens.delete(screens.keys().next().value!);
    }
  }

  function call(input: BrowserCall, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (
      input.method !== 'dispose' &&
      (disposed || uncertain || options.available?.(input) === false)
    )
      return Promise.reject(
        new Error('The workspace browser is unavailable. Restart Sidekick before continuing.'),
      );
    const request = browserRequest.parse({
      ...input,
      id: randomUUID(),
      namespace: options.namespace,
    });
    const encoded = JSON.stringify({ type: 'request', request }) + '\n';
    if (Buffer.byteLength(encoded) > requestBytes)
      return Promise.reject(new Error('The browser request is too large.'));
    const order = ++sequence;
    const result = new Promise<unknown>((resolve, reject) => {
      let child: CommandProcess;
      try {
        child = options.launch(input);
      } catch {
        uncertain = true;
        return reject(
          new Error('The workspace browser is unavailable. Start its container and try again.'),
        );
      }
      if (input.method === 'act') {
        activitySequence = order;
        currentSession = { taskId: input.taskId, lastActivityAt: new Date().toISOString() };
      }
      let output = '';
      let bytes = 0;
      let response: BrowserResponse | undefined;
      let settled = false;
      let cancelling = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => cancel(), options.timeoutMs ?? 60_000);
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(drainTimer);
        signal?.removeEventListener('abort', cancel);
        cancellations.delete(cancel);
      };
      const unavailable = () => {
        if (settled) return;
        settled = true;
        uncertain = true;
        cleanup();
        child.stdin.destroy();
        child.kill('SIGKILL');
        reject(
          new Error(
            'The workspace browser did not finish safely. Restart Sidekick before continuing.',
          ),
        );
      };
      function cancel() {
        if (settled || cancelling) return;
        cancelling = true;
        clearTimeout(timer);
        if (!response) child.stdin.write(JSON.stringify({ type: 'cancel', id: request.id }) + '\n');
        drainTimer = setTimeout(unavailable, options.drainTimeoutMs ?? 15_000);
      }
      signal?.addEventListener('abort', cancel, { once: true });
      cancellations.add(cancel);
      child.stdin.on('error', unavailable);
      child.on('error', unavailable);
      child.stderr.resume();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > responseBytes || response) return unavailable();
        output += chunk;
        const end = output.indexOf('\n');
        if (end < 0) return;
        try {
          if (output.slice(end + 1)) throw new Error();
          response = browserResponse.parse(JSON.parse(output.slice(0, end)));
          if (response.id !== request.id) throw new Error();
          output = '';
        } catch {
          unavailable();
        }
      });
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0 || !response) return unavailable();
        settled = true;
        cleanup();
        updateMetadata(response.metadata, order, input);
        if (cancelling || (!response.ok && response.error === 'cancelled'))
          return reject(new Error('Browser operation cancelled.'));
        if (response.ok) return resolve(response.result);
        if (response.error === 'navigation')
          return reject(new BrowserActionError('browser_navigation_failed'));
        if (response.error === 'locked') {
          const error = new Error('Browser observations are paused during credential entry.');
          return reject(Object.assign(error, { statusCode: 423 }));
        }
        reject(new Error('The workspace browser could not complete this action. Try again.'));
      });
      child.stdin.write(encoded);
      if (signal?.aborted) cancel();
    });
    pending.add(result);
    void result.finally(() => pending.delete(result)).catch(() => {});
    return result;
  }

  async function image(
    method: 'screenshot' | 'signInScreenshot',
    id: string,
    signal?: AbortSignal,
  ) {
    const value = await call({ method, taskId: taskId(id) }, signal);
    if (value === null) return null;
    if (
      typeof value !== 'string' ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
      value.length > Math.ceil(imageBytes / 3) * 4
    )
      throw new Error('The workspace browser image is unavailable.');
    return Buffer.from(value, 'base64');
  }

  return {
    async quiesce() {
      const result = await call({ method: 'quiesce' });
      if (typeof result !== 'boolean')
        throw new Error('The workspace browser could not pause safely.');
      if (result) {
        currentSession = undefined;
        screens.clear();
      }
      return result;
    },
    currentSession: () => currentSession,
    screenStatus: (id) => screens.get(taskId(id))?.value ?? { state: 'unavailable' },
    status: () => (uncertain ? 'Workspace browser needs a restart.' : status),
    act: async (id, input, signal) =>
      z
        .object({
          text: z.string().max(256 * 1024),
          url: z.string().max(8192),
          candidates: z
            .array(z.object({ id: z.string().max(128), label: z.string().max(350) }).strict())
            .max(100),
        })
        .strict()
        .parse(await call({ method: 'act', taskId: taskId(id), input }, signal)),
    screenshot: (id, signal) => image('screenshot', id, signal),
    signInScreenshot: (id, signal) => image('signInScreenshot', id, signal),
    takeControl: async (id) => {
      await call({ method: 'takeControl', taskId: taskId(id) });
    },
    openSignIn: async (id) => {
      await call({ method: 'openSignIn', taskId: taskId(id) });
    },
    finishSignIn: async (id) => {
      await call({ method: 'finishSignIn', taskId: taskId(id) });
    },
    control: async (id, input) => {
      await call({ method: 'control', taskId: taskId(id), input });
    },
    signInControl: async (id, input) => {
      await call({ method: 'signInControl', taskId: taskId(id), input });
    },
    releaseControl: async (id) => {
      await call({ method: 'releaseControl', taskId: taskId(id) });
    },
    inspectLogin: async (id) =>
      loginInspectionSchema.parse(await call({ method: 'inspectLogin', taskId: taskId(id) })),
    selectLoginMethod: async (id, origin, methodId) => {
      await call({ method: 'selectLoginMethod', taskId: taskId(id), origin, methodId });
    },
    injectCredentials: async (input) => {
      const {
        taskId: id,
        origin,
        kind,
        username,
        password,
        code,
        usernameSelector,
        passwordSelector,
        submitSelector,
      } = input;
      return (
        z
          .object({ status: z.enum(['submitted', 'rejected']) })
          .strict()
          .nullable()
          .parse(
            await call({
              method: 'injectCredentials',
              input: {
                taskId: taskId(id),
                origin,
                kind,
                username,
                password,
                code,
                usernameSelector,
                passwordSelector,
                submitSelector,
              },
            }),
          ) ?? undefined
      );
    },
    hold: async (id, until) => {
      await call({ method: 'hold', taskId: taskId(id), until });
    },
    close: async (id) => {
      await call({ method: 'close', taskId: taskId(id) });
    },
    dispose: () => {
      disposing ??= (async () => {
        disposed = true;
        for (const cancel of cancellations) cancel();
        await Promise.allSettled([...pending]);
        await call({ method: 'dispose' });
        currentSession = undefined;
        screens.clear();
        status = 'Workspace browser is stopped.';
      })().catch((error) => {
        disposing = undefined;
        throw error;
      });
      return disposing;
    },
  };
}
