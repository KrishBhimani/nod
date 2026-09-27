import { RuntimeControlError } from './protocol.ts';

interface ContainerStartup {
  startAndWaitForPorts(options: {
    startOptions?: { envVars: Record<string, string> };
    cancellationOptions: {
      abort: AbortSignal;
      instanceGetTimeoutMS: number;
      portReadyTimeoutMS: number;
    };
  }): Promise<void>;
}

const pending = new WeakSet<object>();

export function assertContainerStartupSettled(container: object) {
  if (pending.has(container)) throw new RuntimeControlError(503);
}

export async function startContainer(
  container: ContainerStartup,
  options: { envVars?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 40_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 45_000)
    throw new RuntimeControlError(503);
  if (options.signal?.aborted) throw new RuntimeControlError(503);
  assertContainerStartupSettled(container);
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => {
      controller.abort();
      reject(new RuntimeControlError(503));
    };
  });
  const timer = setTimeout(cancel, timeoutMs);
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    pending.add(container);
    let operation: Promise<void>;
    try {
      operation = container.startAndWaitForPorts({
        ...(options.envVars ? { startOptions: { envVars: options.envVars } } : {}),
        cancellationOptions: {
          abort: controller.signal,
          instanceGetTimeoutMS: timeoutMs * 2,
          portReadyTimeoutMS: timeoutMs * 2,
        },
      });
    } catch {
      pending.delete(container);
      throw new RuntimeControlError(503);
    }
    const settled = Promise.resolve(operation).finally(() => pending.delete(container));
    await Promise.race([cancelled, settled]);
    if (controller.signal.aborted || Date.now() >= deadline) throw new RuntimeControlError(503);
  } catch {
    throw new RuntimeControlError(503);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
