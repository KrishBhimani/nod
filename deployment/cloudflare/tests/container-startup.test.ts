import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { assertContainerStartupSettled, startContainer } from '../src/container-startup.ts';
import { createTenantLifecycle } from '../src/lifecycle.ts';
import { RuntimeControlError, type TenantIdentity } from '../src/protocol.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}

test('startup remains available beyond the SDK default cold-start budget', async () => {
  let initialized = false;
  await startContainer({
    async startAndWaitForPorts({ cancellationOptions }) {
      const elapsed = 12_000;
      if (cancellationOptions.instanceGetTimeoutMS <= elapsed) await new Promise<void>(() => {});
      cancellationOptions.abort.throwIfAborted();
      initialized = true;
    },
  });
  assert.equal(initialized, true);
});

test('startup cancels before SDK retry exhaustion can await a running container exit', async () => {
  let exhausted = false;
  let aborted = false;
  await assert.rejects(
    startContainer(
      {
        async startAndWaitForPorts({ cancellationOptions }) {
          await new Promise<void>((_, reject) => {
            const timer = setTimeout(() => {
              exhausted = true;
            }, cancellationOptions.instanceGetTimeoutMS);
            cancellationOptions.abort.addEventListener('abort', () => {
              clearTimeout(timer);
              aborted = true;
              reject(new Error('synthetic SDK cancellation'));
            });
          });
        },
      },
      { timeoutMs: 20 },
    ),
    RuntimeControlError,
  );
  assert.equal(aborted, true);
  assert.equal(exhausted, false);
});

test('unresponsive startup returns a bounded failure without waiting for SDK cleanup', async () => {
  let signal: AbortSignal | undefined;
  let rejectStartup!: (reason: Error) => void;
  await assert.rejects(
    startContainer(
      {
        startAndWaitForPorts(options) {
          signal = options.cancellationOptions.abort;
          return new Promise((_, reject) => {
            rejectStartup = reject;
          });
        },
      },
      { timeoutMs: 10 },
    ),
    RuntimeControlError,
  );
  assert.equal(signal?.aborted, true);
  rejectStartup(new Error('synthetic late SDK failure'));
  await new Promise((resolve) => setImmediate(resolve));
});

test('request cancellation aborts startup and an already cancelled request cannot start it', async () => {
  const controller = new AbortController();
  let starts = 0;
  let signal: AbortSignal | undefined;
  const container = {
    startAndWaitForPorts(options: { cancellationOptions: { abort: AbortSignal } }) {
      starts++;
      signal = options.cancellationOptions.abort;
      return new Promise<void>(() => {});
    },
  };
  const starting = startContainer(container, { signal: controller.signal });
  controller.abort();
  await assert.rejects(starting, RuntimeControlError);
  assert.equal(signal?.aborted, true);
  await assert.rejects(
    startContainer(container, { signal: controller.signal }),
    RuntimeControlError,
  );
  assert.equal(starts, 1);
});

test('startup forwards the selected environment and replaces private SDK errors', async () => {
  let environment: Record<string, string> | undefined;
  await assert.rejects(
    startContainer(
      {
        async startAndWaitForPorts({ startOptions }) {
          environment = startOptions?.envVars;
          throw new Error('synthetic private startup configuration');
        },
      },
      { envVars: { SIDEKICK_MODE: 'tenant' } },
    ),
    (error) => error instanceof RuntimeControlError && !error.message.includes('private'),
  );
  assert.deepEqual(environment, { SIDEKICK_MODE: 'tenant' });
});

test('a timed-out raw start remains fenced against another start until its actual settlement', async () => {
  const raw = deferred();
  let starts = 0;
  const container = {
    startAndWaitForPorts() {
      starts++;
      return raw.promise;
    },
  };
  await assert.rejects(startContainer(container, { timeoutMs: 10 }), RuntimeControlError);
  assert.throws(() => assertContainerStartupSettled(container), RuntimeControlError);
  await assert.rejects(startContainer(container, { timeoutMs: 10 }), RuntimeControlError);
  assert.equal(starts, 1);
  await startContainer({ startAndWaitForPorts: async () => {} });
  assert.throws(() => assertContainerStartupSettled(container), RuntimeControlError);
  raw.reject(new Error('synthetic private late failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotThrow(() => assertContainerStartupSettled(container));
  container.startAndWaitForPorts = async () => {
    starts++;
  };
  await startContainer(container);
  assert.equal(starts, 2);
  assert.doesNotThrow(() => assertContainerStartupSettled(container));
});

test('request cancellation does not remove an unsettled startup fence', async () => {
  const raw = deferred();
  const controller = new AbortController();
  const container = { startAndWaitForPorts: () => raw.promise };
  const starting = startContainer(container, { signal: controller.signal });
  controller.abort();
  await assert.rejects(starting, RuntimeControlError);
  assert.throws(() => assertContainerStartupSettled(container), RuntimeControlError);
  raw.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotThrow(() => assertContainerStartupSettled(container));
});

test('synchronous SDK failure cannot leave a stale startup fence', async () => {
  const container = {
    startAndWaitForPorts: (): Promise<void> => {
      throw new Error('synthetic private failure');
    },
  };
  await assert.rejects(startContainer(container), RuntimeControlError);
  assert.doesNotThrow(() => assertContainerStartupSettled(container));
});

test('late SDK success cannot outrun a deadline whose timer has not run', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const container = {
    startAndWaitForPorts: async () => {
      now += 1000;
    },
  };
  await assert.rejects(startContainer(container, { timeoutMs: 1000 }), RuntimeControlError);
  assert.doesNotThrow(() => assertContainerStartupSettled(container));
});

test('a late native launch cannot produce a stop receipt or replacement until settled and physically stopped', async () => {
  const ownerId = randomUUID();
  const suffix = createHash('sha256')
    .update(JSON.stringify(['sidekick-tenant-v1', 'development', ownerId]))
    .digest('hex')
    .slice(0, 32);
  const environment = (generation: string) => ({
    ownerId,
    env: {
      SIDEKICK_OWNER_ID: ownerId,
      SIDEKICK_ENVIRONMENT: 'development',
      SIDEKICK_MODE: 'tenant',
      SIDEKICK_RUNTIME_GENERATION: generation,
      SIDEKICK_RUNTIME_SECRET: 's'.repeat(43),
      SIDEKICK_RUNTIME_LEASE_EXPIRES: new Date(Date.now() + 60_000).toISOString(),
      DATABASE_URL: `postgresql://sk_user_${suffix}:synthetic@db.example.test/sidekick`,
      PGBOSS_SCHEMA: `sk_jobs_${suffix}`,
    },
  });
  const outboundReady = deferred();
  const lateStarted = deferred();
  let identity: TenantIdentity | undefined;
  let running = false;
  let stopped = 0;
  const generations: string[] = [];
  const container: Parameters<typeof startContainer>[0] = {
    async startAndWaitForPorts({ startOptions, cancellationOptions }) {
      const version = startOptions!.envVars.SIDEKICK_RUNTIME_GENERATION;
      if (version === '1') await outboundReady.promise;
      running = true;
      generations.push(version);
      lateStarted.resolve();
      cancellationOptions.abort.throwIfAborted();
    },
  };
  const lifecycle = createTenantLifecycle({
    environment: 'development',
    read: async () => identity,
    write: async (value) => {
      identity = { ...value };
    },
    status: async () => (running ? 'healthy' : 'stopped'),
    start: (envVars) => startContainer(container, { envVars, timeoutMs: 10 }),
    stop: async () => {
      assertContainerStartupSettled(container);
      stopped++;
      running = false;
      assertContainerStartupSettled(container);
    },
  });
  await assert.rejects(lifecycle.start(environment('1')), RuntimeControlError);
  assert.equal(running, false);
  await assert.rejects(lifecycle.stop(ownerId, '1'), RuntimeControlError);
  assert.equal(identity!.stopped, false);
  assert.equal(stopped, 0);
  await assert.rejects(lifecycle.start(environment('2')), RuntimeControlError);
  outboundReady.resolve();
  await lateStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(generations, ['1']);
  assert.equal(running, true);
  assert.doesNotThrow(() => assertContainerStartupSettled(container));
  await assert.rejects(lifecycle.start(environment('2')), RuntimeControlError);
  assert.deepEqual(await lifecycle.stop(ownerId, '1'), {
    ok: true,
    generation: '1',
    stopped: true,
  });
  assert.equal(stopped, 1);
  assert.equal(identity!.stopped, true);
  assert.equal(running, false);
  assert.deepEqual(await lifecycle.start(environment('2')), { ok: true, generation: '2' });
  assert.deepEqual(generations, ['1', '2']);
});
