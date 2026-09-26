import {
  bootstrap,
  generation,
  ownerIdentity,
  RuntimeControlError,
  type TenantIdentity,
} from './protocol.ts';

type ContainerState = 'running' | 'healthy' | 'stopping' | 'stopped' | 'stopped_with_code';

export function createTenantLifecycle(options: {
  environment: string;
  read(): Promise<TenantIdentity | undefined>;
  write(identity: TenantIdentity): Promise<void>;
  status(): Promise<ContainerState>;
  start(env: Record<string, string>): Promise<void>;
  stop(): Promise<void>;
}) {
  let pending: Promise<unknown> = Promise.resolve();
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }
  return {
    start(input: unknown) {
      return exclusive(async () => {
        const next = await bootstrap(input, options.environment);
        const previous = await options.read();
        const state = await options.status();
        const stopped = state === 'stopped' || state === 'stopped_with_code';
        if (previous) {
          if (
            previous.ownerId !== next.identity.ownerId ||
            previous.environment !== next.identity.environment
          )
            throw new RuntimeControlError(409);
          if (previous.generation === next.identity.generation) {
            if (previous.configurationHash !== next.identity.configurationHash || previous.stopped)
              throw new RuntimeControlError(409);
          } else if (
            !stopped ||
            !previous.stopped ||
            BigInt(previous.generation) >= BigInt(next.identity.generation)
          ) {
            throw new RuntimeControlError(409);
          }
        } else if (!stopped) throw new RuntimeControlError(409);
        if (state === 'stopping') throw new RuntimeControlError(409);
        await options.write(next.identity);
        await options.start(next.env);
        return { ok: true, generation: next.identity.generation };
      });
    },
    stop(owner: unknown, version: unknown) {
      return exclusive(async () => {
        const ownerId = ownerIdentity(owner);
        const expected = generation(version);
        const identity = await options.read();
        if (!identity || identity.ownerId !== ownerId || identity.generation !== expected)
          throw new RuntimeControlError(409);
        await options.stop();
        const state = await options.status();
        if (state !== 'stopped' && state !== 'stopped_with_code')
          throw new RuntimeControlError(503);
        await options.write({ ...identity, stopped: true });
        return { ok: true, generation: expected, stopped: true };
      });
    },
    async identity() {
      const identity = await options.read();
      if (!identity || identity.stopped) throw new RuntimeControlError(503);
      return identity;
    },
  };
}
