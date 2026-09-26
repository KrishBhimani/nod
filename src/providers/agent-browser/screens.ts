import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { z } from 'zod';
import { taskId } from '../../ports/task-identity.ts';
import { BrowserActionError } from '../../ports/computer.ts';

const storedScreen = z.object({
  version: z.literal(1),
  url: z.string().max(8192),
  sensitive: z.boolean(),
  active: z.boolean(),
  navigationFailed: z.boolean().optional(),
  signInPending: z.boolean().optional(),
  restoreSession: z.boolean().optional(),
  resumeUrl: z.string().max(8192).optional(),
  capturedAt: z.iso.datetime().optional(),
});
export type StoredScreen = z.infer<typeof storedScreen>;

export function createScreenStore(root: string) {
  const path = (id: string) => resolve(root, `screen-${taskId(id)}.png`);
  const metadata = (id: string) => resolve(root, `screen-${taskId(id)}.json`);
  return {
    path,
    async load(id: string): Promise<StoredScreen | null> {
      try {
        if ((await stat(metadata(id))).size > 16_384) return null;
        return storedScreen.parse(JSON.parse(await readFile(metadata(id), 'utf8')));
      } catch {
        return null;
      }
    },
    async save(id: string, value: StoredScreen) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = metadata(id) + '.' + randomUUID();
      await writeFile(temporary, JSON.stringify(storedScreen.parse(value)), { mode: 0o600 });
      await rename(temporary, metadata(id));
    },
    async read(id: string): Promise<Buffer | null> {
      try {
        const info = await stat(path(id));
        if (!info.size || info.size > 12 * 1024 * 1024) return null;
        return await readFile(path(id));
      } catch {
        return null;
      }
    },
    async accept(id: string, temporary: string): Promise<Buffer> {
      await chmod(temporary, 0o600);
      const info = await stat(temporary);
      if (!info.size || info.size > 12 * 1024 * 1024)
        throw new Error('Browser screenshot is too large.');
      const buffer = await readFile(temporary);
      await rename(temporary, path(id));
      return buffer;
    },
  };
}

export class DaemonCommandError extends Error {
  constructor() {
    super('Browser action could not complete. Observe the page again before retrying.');
  }
}

export function existingDaemonCommand(
  path: string,
  command: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = 45_000,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.setEncoding('utf8');
    let received = '';
    let settled = false;
    let deadline: ReturnType<typeof setTimeout>;
    const stop = (error?: Error, data?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(data ?? {});
    };
    const abort = () => stop(new Error('Browser observation cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    deadline = setTimeout(() => stop(new Error('The previous browser is unavailable.')), timeoutMs);
    socket.once('error', () => stop(new Error('The previous browser is unavailable.')));
    socket.once('end', () => stop(new Error('The previous browser is unavailable.')));
    socket.once('connect', () =>
      socket.write(JSON.stringify({ id: randomUUID(), ...command }) + '\n'),
    );
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (Buffer.byteLength(received) > 256 * 1024)
        return stop(new Error('Browser observation exceeded its limit.'));
      const end = received.indexOf('\n');
      if (end < 0) return;
      try {
        const response = JSON.parse(received.slice(0, end));
        if (response.success === false) {
          if (
            command.action === 'navigate' &&
            typeof response.error === 'string' &&
            /^Navigation failed: net::ERR_[A-Z_]+/.test(response.error)
          )
            return stop(new BrowserActionError('browser_navigation_failed'));
          return stop(new DaemonCommandError());
        }
        if (response.success !== true) throw new Error();
        stop(undefined, response.data ?? {});
      } catch {
        stop(new Error('The previous browser is unavailable.'));
      }
    });
  });
}
