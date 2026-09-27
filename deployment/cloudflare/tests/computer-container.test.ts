import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { ComputerState } from '../src/computer-lifecycle.ts';

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nativeProcess() {
  const killed: number[] = [];
  return {
    killed,
    process: {
      pid: 1,
      isPty: false,
      stdin: new WritableStream(),
      stdout: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      exitCode: Promise.resolve(0),
      kill(signal: number) {
        killed.push(signal);
      },
      resize() {},
      async output() {
        throw new Error('Unused fixture');
      },
    } as ExecProcess,
  };
}

function fixture(role: 'browser' | 'workspace', phase: ComputerState['phase'], checkpoint = false) {
  const ownerId = randomUUID();
  const data = new Uint8Array(1024);
  const state: ComputerState = {
    ownerId,
    environment: 'development',
    generation: '1',
    role,
    phase,
    stopped: false,
    ...(checkpoint
      ? {
          checkpoint: {
            format: 'sidekick-computer-tar-v1',
            id: randomUUID(),
            ownerId,
            environment: 'development',
            role,
            bytes: data.length,
            sha256: createHash('sha256').update(data).digest('hex'),
            etag: 'fixture',
          },
        }
      : {}),
  };
  const values = new Map<string, unknown>([['computer', state]]);
  const events: string[] = [];
  const pending: Promise<unknown>[] = [];
  let exec = async (_args: string[]): Promise<ExecProcess> => nativeProcess().process;
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    transaction: async <T>(operation: (storage: unknown) => Promise<T>) => operation(storage),
  };
  const container = {
    running: true,
    exec: (args: string[]) => {
      events.push(`exec:${args.join(' ')}`);
      return exec(args);
    },
  };
  const namespace = { idFromName: (name: string) => ({ toString: () => name }) };
  const env = {
    SIDEKICK_ENVIRONMENT: 'development',
    BROWSER_COMPUTERS: namespace,
    WORKSPACE_COMPUTERS: namespace,
    TENANTS: {
      getByName(name: string) {
        assert.equal(name, `tenant:development:${ownerId}`);
        return {
          async computerIdentity(owner: string, generation: string) {
            assert.equal(owner, ownerId);
            assert.equal(generation, '1');
          },
        };
      },
    },
    TENANT_FILES: {
      async get(key: string) {
        return {
          key,
          size: data.length,
          etag: 'fixture',
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(data);
              controller.close();
            },
          }),
        };
      },
    },
  };
  const Computer = role === 'browser' ? BrowserComputerContainer : WorkspaceComputerContainer;
  const computer = Object.assign(Object.create(Computer.prototype), {
    role,
    env,
    ctx: {
      storage,
      container,
      id: { toString: () => computerName('development', ownerId, role) },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    },
    destroy: async () => {
      events.push('destroy');
      container.running = false;
    },
    startAndWaitForPorts: async () => {
      events.push('start');
      container.running = true;
    },
    renewActivityTimeout: () => {
      events.push('renew');
    },
  }) as InstanceType<typeof Computer>;
  return {
    computer,
    ownerId,
    events,
    container,
    state: () => structuredClone(values.get('computer')) as ComputerState,
    exec: (value: typeof exec) => {
      exec = value;
    },
    request: (path: string, init: RequestInit = {}) =>
      computer.request(
        ownerId,
        '1',
        new Request(`http://sidekick.computer${path}`, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init.headers)),
            'x-sidekick-generation': '1',
            'x-sidekick-computer-role': role,
          },
        }),
      ),
  };
}

test('an idle alarm hydrates an evicted controller before retiring its running computer', async (t) => {
  for (const phase of ['ready', 'restoring', 'dirty'] as const) {
    await t.test(phase, async () => {
      const current = fixture('browser', phase, true);
      const checkpoint = current.state().checkpoint;
      await current.computer.onActivityExpired();
      assert.equal(current.container.running, false);
      assert.deepEqual(current.events, ['destroy']);
      assert.equal(current.state().phase, phase === 'dirty' ? 'uncertain' : phase);
      assert.deepEqual(current.state().checkpoint, checkpoint);
    });
  }
});

test('restore process creation is bounded and a late native handle cannot revive the failed computer', async (t) => {
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, duration: number) =>
    original(callback, duration === 120_000 ? 10 : duration),
  );
  const launch = deferred<ExecProcess>();
  const current = fixture('workspace', 'ready', true);
  current.exec(async (args) => {
    assert.equal(args[3], 'restore');
    return launch.promise;
  });
  const response = await Promise.race([
    current.request('/v1/commands', {
      method: 'POST',
      body: JSON.stringify({ id: randomUUID(), role: 'workspace', taskId: 'task' }),
    }),
    delay(500).then(() => assert.fail('Restoration did not respect its deadline')),
  ]);
  assert.equal(response.status, 503);
  assert.equal(current.container.running, false);
  assert.equal(current.state().phase, 'uncertain');
  const late = nativeProcess();
  launch.resolve(late.process);
  await delay(0);
  assert.deepEqual(late.killed, [9]);
  assert.equal(current.events.filter((event) => event.startsWith('exec:')).length, 1);
});

test('checkpoint process creation is bounded and never emits a clean command exit after failure', async (t) => {
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, duration: number) =>
    original(callback, duration === 120_000 ? 10 : duration),
  );
  const checkpoint = deferred<ExecProcess>();
  const current = fixture('workspace', 'ready');
  current.exec(async (args) =>
    args[3] === 'create' ? checkpoint.promise : nativeProcess().process,
  );
  const id = randomUUID();
  assert.equal(
    (
      await current.request('/v1/commands', {
        method: 'POST',
        body: JSON.stringify({ id, role: 'workspace', taskId: 'task' }),
      })
    ).status,
    201,
  );
  const response = await current.request(`/v1/commands/${id}/output`);
  assert.equal(response.status, 200);
  await assert.rejects(
    Promise.race([
      response.text(),
      delay(500).then(() => assert.fail('Checkpointing did not respect its deadline')),
    ]),
  );
  await delay(0);
  assert.equal(current.container.running, false);
  assert.equal(current.state().phase, 'uncertain');
  const late = nativeProcess();
  checkpoint.resolve(late.process);
  await delay(0);
  assert.deepEqual(late.killed, [9]);
});
