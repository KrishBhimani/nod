import { assertContainerStartupSettled } from './container-startup.ts';
import { RuntimeControlError } from './protocol.ts';

interface ContainerStop {
  stop(): Promise<void>;
  getState(): Promise<{ status: string }>;
}

export async function stopContainer(
  container: ContainerStop,
  options: { running(): boolean; timeoutMs?: number },
) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000)
    throw new RuntimeControlError(503);
  const deadline = Date.now() + timeoutMs;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const assert = () => {
    assertContainerStartupSettled(container);
    if (expired || Date.now() >= deadline) throw new RuntimeControlError(503);
  };
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new RuntimeControlError(503));
    }, timeoutMs);
  });
  const stopping = async () => {
    assert();
    await container.stop();
    assert();
    while (true) {
      const state = await container.getState();
      assert();
      if (!options.running() && ['stopped', 'stopped_with_code'].includes(state.status)) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
      assert();
      if (!options.running()) {
        await container.stop();
        assert();
      }
    }
  };
  try {
    await Promise.race([timeout, stopping()]);
  } catch {
    throw new RuntimeControlError(503);
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}
