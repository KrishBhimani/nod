import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { ComputerState } from '../src/computer-lifecycle.ts';
import { retireUnusedComputer } from '../src/computer-retirement.ts';
import { startContainer } from '../src/container-startup.ts';

type Options = Parameters<typeof retireUnusedComputer>[0];

function fixture(role: 'browser' | 'workspace' = 'browser') {
  const identity = { ownerId: randomUUID(), environment: 'development', generation: '4', role };
  const original: ComputerState = {
    ...identity,
    generation: '3',
    phase: 'uncertain',
    stopped: true,
    commands: [],
  };
  const values = new Map<string, unknown>([['computer', structuredClone(original)]]);
  let beforeTransaction: (() => void) | undefined;
  let beforeCommit: (() => void) | undefined;
  let authorization: (() => void) | undefined;
  let inactive = true;
  let stopped = true;
  let now = 1000;
  let writes = 0;
  let serial: Promise<unknown> = Promise.resolve();
  const options: Options = {
    identity,
    deployment: { nonce: randomUUID(), targetRelease: 'a'.repeat(40), deadline: 10_000 },
    now: () => now,
    read: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    transaction(operation) {
      const result = serial.then(async () => {
        beforeTransaction?.();
        const draft = structuredClone(values);
        const storage = {
          get: async (key: string) => structuredClone(draft.get(key)),
          list: async ({ prefix, limit }: { prefix: string; limit: number }) =>
            new Map([...draft].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
          put: async (entries: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(entries))
              draft.set(key, structuredClone(value));
            writes++;
          },
        };
        const result = await operation(storage as unknown as Parameters<typeof operation>[0]);
        beforeCommit?.();
        values.clear();
        for (const [key, value] of draft) values.set(key, value);
        return result;
      });
      serial = result.catch(() => {});
      return result;
    },
    async authorize() {
      authorization?.();
    },
    inactive: () => inactive,
    physicallyStopped: async () => stopped,
  };
  return {
    options,
    original,
    values,
    archiveKey: `computer-retirement:${identity.generation}`,
    writes: () => writes,
    run: () => retireUnusedComputer(options),
    beforeTransaction(value: () => void) {
      beforeTransaction = value;
    },
    beforeCommit(value: () => void) {
      beforeCommit = value;
    },
    authorization(value: () => void) {
      authorization = value;
    },
    setInactive(value: boolean) {
      inactive = value;
    },
    setStopped(value: boolean) {
      stopped = value;
    },
    expire() {
      now = options.deployment.deadline;
    },
  };
}

test('unused retirement atomically retains the exact uncertainty record and a stopped replacement', async () => {
  for (const role of ['browser', 'workspace'] as const) {
    const f = fixture(role);
    f.values.set('unrelated-evidence', { retained: true });
    assert.equal(await f.run(), true);
    const replacement = { ...f.options.identity, phase: 'ready', stopped: true };
    assert.deepEqual(f.values.get('computer'), replacement);
    assert.deepEqual(f.values.get(f.archiveKey), {
      format: 'sidekick-unused-computer-retirement-v1',
      deployment: f.options.deployment,
      original: f.original,
      replacement,
    });
    assert.deepEqual(f.values.get('unrelated-evidence'), { retained: true });
    assert.equal(f.writes(), 1);
    const retained = structuredClone(f.values);
    assert.equal(await f.run(), false);
    assert.deepEqual(f.values, retained);
    assert.equal(f.writes(), 1);
  }
});

test('any durable command key blocks retirement regardless of generation or stored value', async () => {
  for (const key of [`command:1:${randomUUID()}`, `command:3:${randomUUID()}`, 'command:unknown']) {
    const f = fixture();
    f.values.set(key, false);
    const before = structuredClone(f.values);
    await assert.rejects(f.run(), { status: 503 });
    assert.deepEqual(f.values, before);
    assert.equal(f.writes(), 0);
  }
});

test('identity, generation, legacy command and checkpoint ambiguity keep the original fence', async () => {
  const changes: Array<Record<string, unknown>> = [
    { ownerId: randomUUID() },
    { environment: 'production' },
    { role: 'workspace' },
    { generation: '4' },
    { generation: '5' },
    { generation: 'invalid' },
    { stopped: false },
    { commands: [randomUUID()] },
    { commands: null },
    { checkpoint: {} },
    { previousCheckpoint: {} },
    { checkpoint: null },
    { unknown: true },
  ];
  for (const change of changes) {
    const f = fixture();
    f.values.set('computer', { ...f.original, ...change });
    const before = structuredClone(f.values);
    await assert.rejects(f.run(), { status: 503 });
    assert.deepEqual(f.values, before);
  }
});

test('ordinary absent, ready, dirty and restoring computers never enter retirement', async () => {
  for (const phase of [undefined, 'ready', 'dirty', 'restoring']) {
    const f = fixture();
    if (phase) f.values.set('computer', { ...f.original, phase });
    else f.values.delete('computer');
    const before = structuredClone(f.values);
    f.authorization(() => assert.fail('Ordinary lifecycle must not need retirement authority'));
    assert.equal(await f.run(), false);
    assert.deepEqual(f.values, before);
  }
});

test('active controllers, missing physical proof, expiry and revoked authority refuse before mutation', async () => {
  for (const condition of ['active', 'physical', 'deadline', 'authority']) {
    const f = fixture();
    if (condition === 'active') f.setInactive(false);
    if (condition === 'physical') f.setStopped(false);
    if (condition === 'deadline') f.expire();
    if (condition === 'authority')
      f.authorization(() => {
        throw new Error('synthetic revoked authority');
      });
    const before = structuredClone(f.values);
    await assert.rejects(f.run(), { status: 503 });
    assert.deepEqual(f.values, before);
  }
});

test('late claims, state changes, archive collisions and activity invalidate the atomic comparison', async () => {
  for (const condition of ['claim', 'state', 'archive', 'activity', 'expiry']) {
    const f = fixture();
    f.beforeTransaction(() => {
      if (condition === 'claim') f.values.set(`command:1:${randomUUID()}`, true);
      if (condition === 'state') f.values.set('computer', { ...f.original, generation: '2' });
      if (condition === 'archive') f.values.set(f.archiveKey, { retain: 'existing' });
      if (condition === 'activity') f.setInactive(false);
      if (condition === 'expiry') f.expire();
    });
    await assert.rejects(f.run(), { status: 503 });
    assert.equal(f.writes(), 0);
    assert.equal((f.values.get('computer') as ComputerState).phase, 'uncertain');
  }
});

test('a failed atomic commit cannot leave only an archive or only a replacement', async () => {
  const f = fixture();
  const before = structuredClone(f.values);
  f.beforeCommit(() => {
    throw new Error('synthetic storage failure');
  });
  await assert.rejects(f.run(), { status: 503 });
  assert.deepEqual(f.values, before);
});

test('authority loss after commit rejects acknowledgement without deleting the retained evidence', async () => {
  const f = fixture();
  f.authorization(() => {
    if (f.writes()) throw new Error('synthetic post-commit revocation');
  });
  await assert.rejects(f.run(), { status: 503 });
  assert.equal((f.values.get('computer') as ComputerState).stopped, true);
  assert.deepEqual(
    (f.values.get(f.archiveKey) as { original: ComputerState }).original,
    f.original,
  );
  assert.equal(f.writes(), 1);
  assert.equal(await f.run(), false);
  assert.equal(f.writes(), 1);
});

test('concurrent retirement attempts archive once and reject a stale comparison', async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.run(), f.run()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(f.writes(), 1);
  assert.deepEqual(
    (f.values.get(f.archiveKey) as { original: ComputerState }).original,
    f.original,
  );
});

const stub = `export class DurableObject { constructor(ctx,env) { this.ctx=ctx;this.env=env; } } export class WorkerEntrypoint {}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers')
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const { BrowserComputerContainer, WorkspaceComputerContainer, computerName } =
  await import('../src/computer-container.ts');

function controllerFixture(role: 'browser' | 'workspace', f = fixture(role)) {
  f.options.deployment.deadline = Date.now() + 60_000;
  const events: string[] = [];
  let inspect: () => Promise<unknown> = async () => null;
  let sdkStatus = 'stopped';
  let authorized = true;
  const namespace = { idFromName: (name: string) => ({ toString: () => name }) };
  const identity = f.options.identity;
  const storage = {
    get: f.options.read,
    transaction: f.options.transaction,
  };
  const native = {
    running: false,
    inspect: () => inspect(),
    exec: () => assert.fail('Retirement must not execute a process'),
  };
  const Computer = role === 'browser' ? BrowserComputerContainer : WorkspaceComputerContainer;
  const computer = Object.assign(Object.create(Computer.prototype), {
    role,
    env: {
      SIDEKICK_ENVIRONMENT: identity.environment,
      BROWSER_COMPUTERS: namespace,
      WORKSPACE_COMPUTERS: namespace,
      TENANTS: {
        getByName: () => ({
          async deploymentComputerIdentity(owner: string, version: string) {
            assert.equal(owner, identity.ownerId);
            assert.equal(version, identity.generation);
            if (!authorized) throw new Error('synthetic authority failure');
          },
          async deploymentUnusedComputerIdentity() {
            events.push('natural-drain-authority');
            if (!authorized) throw new Error('synthetic authority failure');
          },
          async computerIdentity() {
            if (!authorized) throw new Error('synthetic authority failure');
          },
        }),
      },
    },
    ctx: {
      storage,
      container: native,
      id: { toString: () => computerName(identity.environment, identity.ownerId, role) },
    },
    getState: async () => ({ status: sdkStatus }),
    destroy: () => assert.fail('Retirement must not destroy a container'),
    startAndWaitForPorts: () => assert.fail('Retirement must not start a container'),
  }) as InstanceType<typeof Computer>;
  return {
    ...f,
    computer,
    native,
    events,
    drain: () =>
      computer.prepareDeploymentDrain(identity.ownerId, identity.generation, f.options.deployment),
    inspect(value: () => Promise<unknown>) {
      inspect = value;
    },
    sdk(value: string) {
      sdkStatus = value;
    },
    revoke() {
      authorized = false;
    },
  };
}

test('both controller roles retire only through deployment drain and keep ordinary launch closed', async () => {
  for (const role of ['browser', 'workspace'] as const) {
    const f = controllerFixture(role);
    assert.deepEqual(await f.drain(), {
      status: 'drained',
      generation: '4',
      clean: true,
      stopped: true,
    });
    assert.equal(f.events.length, 4);
    assert.deepEqual(
      (f.values.get(f.archiveKey) as { original: ComputerState }).original,
      f.original,
    );
    assert.deepEqual(await f.drain(), {
      status: 'drained',
      generation: '4',
      clean: true,
      stopped: true,
    });
    const response = await f.computer.request(
      f.options.identity.ownerId,
      '4',
      new Request('http://sidekick.computer/v1/commands', {
        method: 'POST',
        headers: { 'x-sidekick-generation': '4', 'x-sidekick-computer-role': role },
        body: JSON.stringify({
          id: randomUUID(),
          role,
          ...(role === 'workspace' && { taskId: 'synthetic' }),
        }),
      }),
    );
    assert.equal(response.status, 503);
    assert.equal(
      [...f.values.keys()].some((key) => key.startsWith('command:')),
      false,
    );
    assert.equal((f.values.get('computer') as ComputerState).stopped, true);
  }
});

test('a fresh controller can drain a retired marker under a later operation without rewriting its archive', async () => {
  for (const role of ['browser', 'workspace'] as const) {
    const f = controllerFixture(role);
    assert.equal((await f.drain()).status, 'drained');
    const before = JSON.stringify([...f.values]);
    const writes = f.writes();
    f.options.deployment = {
      nonce: randomUUID(),
      targetRelease: 'c'.repeat(40),
      deadline: Date.now() + 60_000,
    };
    const reloaded = controllerFixture(role, f);
    assert.equal((await reloaded.drain()).status, 'drained');
    assert.equal(JSON.stringify([...f.values]), before);
    assert.equal(f.writes(), writes);
    assert.deepEqual(reloaded.events, []);
  }
});

test('controller retirement rejects unknown native absence and nonterminal SDK state', async () => {
  for (const condition of ['undefined', 'present', 'rejection', 'healthy', 'native-running']) {
    const f = controllerFixture('browser');
    if (condition === 'undefined') f.inspect(async () => undefined);
    if (condition === 'present') f.inspect(async () => ({}));
    if (condition === 'rejection')
      f.inspect(async () => {
        throw new Error('synthetic inspect failure');
      });
    if (condition === 'healthy') f.sdk('healthy');
    if (condition === 'native-running') f.native.running = true;
    await assert.rejects(f.drain());
    assert.deepEqual(f.values.get('computer'), f.original);
    assert.equal(f.values.has(f.archiveKey), false);
  }
});

test('unsettled raw startup blocks retirement even when native and SDK state appear stopped', async () => {
  const f = controllerFixture('browser');
  let finish!: () => void;
  Object.assign(f.computer, {
    startAndWaitForPorts: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  await assert.rejects(startContainer(f.computer, { timeoutMs: 5 }));
  await assert.rejects(f.drain());
  assert.deepEqual(f.values.get('computer'), f.original);
  assert.equal(f.values.has(f.archiveKey), false);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
});

test('a controller selection already awaiting storage cannot enter during retirement', async () => {
  const f = controllerFixture('browser');
  const context = (f.computer as unknown as { ctx: { storage: { get: Options['read'] } } }).ctx;
  const read = context.storage.get;
  let releaseSelection!: () => void;
  let selected!: () => void;
  const selecting = new Promise<void>((resolve) => {
    selected = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseSelection = resolve;
  });
  let first = true;
  context.storage.get = async <T>(key: string) => {
    if (key === 'computer' && first) {
      first = false;
      selected();
      await blocked;
    }
    return read<T>(key);
  };
  let releaseInspect!: () => void;
  let inspected!: () => void;
  const inspecting = new Promise<void>((resolve) => {
    inspected = resolve;
  });
  const inspection = new Promise<void>((resolve) => {
    releaseInspect = resolve;
  });
  f.inspect(async () => {
    inspected();
    await inspection;
    return null;
  });
  const request = f.computer.request(
    f.options.identity.ownerId,
    '4',
    new Request('http://sidekick.computer/v1/commands', {
      method: 'POST',
      headers: { 'x-sidekick-generation': '4', 'x-sidekick-computer-role': 'browser' },
      body: JSON.stringify({ id: randomUUID(), role: 'browser' }),
    }),
  );
  await selecting;
  const drain = f.drain();
  await inspecting;
  releaseSelection();
  assert.equal((await request).status, 503);
  releaseInspect();
  assert.equal((await drain).status, 'drained');
  assert.equal(f.values.has(f.archiveKey), true);
});

test('native inspection cannot install a concurrent controller or acknowledge lost authority', async () => {
  const f = controllerFixture('browser');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const inspecting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.inspect(async () => {
    entered();
    await held;
    return null;
  });
  const drain = f.drain();
  await inspecting;
  const response = await f.computer.request(
    f.options.identity.ownerId,
    '4',
    new Request('http://sidekick.computer/v1/commands', {
      method: 'POST',
      headers: { 'x-sidekick-generation': '4', 'x-sidekick-computer-role': 'browser' },
      body: JSON.stringify({ id: randomUUID(), role: 'browser' }),
    }),
  );
  assert.equal(response.status, 503);
  f.revoke();
  release();
  await assert.rejects(drain);
  assert.deepEqual(f.values.get('computer'), f.original);
  assert.equal(f.values.has(f.archiveKey), false);
});
