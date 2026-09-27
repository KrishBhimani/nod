import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createRuntimeLeaseAlarm } from '../src/lease-alarm.ts';
import type { TenantIdentity } from '../src/protocol.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test('a delayed scheduling read cannot replace a newer lease deadline or revive a stopped schedule', async (t) => {
  for (const stopped of [false, true]) {
    await t.test(stopped ? 'stopped' : 'renewed', async () => {
      const now = Date.UTC(2026, 8, 27, 12) + 123;
      let identity: TenantIdentity = {
        ownerId: randomUUID(),
        environment: 'development',
        generation: '1',
        configurationHash: 'fixture',
        leaseExpiresAt: now + 20_000,
        revoking: false,
        stopped: false,
      };
      const firstRead = deferred<TenantIdentity>();
      const entered = deferred<void>();
      const previous = { ...identity };
      let reads = 0;
      const scheduled: number[] = [];
      const alarm = createRuntimeLeaseAlarm({
        now: () => now,
        read: async () => {
          if (++reads !== 1) return { ...identity };
          entered.resolve();
          return firstRead.promise;
        },
        expire: async () => {},
        clear: () => {
          scheduled.length = 0;
        },
        schedule: async (when) => {
          scheduled.push(when.getTime());
        },
      });
      const earlier = alarm.update();
      await entered.promise;
      identity = { ...identity, leaseExpiresAt: now + 60_000, stopped };
      const later = alarm.update();
      firstRead.resolve(previous);
      await Promise.all([earlier, later]);
      assert.deepEqual(
        scheduled,
        stopped ? [] : [Math.ceil(identity.leaseExpiresAt / 1000) * 1000],
      );
      assert.equal(reads, 2);
    });
  }
});

test('an early expiry callback rechecks the current deadline and cleanup failures schedule bounded retries', async () => {
  let now = Date.UTC(2026, 8, 27, 12) + 123;
  let identity: TenantIdentity = {
    ownerId: randomUUID(),
    environment: 'development',
    generation: '1',
    configurationHash: 'fixture',
    leaseExpiresAt: now + 60_000,
    revoking: false,
    stopped: false,
  };
  const scheduled: number[] = [];
  let fail = true;
  const alarm = createRuntimeLeaseAlarm({
    now: () => now,
    read: async () => ({ ...identity }),
    expire: async () => {
      if (now < identity.leaseExpiresAt) return;
      identity = { ...identity, revoking: true };
      if (fail) throw new Error('synthetic private cleanup failure');
      identity = { ...identity, stopped: true };
    },
    clear: () => {
      scheduled.length = 0;
    },
    schedule: async (when) => {
      scheduled.push(when.getTime());
    },
  });
  await alarm.run();
  assert.equal(identity.revoking, false);
  assert.deepEqual(scheduled, [Math.ceil(identity.leaseExpiresAt / 1000) * 1000]);
  now = identity.leaseExpiresAt;
  await alarm.run();
  assert.equal(identity.revoking, true);
  assert.equal(identity.stopped, false);
  assert.deepEqual(scheduled, [Math.ceil((now + 5000) / 1000) * 1000]);
  now += 5000;
  fail = false;
  await alarm.run();
  assert.equal(identity.stopped, true);
  assert.deepEqual(scheduled, []);
});
