import type { TenantIdentity } from './protocol.ts';

export function createRuntimeLeaseAlarm(options: {
  read(): Promise<TenantIdentity | undefined>;
  expire(): Promise<unknown>;
  clear(): void;
  schedule(when: Date): Promise<unknown>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let pending = Promise.resolve();
  function update(retry = false) {
    const result = pending.then(async () => {
      const identity = await options.read();
      options.clear();
      if (!identity || identity.stopped || !Number.isSafeInteger(identity.leaseExpiresAt)) return;
      const expiry =
        retry || identity.revoking
          ? now() + 5_000
          : Math.max(now() + 1_000, identity.leaseExpiresAt);
      await options.schedule(new Date(Math.ceil(expiry / 1000) * 1000));
    });
    pending = result.catch(() => {});
    return result;
  }
  return {
    update: () => update(),
    async run() {
      try {
        await options.expire();
        await update();
      } catch {
        try {
          await update(true);
        } catch {
          throw new Error('The account runtime expiry check failed.');
        }
      }
    },
  };
}
