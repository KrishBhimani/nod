import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BrowserActionError } from '../src/ports/computer.ts';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import {
  DaemonCommandError,
  existingDaemonCommand,
} from '../src/providers/agent-browser/screens.ts';
import type { ProcessOptions } from '../src/providers/process.ts';

type Options = Parameters<typeof createAgentBrowserComputer>[0] & {
  onDaemonCommand?(command: Record<string, unknown>): void;
};

export function createBrowserFixture(options: Options, preferRealSocket = false) {
  const { onDaemonCommand, ...computerOptions } = options;
  const run = options.run;
  if (!run) throw new Error('A synthetic browser process is required.');
  const sessions = new Map<
    string,
    { executable: string; args: string[]; options?: ProcessOptions }
  >();
  const socketDir = resolve(options.dataRoot, 'fixture-sockets');
  return createAgentBrowserComputer({
    ...computerOptions,
    run: async (executable, args, input) => {
      const session = args[args.indexOf('--session') + 1];
      if (args.includes('info')) {
        if (preferRealSocket || !sessions.has(session)) {
          const result = await run(executable, args, input);
          if (!sessions.has(session)) return result;
          const response = JSON.parse(result.stdout);
          const info = response.data;
          if (
            info?.active &&
            typeof info.socketDir === 'string' &&
            (await stat(resolve(info.socketDir, `${session}.sock`)).catch(() => null))?.isSocket()
          )
            return result;
        }
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            success: true,
            data: {
              active: true,
              namespace: args[args.indexOf('--namespace') + 1],
              session,
              socketDir,
            },
          }),
        };
      }
      const offset = args.indexOf('--idle-timeout') + 2;
      if (offset > 1)
        sessions.set(session, { executable, args: args.slice(0, offset), options: input });
      return run(executable, args, input);
    },
    daemonCommand: async (path, command, signal, timeoutMs) => {
      onDaemonCommand?.(structuredClone(command));
      const session = [...sessions].find(([id]) => path === resolve(socketDir, `${id}.sock`))?.[1];
      if (!session) return existingDaemonCommand(path, command, signal, timeoutMs);
      const args =
        command.action === 'navigate'
          ? ['open', String(command.url)]
          : command.action === 'url'
            ? ['get', 'url']
            : command.action === 'getattribute'
              ? ['get', 'attr', String(command.selector), String(command.attribute)]
              : command.action === 'evaluate'
                ? ['eval', '--stdin']
                : command.action === 'snapshot'
                  ? [
                      'snapshot',
                      ...(command.compact === true ? ['-c'] : []),
                      ...(command.interactive === true ? ['-i'] : []),
                    ]
                  : command.action === 'screenshot'
                    ? ['screenshot', String(command.path)]
                    : command.action === 'click'
                      ? ['click', String(command.selector)]
                      : command.action === 'fill'
                        ? ['fill', String(command.selector), String(command.value)]
                        : command.action === 'scroll'
                          ? ['scroll', String(command.direction), String(command.amount)]
                          : command.action === 'close'
                            ? ['close']
                            : null;
      if (!args) throw new Error('Unsupported synthetic browser action.');
      const result = await run(session.executable, [...session.args, ...args], {
        ...session.options,
        signal,
        ...(command.action === 'evaluate' && { input: String(command.script) }),
      });
      const response = JSON.parse(result.stdout);
      if (result.exitCode || response.success === false) {
        if (
          command.action === 'navigate' &&
          /^Navigation failed: net::ERR_[A-Z_]+/.test(String(response.error))
        )
          throw new BrowserActionError('browser_navigation_failed');
        throw new DaemonCommandError();
      }
      return response.data ?? {};
    },
  });
}
