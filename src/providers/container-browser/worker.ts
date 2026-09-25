import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Computer } from '../../ports/computer.ts';
import { BrowserActionError } from '../../ports/computer.ts';
import { createAgentBrowserComputer } from '../agent-browser/index.ts';
import { containerBrowserOptions } from './config.ts';
import {
  browserFrame,
  browserMetadata,
  browserResponse,
  browserSocketPath,
  imageBytes,
  requestBytes,
  responseBytes,
  type BrowserMetadata,
  type BrowserRequest,
  type BrowserResponse,
} from './protocol.ts';

type Namespace = {
  computer: Promise<Computer>;
  pending: Map<string, { controller: AbortController; done: Promise<unknown> }>;
  closing?: Promise<void>;
};

function metadata(computer?: Computer, request?: BrowserRequest): BrowserMetadata {
  const taskId =
    request &&
    ('taskId' in request
      ? request.taskId
      : request.method === 'injectCredentials'
        ? request.input.taskId
        : undefined);
  try {
    const screen = taskId ? computer?.screenStatus?.(taskId) : undefined;
    return browserMetadata.parse({
      status: computer?.status() ?? 'Workspace browser is unavailable.',
      currentSession: computer?.currentSession?.() ?? null,
      ...(screen && { screen: { taskId, ...screen } }),
    });
  } catch {
    return { status: 'Workspace browser is unavailable.', currentSession: null };
  }
}

async function dispatch(computer: Computer, request: BrowserRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  switch (request.method) {
    case 'act':
      return computer.act(request.taskId, request.input, signal);
    case 'screenshot':
    case 'signInScreenshot': {
      const method =
        request.method === 'screenshot' ? computer.screenshot : computer.signInScreenshot;
      if (!method) throw new Error();
      const image = await method.call(computer, request.taskId, signal);
      if (image && image.length > imageBytes) throw new Error();
      return image?.toString('base64') ?? null;
    }
    case 'takeControl':
    case 'openSignIn':
    case 'finishSignIn':
    case 'releaseControl': {
      const method = computer[request.method];
      if (!method) throw new Error();
      return method.call(computer, request.taskId);
    }
    case 'control':
    case 'signInControl': {
      const method = computer[request.method];
      if (!method) throw new Error();
      return method.call(computer, request.taskId, request.input);
    }
    case 'inspectLogin':
      return computer.inspectLogin(request.taskId);
    case 'selectLoginMethod':
      return computer.selectLoginMethod(request.taskId, request.origin, request.methodId);
    case 'injectCredentials':
      return computer.injectCredentials(request.input);
    case 'hold':
      return computer.hold(request.taskId, request.until);
    case 'close':
      return computer.close(request.taskId);
    case 'status':
      return null;
    case 'dispose':
      throw new Error();
  }
}

async function prepareSocket(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  try {
    if (!(await lstat(path)).isSocket()) throw new Error('Invalid browser socket.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const alive = await new Promise<boolean>((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
  if (alive) throw new Error('The workspace browser is already running.');
  await unlink(path);
}

export async function startContainerBrowserWorker(
  options: {
    socketPath?: string;
    dataRoot?: string;
    createComputer?: (dataRoot: string) => Computer | Promise<Computer>;
    maxNamespaces?: number;
    maxPendingPerNamespace?: number;
  } = {},
) {
  const path = options.socketPath ?? browserSocketPath;
  const dataRoot = options.dataRoot ?? '/data';
  const createComputer =
    options.createComputer ?? ((root) => createAgentBrowserComputer(containerBrowserOptions(root)));
  const namespaces = new Map<string, Namespace>();
  const connections = new Set<Socket>();
  let closing = false;
  function namespace(name: string) {
    if (closing) throw new Error();
    let value = namespaces.get(name);
    if (!value) {
      if (namespaces.size >= (options.maxNamespaces ?? 16)) throw new Error();
      value = {
        computer: Promise.resolve().then(() => createComputer(join(dataRoot, name))),
        pending: new Map(),
      };
      namespaces.set(name, value);
    }
    if (value.closing) throw new Error();
    return value;
  }
  async function dispose(name: string) {
    const entry = namespaces.get(name);
    if (!entry) return;
    entry.closing ??= (async () => {
      for (const pending of entry.pending.values()) pending.controller.abort();
      await Promise.allSettled([...entry.pending.values()].map((pending) => pending.done));
      await (await entry.computer).dispose();
      namespaces.delete(name);
    })();
    await entry.closing;
  }
  await prepareSocket(path);
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    connections.add(socket);
    let incoming = '';
    let received = 0;
    let request: BrowserRequest | undefined;
    const controller = new AbortController();
    let terminal = false;
    const stop = () => {
      controller.abort();
      socket.destroy();
    };
    socket.on('error', stop);
    socket.on('close', () => {
      controller.abort();
      connections.delete(socket);
      if (!terminal && request) void dispose(request.namespace).catch(() => {});
    });
    socket.setTimeout(90_000, stop);
    const execute = async (input: BrowserRequest) => {
      let entry: Namespace | undefined;
      let registered = false;
      let response: BrowserResponse;
      try {
        if (input.method === 'dispose') {
          await dispose(input.namespace);
          response = { id: input.id, ok: true, result: null, metadata: metadata() };
        } else {
          entry = namespace(input.namespace);
          if (entry.pending.has(input.id)) throw new Error();
          if (entry.pending.size >= (options.maxPendingPerNamespace ?? 32)) throw new Error();
          const done = entry.computer.then((computer) =>
            dispatch(computer, input, controller.signal),
          );
          entry.pending.set(input.id, { controller, done });
          registered = true;
          const result = await done;
          controller.signal.throwIfAborted();
          response = {
            id: input.id,
            ok: true,
            result: result ?? null,
            metadata: metadata(await entry.computer, input),
          };
        }
      } catch (error) {
        response = {
          id: input.id,
          ok: false,
          error: controller.signal.aborted
            ? 'cancelled'
            : error instanceof BrowserActionError
              ? 'navigation'
              : error instanceof Error && 'statusCode' in error && error.statusCode === 423
                ? 'locked'
                : 'unavailable',
          metadata: metadata(await entry?.computer.catch(() => undefined), input),
        };
      } finally {
        if (registered) entry?.pending.delete(input.id);
      }
      terminal = true;
      if (socket.destroyed) return;
      try {
        const line = JSON.stringify(browserResponse.parse(response)) + '\n';
        if (Buffer.byteLength(line) > responseBytes) throw new Error();
        socket.end(line);
      } catch {
        socket.end(
          JSON.stringify({ id: input.id, ok: false, error: 'unavailable', metadata: metadata() }) +
            '\n',
        );
      }
    };
    socket.on('data', (chunk: string) => {
      received += Buffer.byteLength(chunk);
      if (terminal || received > requestBytes + 1024) return stop();
      incoming += chunk;
      for (let line = incoming.indexOf('\n'); line >= 0; line = incoming.indexOf('\n')) {
        const raw = incoming.slice(0, line);
        incoming = incoming.slice(line + 1);
        try {
          const frame = browserFrame.parse(JSON.parse(raw));
          if (frame.type === 'request') {
            if (request) return stop();
            request = frame.request;
            void execute(request);
          } else {
            if (!request || frame.id !== request.id) return stop();
            controller.abort();
          }
        } catch {
          return stop();
        }
      }
    });
  });
  server.maxConnections = 256;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return {
    async close() {
      if (closing) return;
      closing = true;
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of connections) socket.destroy();
      await Promise.allSettled([...namespaces.keys()].map(dispose));
      await stopped;
      await unlink(path).catch(() => {});
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const worker = await startContainerBrowserWorker();
  const stop = () => {
    void worker.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
