import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ManualBrowserInput } from '../../ports/computer.ts';
import { manualInputSchema } from './manual.ts';

export interface SignInDesktop {
  readonly environment: NodeJS.ProcessEnv;
  readonly exited: Promise<void>;
  screenshot(signal?: AbortSignal): Promise<Buffer>;
  control(input: ManualBrowserInput, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

type Launch = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export function createSignInDesktop(
  options: { spawn?: Launch; startupMs?: number; timeoutMs?: number; closeMs?: number } = {},
) {
  const launch = options.spawn ?? spawn;
  return async function start(directory: string): Promise<SignInDesktop> {
    const root = await mkdtemp(join(directory, '.sign-in-'));
    await chmod(root, 0o700);
    const authority = join(root, 'Xauthority');
    await writeFile(authority, '', { mode: 0o600 });
    const display = `:${randomInt(100, 30_000)}`;
    const environment = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      DISPLAY: display,
      XAUTHORITY: authority,
    };
    let server: ChildProcess | undefined;
    let closed = false;
    let closing = false;
    let wheelX = 0;
    let wheelY = 0;
    let closePending: Promise<void> | undefined;
    let finish!: () => void;
    const exited = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const operations = new Set<Promise<Buffer>>();
    const children = new Set<ChildProcess>();

    async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error('The sign-in display could not close. Try again.')),
              milliseconds,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }

    function execute(command: string, args: string[], input = '', signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (closing || closed) return Promise.reject(new Error('The sign-in display is closed.'));
      const operation = new Promise<Buffer>((resolve, reject) => {
        let child: ChildProcess;
        try {
          child = launch(command, args, {
            env: environment,
            stdio: ['pipe', 'pipe', 'ignore'],
            shell: false,
          });
        } catch {
          reject(new Error('The sign-in display operation failed.'));
          return;
        }
        children.add(child);
        const chunks: Buffer[] = [];
        let length = 0;
        let failed = false;
        const stop = () => {
          failed = true;
          child.kill('SIGKILL');
        };
        const timeout = setTimeout(stop, options.timeoutMs ?? 10_000);
        signal?.addEventListener('abort', stop, { once: true });
        child.stdout?.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 12 * 1024 * 1024) stop();
          else chunks.push(chunk);
        });
        child.on('error', stop);
        child.once('close', (code) => {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', stop);
          children.delete(child);
          if (failed || signal?.aborted || closing || closed || code !== 0)
            reject(new Error('The sign-in display operation failed.'));
          else resolve(Buffer.concat(chunks));
        });
        child.stdin?.on('error', stop);
        child.stdin?.end(input);
      });
      operations.add(operation);
      void operation.then(
        () => operations.delete(operation),
        () => operations.delete(operation),
      );
      return operation;
    }

    const handle: SignInDesktop = {
      environment,
      exited,
      async screenshot(signal) {
        const image = await execute(
          '/usr/bin/ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-f',
            'x11grab',
            '-video_size',
            '1280x800',
            '-draw_mouse',
            '1',
            '-i',
            `${display}.0+0,0`,
            '-frames:v',
            '1',
            '-f',
            'image2pipe',
            '-vcodec',
            'png',
            '-threads',
            '1',
            'pipe:1',
          ],
          '',
          signal,
        );
        if (
          image.length < 24 ||
          !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          image.readUInt32BE(16) !== 1280 ||
          image.readUInt32BE(20) !== 800
        )
          throw new Error('The sign-in screen is unavailable.');
        return image;
      },
      async control(raw, signal) {
        const input = manualInputSchema.parse(raw);
        if (signal?.aborted) wheelX = wheelY = 0;
        signal?.throwIfAborted();
        if (closing || closed) throw new Error('The sign-in display is closed.');
        if (input.action !== 'wheel') wheelX = wheelY = 0;
        let args: string[];
        let text = '';
        if (input.action === 'click')
          args = [
            'mousemove',
            '--sync',
            String(Math.min(1279, Math.round(input.x * 1280))),
            String(Math.min(799, Math.round(input.y * 800))),
            'click',
            '1',
          ];
        else if (input.action === 'type') {
          if (input.text.includes('\0')) throw new Error('The sign-in input is invalid.');
          args = ['type', '--clearmodifiers', '--delay', '0', '--file', '-'];
          text = input.text;
        } else if (input.action === 'scroll')
          args = ['click', '--repeat', '3', '--delay', '60', input.direction === 'up' ? '4' : '5'];
        else if (input.action === 'wheel') {
          args = [];
          wheelX += input.deltaX;
          wheelY += input.deltaY;
          const horizontal = Math.trunc(wheelX / 80);
          const vertical = Math.trunc(wheelY / 80);
          wheelX -= horizontal * 80;
          wheelY -= vertical * 80;
          for (const [steps, negative, positive] of [
            [vertical, '4', '5'],
            [horizontal, '6', '7'],
          ] as const) {
            if (steps)
              args.push(
                'click',
                '--repeat',
                String(Math.abs(steps)),
                '--delay',
                '0',
                steps < 0 ? negative : positive,
              );
          }
          if (!args.length) return;
        } else {
          const keys: Record<string, string> = {
            Enter: 'Return',
            Tab: 'Tab',
            'Shift+Tab': 'shift+Tab',
            Escape: 'Escape',
            Backspace: 'BackSpace',
            ArrowUp: 'Up',
            ArrowDown: 'Down',
            ArrowLeft: 'Left',
            ArrowRight: 'Right',
            Delete: 'Delete',
            Home: 'Home',
            End: 'End',
            PageUp: 'Prior',
            PageDown: 'Next',
            Space: 'space',
            'ControlOrMeta+A': 'ctrl+a',
          };
          const modifiers = (input.modifiers ?? []).map(
            (value) => ({ Control: 'ctrl', Alt: 'alt', Shift: 'shift' })[value],
          );
          args = [
            'key',
            '--clearmodifiers',
            [...modifiers, keys[input.key] ?? input.key].join('+'),
          ];
        }
        try {
          const pending = execute('/usr/bin/xdotool', args, text, signal);
          text = '';
          await pending;
        } catch (error) {
          wheelX = wheelY = 0;
          throw error;
        }
      },
      close() {
        closePending ??= (async () => {
          closing = true;
          wheelX = wheelY = 0;
          for (const child of children) child.kill('SIGKILL');
          await bounded(Promise.allSettled([...operations]), options.closeMs ?? 1500);
          if (server && !closed) {
            server.kill('SIGTERM');
            let timeout: ReturnType<typeof setTimeout> | undefined;
            const stopped = await Promise.race([
              exited.then(() => true),
              new Promise<false>((resolve) => {
                timeout = setTimeout(() => resolve(false), options.closeMs ?? 1500);
              }),
            ]);
            clearTimeout(timeout);
            if (!stopped) {
              server.kill('SIGKILL');
              await bounded(exited, options.closeMs ?? 1500);
            }
          } else finish();
          closed = true;
          await rm(root, { recursive: true, force: true });
        })().finally(() => {
          closePending = undefined;
        });
        return closePending;
      },
    };
    try {
      let cookie = randomBytes(16).toString('hex');
      const authorizing = execute(
        '/usr/bin/xauth',
        ['-f', authority],
        `add ${display} . ${cookie}\n`,
      );
      cookie = '';
      await authorizing;
      server = launch(
        '/usr/bin/Xvfb',
        [
          display,
          '-screen',
          '0',
          '1280x800x24',
          '-nolisten',
          'tcp',
          '-auth',
          authority,
          '-noreset',
        ],
        { env: environment, stdio: 'ignore', shell: false },
      );
      server.once('close', () => {
        closed = true;
        finish();
      });
      server.on('error', () => {
        closed = true;
        finish();
      });
      const deadline = Date.now() + (options.startupMs ?? 4000);
      while (!closed) {
        try {
          const size = await execute('/usr/bin/xdotool', ['getdisplaygeometry']);
          if (size.toString('utf8').trim() !== '1280 800') throw new Error();
          return handle;
        } catch {
          if (closed || Date.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
      throw new Error();
    } catch {
      await handle.close();
      throw new Error('The sign-in display could not start. Try again.');
    }
  };
}
