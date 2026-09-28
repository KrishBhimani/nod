import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { RuntimeTransport } from '../../ports/runtime-transport.ts';

const savedState = z
  .object({ generation: z.string().regex(/^[1-9]\d*$/), stopped: z.boolean() })
  .strict();
type ProcessEntry = {
  child: ChildProcess;
  generation: string;
  port: number | null;
  exited: Promise<void>;
};

export function createLocalRuntimeTransport(options: {
  root: string;
  entrypoint: string;
  cwd: string;
}): RuntimeTransport {
  const processes = new Map<string, ProcessEntry>();
  const root = resolve(options.root);
  const directory = (owner: string) => join(root, z.uuid().parse(owner).toLowerCase());
  async function save(owner: string, generation: string, stopped: boolean) {
    const dir = directory(owner);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, 'runtime-state.tmp');
    await writeFile(temporary, JSON.stringify({ generation, stopped }), { mode: 0o600 });
    await rename(temporary, join(dir, 'runtime-state.json'));
  }
  async function status(owner: string) {
    try {
      return savedState.parse(
        JSON.parse(await readFile(join(directory(owner), 'runtime-state.json'), 'utf8')),
      );
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return { generation: null, stopped: true };
      throw new Error('The local account runtime needs operator recovery.');
    }
  }
  async function stop(ownerId: string, generation: string) {
    const previous = await status(ownerId);
    if (previous.generation !== generation)
      throw new Error('The account runtime generation changed.');
    if (previous.stopped) return;
    const entry = processes.get(ownerId);
    if (!entry || entry.generation !== generation)
      throw new Error('The local account runtime needs operator recovery.');
    entry.child.kill('SIGTERM');
    const timeout = setTimeout(() => entry.child.kill('SIGKILL'), 30_000);
    try {
      await entry.exited;
      await save(ownerId, generation, true);
    } finally {
      clearTimeout(timeout);
      processes.delete(ownerId);
    }
  }
  return {
    status,
    async start({ ownerId, generation, environment }) {
      const previous = await status(ownerId);
      if (
        !previous.stopped ||
        (previous.generation && BigInt(previous.generation) >= BigInt(generation))
      )
        throw new Error('The account runtime is already reserved.');
      const data = join(directory(ownerId), 'data');
      await mkdir(data, { recursive: true, mode: 0o700 });
      await save(ownerId, generation, false);
      const child = fork(resolve(options.entrypoint), [], {
        cwd: resolve(options.cwd),
        execPath: process.execPath,
        execArgv: ['--import', 'tsx'],
        env: {
          PATH: process.env.PATH,
          HOME: directory(ownerId),
          ...environment,
          PORT: '0',
          OTTO_DATA_ROOT: data,
          OTTO_BIND_HOST: '127.0.0.1',
          OBJECT_STORAGE_PROVIDER: 'postgres',
          DOTENV_CONFIG_PATH: join(data, 'unused.env'),
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      let finish!: () => void;
      const exited = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const entry: ProcessEntry = { child, generation, port: null, exited };
      processes.set(ownerId, entry);
      child.once('exit', () => {
        finish();
      });
      child.once('error', () => {
        finish();
      });
      try {
        await new Promise<void>((ready, reject) => {
          const timer = setTimeout(
            () => reject(new Error('The account runtime startup timed out.')),
            45_000,
          );
          const end = () => {
            clearTimeout(timer);
            reject(new Error('The account runtime could not start.'));
          };
          child.once('exit', end);
          child.once('error', end);
          child.on('message', (message) => {
            const parsed = z
              .object({
                type: z.literal('otto-ready'),
                port: z.number().int().min(1).max(65535),
                ownerId: z.literal(ownerId),
                generation: z.literal(generation),
              })
              .safeParse(message);
            if (!parsed.success) return;
            entry.port = parsed.data.port;
            clearTimeout(timer);
            child.off('exit', end);
            child.off('error', end);
            ready();
          });
        });
      } catch {
        await stop(ownerId, generation);
        throw new Error('The account runtime could not start.');
      }
    },
    stop,
    async fetch(ownerId, input) {
      const entry = processes.get(ownerId);
      if (!entry?.port || entry.child.exitCode !== null)
        throw new Error('The account runtime is unavailable.');
      const url = new URL(input.url);
      return fetch(
        new Request(`http://127.0.0.1:${entry.port}${url.pathname}${url.search}`, input),
        { redirect: 'manual' },
      );
    },
    async close() {
      const results = await Promise.allSettled(
        [...processes].map(([owner, entry]) => stop(owner, entry.generation)),
      );
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Some local account runtimes could not stop.');
    },
  };
}
