import { Sandbox } from 'e2b';

export interface E2BCommand {
  sendStdin(data: Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  wait(): Promise<{ exitCode: number }>;
  disconnect(): Promise<void>;
}

export interface E2BSandbox {
  id: string;
  start(input: {
    command: string;
    stdout(data: string): void;
    stderr(data: string): void;
  }): Promise<E2BCommand>;
  keepAlive(): Promise<void>;
  pause(): Promise<boolean>;
}

export interface E2BClient {
  create(templateId: string, metadata: Record<string, string>): Promise<E2BSandbox>;
  connect(resourceId: string): Promise<E2BSandbox>;
}

export function createE2BClient(options: {
  apiKey: string;
  sandboxTimeoutMs?: number;
  requestTimeoutMs?: number;
}): E2BClient {
  if (!options.apiKey.trim()) throw new Error('An E2B API key is required.');
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const timeoutMs = options.sandboxTimeoutMs ?? 30 * 60_000;
  const connection = { apiKey: options.apiKey, requestTimeoutMs };
  function wrap(sandbox: Sandbox): E2BSandbox {
    return {
      id: sandbox.sandboxId,
      async start(input) {
        const handle = await sandbox.commands.run(input.command, {
          background: true,
          stdin: true,
          user: 'node',
          envs: {},
          timeoutMs: 180_000,
          requestTimeoutMs,
          onStdout: input.stdout,
          onStderr: input.stderr,
        });
        return {
          sendStdin: (data) => handle.sendStdin(data, { requestTimeoutMs }),
          closeStdin: () => handle.closeStdin({ requestTimeoutMs }),
          wait: () => handle.wait(),
          disconnect: () => handle.disconnect(),
        };
      },
      keepAlive: () => sandbox.setTimeout(timeoutMs, { requestTimeoutMs }),
      pause: () => sandbox.pause({ requestTimeoutMs }),
    };
  }
  return {
    create: async (templateId, metadata) =>
      wrap(
        await Sandbox.create(templateId, {
          ...connection,
          timeoutMs,
          metadata,
          lifecycle: { onTimeout: 'pause', autoResume: false },
          envs: {},
          network: { allowPublicTraffic: false },
        }),
      ),
    connect: async (resourceId) =>
      wrap(await Sandbox.connect(resourceId, { ...connection, timeoutMs, onResume: 'restore' })),
  };
}
