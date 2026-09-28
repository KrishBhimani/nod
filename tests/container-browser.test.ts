import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Computer } from '../src/ports/computer.ts';
import type { CredentialInjection } from '../src/server/vault.ts';
import { BrowserActionError } from '../src/ports/computer.ts';
import {
  createContainerBrowserComputer,
  browserNamespace,
  type BrowserBridgeLauncher,
} from '../src/providers/container-browser/index.ts';
import { startContainerBrowserWorker } from '../src/providers/container-browser/worker.ts';
import { runBrowserBridge } from '../src/providers/container-browser/bridge.ts';

test('a failed browser bridge launch cannot create an active session', async () => {
  let launches = 0;
  const computer = createContainerBrowserComputer({
    dataRoot: '/synthetic/failed-launch',
    spawn: () => {
      launches++;
      throw new Error('synthetic private bridge failure');
    },
  });
  await assert.rejects(computer.act('task', { action: 'snapshot' }), {
    message: 'The workspace browser is unavailable. Start its container and try again.',
  });
  assert.equal(computer.currentSession?.(), undefined);
  assert.match(computer.status(), /needs a restart/);
  await assert.rejects(computer.act('task', { action: 'snapshot' }), /unavailable/);
  assert.equal(launches, 1);
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeComputer() {
  const calls: Array<{ method: string; input?: unknown }> = [];
  let session: ReturnType<NonNullable<Computer['currentSession']>>;
  let act: Computer['act'] = async (id, input) => {
    session = { taskId: id, lastActivityAt: new Date().toISOString() };
    return {
      text: input.text ?? 'Synthetic page',
      url: input.url ?? 'https://example.com/',
      candidates: [],
    };
  };
  const computer: Computer = {
    currentSession: () => session,
    status: () => 'Synthetic workspace browser',
    screenStatus: () => ({ state: 'live', capturedAt: '2026-09-25T12:00:00.000Z' }),
    act: (id, input, signal) => {
      calls.push({ method: 'act', input });
      return act(id, input, signal);
    },
    screenshot: async () => Buffer.from('masked synthetic image'),
    signInScreenshot: async () => Buffer.from('owner-only synthetic sign-in image'),
    takeControl: async () => {
      calls.push({ method: 'takeControl' });
    },
    openSignIn: async () => {
      calls.push({ method: 'openSignIn' });
    },
    finishSignIn: async () => {
      calls.push({ method: 'finishSignIn' });
    },
    control: async (_id, input) => {
      calls.push({ method: 'control', input });
    },
    signInControl: async (_id, input) => {
      calls.push({ method: 'signInControl', input });
    },
    releaseControl: async () => {},
    injectCredentials: async (input) => {
      calls.push({ method: 'injectCredentials', input });
      return { status: 'submitted' };
    },
    inspectLogin: async () => ({
      origin: 'https://example.com',
      url: 'https://example.com/login',
      fields: [],
      methods: [],
    }),
    selectLoginMethod: async () => {},
    hold: async () => {},
    close: async () => {
      calls.push({ method: 'close' });
    },
    dispose: async () => {
      calls.push({ method: 'dispose' });
    },
  };
  return {
    computer,
    calls,
    setAct(value: Computer['act']) {
      act = value;
    },
  };
}

async function harness(control: { beforeFirstBridge?: Promise<void> } = {}) {
  const root = await mkdtemp('/tmp/sk-browser-');
  const socketPath = join(root, 'control.sock');
  const instances = new Map<string, ReturnType<typeof fakeComputer>>();
  const worker = await startContainerBrowserWorker({
    socketPath,
    dataRoot: root,
    createComputer: async (path) => {
      const value = fakeComputer();
      instances.set(path, value);
      return value.computer;
    },
  });
  const launches: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> =
    [];
  const launch: BrowserBridgeLauncher = (command, args, options) => {
    launches.push({ command, args, env: options.env });
    const process = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        this.stdin.destroy();
        return true;
      },
    });
    void Promise.resolve(launches.length === 1 ? control.beforeFirstBridge : undefined)
      .then(() => runBrowserBridge({ input: process.stdin, output: process.stdout, socketPath }))
      .then((code) => {
        process.stdout.end();
        process.stderr.end();
        process.emit('close', code);
      });
    return process as unknown as ChildProcessWithoutNullStreams;
  };
  const clients: Computer[] = [];
  function client(
    dataRoot: string,
    options: { timeoutMs?: number; openTimeoutMs?: number; drainTimeoutMs?: number } = {},
  ) {
    const value = createContainerBrowserComputer({ dataRoot, spawn: launch, ...options });
    clients.push(value);
    return value;
  }
  return {
    root,
    socketPath,
    worker,
    launches,
    instances,
    client,
    instance(dataRoot: string) {
      const value = instances.get(join(root, browserNamespace(dataRoot)));
      assert.ok(value);
      return value;
    },
    async close() {
      await Promise.allSettled(clients.map((client) => client.dispose()));
      await worker.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('container browser routes through the private bridge and preserves images, metadata and Unicode credentials', async () => {
  const fixture = await harness();
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-provider-value';
  try {
    const computer = fixture.client('/synthetic/private-app');
    const observation = await computer.act('task-1', {
      action: 'fill',
      selector: '#name',
      text: 'Olá 🌍',
    });
    assert.equal(observation.text, 'Olá 🌍');
    assert.equal(computer.currentSession?.()?.taskId, 'task-1');
    assert.equal(computer.status(), 'Synthetic workspace browser');
    assert.equal((await computer.screenshot('task-1'))?.toString(), 'masked synthetic image');
    assert.equal(computer.screenStatus?.('task-1').state, 'live');
    assert.equal(
      (await computer.signInScreenshot?.('task-1'))?.toString(),
      'owner-only synthetic sign-in image',
    );
    await computer.signInControl?.('task-1', { action: 'type', text: 'Synthetic 🔒' });
    await computer.injectCredentials({
      taskId: 'task-1',
      origin: 'https://example.com',
      username: 'synthetic@example.test',
      password: 'Synthetic 🔑',
    });
    const inputs = fixture.instance('/synthetic/private-app').calls;
    assert.deepEqual(inputs.find((entry) => entry.method === 'injectCredentials')?.input, {
      taskId: 'task-1',
      origin: 'https://example.com',
      username: 'synthetic@example.test',
      password: 'Synthetic 🔑',
    });
    for (const launch of fixture.launches) {
      assert.equal(launch.command, 'docker');
      assert.deepEqual(launch.args, [
        'exec',
        '-i',
        '--user',
        'node',
        'otto-browser',
        'node',
        '--import',
        'tsx',
        '/app/src/providers/container-browser/bridge.ts',
      ]);
      assert.equal(launch.env?.OPENAI_API_KEY, undefined);
      assert.doesNotMatch(JSON.stringify(launch.args), /Synthetic|private-app|password/);
    }
    assert.equal((await stat(fixture.socketPath)).mode & 0o777, 0o600);
    assert.equal((await stat(fixture.root)).mode & 0o777, 0o700);
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    await fixture.close();
  }
});

test('Vault broker metadata stays local while identifier, password and OTP inputs reach the browser', async () => {
  const fixture = await harness();
  const dataRoot = '/synthetic/vault-broker';
  const inputs: CredentialInjection[] = [
    {
      taskId: 'task',
      origin: 'https://example.com',
      label: 'Synthetic saved account',
      kind: 'identifier',
      username: 'synthetic@example.test',
      usernameSelector: '#username',
      submitSelector: '#continue',
    },
    {
      taskId: 'task',
      origin: 'https://example.com',
      label: 'Synthetic saved account',
      kind: 'password',
      username: 'synthetic@example.test',
      password: 'Synthetic-only-value',
      usernameSelector: '#username',
      passwordSelector: '#password',
      submitSelector: '#continue',
    },
    {
      taskId: 'task',
      origin: 'https://example.com',
      label: 'Synthetic verification step',
      kind: 'otp',
      code: '123456',
      passwordSelector: '#code',
      submitSelector: '#verify',
    },
  ];
  try {
    const computer = fixture.client(dataRoot);
    for (const input of inputs)
      assert.deepEqual(await computer.injectCredentials(input), { status: 'submitted' });
    const calls = fixture
      .instance(dataRoot)
      .calls.filter((call) => call.method === 'injectCredentials');
    assert.equal(calls.length, inputs.length);
    for (const [index, input] of inputs.entries()) {
      const { label: _label, ...expected } = input;
      assert.deepEqual(calls[index].input, expected);
    }
    assert.doesNotMatch(
      JSON.stringify(fixture.launches),
      /Synthetic saved account|Synthetic-only-value|123456/,
    );
  } finally {
    await fixture.close();
  }
});

test('cancellation waits for worker completion before acknowledging and leaves takeover usable', async () => {
  const fixture = await harness();
  try {
    const computer = fixture.client('/synthetic/cancel');
    await computer.act('task', { action: 'open', url: 'https://example.com' });
    const entered = deferred();
    const aborted = deferred();
    const drain = deferred();
    const instance = fixture.instance('/synthetic/cancel');
    instance.setAct(async (_id, _input, signal) => {
      signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
      entered.resolve();
      await drain.promise;
      return { text: 'Finished', url: 'https://example.com', candidates: [] };
    });
    const controller = new AbortController();
    let settled = false;
    const pending = computer.act('task', { action: 'snapshot' }, controller.signal);
    const checked = assert.rejects(pending, /cancelled/).finally(() => {
      settled = true;
    });
    await entered.promise;
    controller.abort();
    await aborted.promise;
    await delay(10);
    assert.equal(settled, false);
    drain.resolve();
    await checked;
    await computer.takeControl?.('task');
    assert.equal(instance.calls.at(-1)?.method, 'takeControl');
  } finally {
    await fixture.close();
  }
});

test('each application namespace retains its own worker and disposal drains only that namespace', async () => {
  const fixture = await harness();
  try {
    const first = fixture.client('/synthetic/first');
    const second = fixture.client('/synthetic/second');
    await Promise.all([
      first.act('same-task', { action: 'snapshot' }),
      second.act('same-task', { action: 'snapshot' }),
    ]);
    const one = fixture.instance('/synthetic/first');
    const two = fixture.instance('/synthetic/second');
    await first.dispose();
    assert.equal(one.calls.filter((call) => call.method === 'dispose').length, 1);
    assert.equal(
      two.calls.some((call) => call.method === 'dispose'),
      false,
    );
    await assert.rejects(first.act('same-task', { action: 'snapshot' }), /unavailable/);
    await second.act('same-task', { action: 'snapshot' });
  } finally {
    await fixture.close();
  }
});

test('typed browser failures survive the bridge while unexpected errors remain fixed', async () => {
  const fixture = await harness();
  try {
    const computer = fixture.client('/synthetic/errors');
    await computer.act('task', { action: 'snapshot' });
    const instance = fixture.instance('/synthetic/errors');
    instance.setAct(async () => {
      throw new BrowserActionError('browser_navigation_failed');
    });
    await assert.rejects(
      computer.act('task', { action: 'snapshot' }),
      (error) => error instanceof BrowserActionError && error.code === 'browser_navigation_failed',
    );
    instance.setAct(async () => {
      throw Object.assign(new Error('Synthetic private value'), { statusCode: 423 });
    });
    await assert.rejects(
      computer.act('task', { action: 'snapshot' }),
      (error) =>
        error instanceof Error &&
        'statusCode' in error &&
        error.statusCode === 423 &&
        !error.message.includes('private'),
    );
    instance.setAct(async () => {
      throw new Error('Synthetic secret detail');
    });
    await assert.rejects(
      computer.act('task', { action: 'snapshot' }),
      /workspace browser could not complete/,
    );
  } finally {
    await fixture.close();
  }
});

test('malformed methods and namespaces never reach a computer or filesystem path', async () => {
  const fixture = await harness();
  try {
    for (const request of [
      { id: randomUUID(), namespace: '../../private', method: 'status' },
      {
        id: randomUUID(),
        namespace: browserNamespace('/synthetic/invalid'),
        method: 'eval',
        input: 'private',
      },
      {
        id: randomUUID(),
        namespace: browserNamespace('/synthetic/invalid'),
        method: 'act',
        taskId: '../outside',
        input: { action: 'snapshot' },
      },
    ]) {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(fixture.socketPath);
        socket.on('error', reject);
        socket.on('close', resolve);
        socket.on('connect', () =>
          socket.write(JSON.stringify({ type: 'request', request }) + '\n'),
        );
      });
    }
    assert.equal(fixture.instances.size, 0);
    assert.throws(
      () => createContainerBrowserComputer({ dataRoot: '/synthetic', container: 'otto-workspace' }),
      /BROWSER_CONTAINER/,
    );
  } finally {
    await fixture.close();
  }
});

test('an unacknowledged cancellation fences new actions until namespace cleanup succeeds', async () => {
  const fixture = await harness();
  const drain = deferred();
  try {
    const computer = fixture.client('/synthetic/timeout', { drainTimeoutMs: 20 });
    await computer.act('task', { action: 'snapshot' });
    const entered = deferred();
    fixture.instance('/synthetic/timeout').setAct(async () => {
      entered.resolve();
      await drain.promise;
      return { text: 'Late', url: 'https://example.com', candidates: [] };
    });
    const controller = new AbortController();
    const cancelled = assert.rejects(
      computer.act('task', { action: 'snapshot' }, controller.signal),
      /did not finish safely/,
    );
    await entered.promise;
    controller.abort();
    await cancelled;
    await assert.rejects(computer.takeControl!('task'), /unavailable/);
    assert.match(computer.status(), /needs a restart/);
    drain.resolve();
    await computer.dispose();
  } finally {
    drain.resolve();
    await fixture.close();
  }
});

test('a slow page open can finish within its longer browser budget', async () => {
  const fixture = await harness();
  try {
    const computer = fixture.client('/synthetic/slow-open', {
      timeoutMs: 20,
      openTimeoutMs: 100,
    });
    await computer.act('task', { action: 'snapshot' });
    fixture.instance('/synthetic/slow-open').setAct(async (_id, input) => {
      await delay(50);
      return { text: 'Loaded page', url: input.url ?? 'https://example.com', candidates: [] };
    });
    const result = await computer.act('task', {
      action: 'open',
      url: 'https://example.com',
    });
    assert.equal(result.text, 'Loaded page');
    assert.doesNotMatch(computer.status(), /restart/);
  } finally {
    await fixture.close();
  }
});

test('a disconnected bridge aborts its request and namespace disposal waits for the remaining work', async () => {
  const fixture = await harness();
  const drain = deferred();
  try {
    const dataRoot = '/synthetic/disconnect';
    const computer = fixture.client(dataRoot);
    await computer.act('task', { action: 'snapshot' });
    const entered = deferred();
    const aborted = deferred();
    const instance = fixture.instance(dataRoot);
    instance.setAct(async (_id, _input, signal) => {
      signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
      entered.resolve();
      await drain.promise;
      return { text: 'Late', url: 'https://example.com', candidates: [] };
    });
    const socket = connect(fixture.socketPath);
    socket.on('error', () => {});
    socket.write(
      JSON.stringify({
        type: 'request',
        request: {
          id: randomUUID(),
          namespace: browserNamespace(dataRoot),
          method: 'act',
          taskId: 'task',
          input: { action: 'snapshot' },
        },
      }) + '\n',
    );
    await entered.promise;
    socket.destroy();
    await aborted.promise;
    let disposed = false;
    const pending = computer.dispose().then(() => {
      disposed = true;
    });
    await delay(10);
    assert.equal(disposed, false);
    assert.equal(
      instance.calls.some((call) => call.method === 'dispose'),
      false,
    );
    drain.resolve();
    await pending;
    assert.equal(instance.calls.filter((call) => call.method === 'dispose').length, 1);
  } finally {
    drain.resolve();
    await fixture.close();
  }
});

test('a duplicate request cannot remove another request from the namespace drain fence', async () => {
  const fixture = await harness();
  const drain = deferred();
  try {
    const dataRoot = '/synthetic/duplicate';
    const computer = fixture.client(dataRoot);
    await computer.act('task', { action: 'snapshot' });
    const entered = deferred();
    const instance = fixture.instance(dataRoot);
    instance.setAct(async () => {
      entered.resolve();
      await drain.promise;
      return { text: 'Late', url: 'https://example.com', candidates: [] };
    });
    const request = {
      type: 'request',
      request: {
        id: randomUUID(),
        namespace: browserNamespace(dataRoot),
        method: 'act',
        taskId: 'task',
        input: { action: 'snapshot' },
      },
    };
    const first = connect(fixture.socketPath);
    first.on('error', () => {});
    first.resume();
    first.write(JSON.stringify(request) + '\n');
    await entered.promise;
    const duplicate = await new Promise<string>((resolve, reject) => {
      const socket = connect(fixture.socketPath);
      let output = '';
      socket.on('data', (chunk) => {
        output += chunk;
      });
      socket.on('error', reject);
      socket.on('end', () => resolve(output));
      socket.write(JSON.stringify(request) + '\n');
    });
    assert.equal(JSON.parse(duplicate).ok, false);
    let disposed = false;
    const pending = computer.dispose().then(() => {
      disposed = true;
    });
    await delay(10);
    assert.equal(disposed, false);
    drain.resolve();
    await pending;
    first.destroy();
  } finally {
    drain.resolve();
    await fixture.close();
  }
});

test('a restarted host cannot reuse a disconnected namespace until work and disposal both drain', async () => {
  const fixture = await harness();
  const drain = deferred();
  const cleaned = deferred();
  try {
    const dataRoot = '/synthetic/restarted';
    const original = fixture.client(dataRoot);
    await original.act('task', { action: 'snapshot' });
    const instance = fixture.instance(dataRoot);
    const entered = deferred();
    const aborted = deferred();
    const disposing = deferred();
    instance.setAct(async (_id, _input, signal) => {
      signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
      entered.resolve();
      await drain.promise;
      return { text: 'Late', url: 'https://example.com', candidates: [] };
    });
    instance.computer.dispose = async () => {
      instance.calls.push({ method: 'dispose' });
      disposing.resolve();
      await cleaned.promise;
    };
    const socket = connect(fixture.socketPath);
    socket.on('error', () => {});
    socket.write(
      JSON.stringify({
        type: 'request',
        request: {
          id: randomUUID(),
          namespace: browserNamespace(dataRoot),
          method: 'act',
          taskId: 'task',
          input: { action: 'snapshot' },
        },
      }) + '\n',
    );
    await entered.promise;
    socket.destroy();
    await aborted.promise;
    const restarted = fixture.client(dataRoot);
    await assert.rejects(restarted.act('new-task', { action: 'snapshot' }), /could not complete/);
    assert.equal(instance.calls.filter((call) => call.method === 'act').length, 2);
    drain.resolve();
    await disposing.promise;
    await assert.rejects(restarted.takeControl!('task'), /could not complete/);
    const finished = original.dispose();
    cleaned.resolve();
    await finished;
    await restarted.act('new-task', { action: 'snapshot' });
    assert.notEqual(fixture.instance(dataRoot), instance);
    assert.equal(instance.calls.filter((call) => call.method === 'dispose').length, 1);
  } finally {
    drain.resolve();
    cleaned.resolve();
    await fixture.close();
  }
});

test('a later screenshot reaching the worker first cannot erase accepted browser activity', async () => {
  const release = deferred();
  const fixture = await harness({ beforeFirstBridge: release.promise });
  try {
    const computer = fixture.client('/synthetic/reordered-activity');
    const action = computer.act('new-task', { action: 'open', url: 'https://example.com' });
    await computer.screenshot('old-task');
    assert.equal(computer.currentSession?.()?.taskId, 'new-task');
    release.resolve();
    await action;
    assert.equal(computer.currentSession?.()?.taskId, 'new-task');
  } finally {
    release.resolve();
    await fixture.close();
  }
});

test('failed namespace cleanup stays fenced until an explicit disposal retry succeeds', async () => {
  const fixture = await harness();
  const release = deferred();
  try {
    const dataRoot = '/synthetic/cleanup-retry';
    const original = fixture.client(dataRoot);
    await original.act('task', { action: 'snapshot' });
    const instance = fixture.instance(dataRoot);
    let attempts = 0;
    instance.computer.dispose = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('synthetic close failure');
      await release.promise;
    };
    await assert.rejects(original.dispose(), /could not complete/);
    await assert.rejects(original.act('task', { action: 'snapshot' }), /unavailable/);
    const restarted = fixture.client(dataRoot);
    await assert.rejects(restarted.act('task', { action: 'snapshot' }), /could not complete/);
    const retry = original.dispose();
    await assert.rejects(restarted.act('task', { action: 'snapshot' }), /could not complete/);
    assert.equal(instance.calls.filter((call) => call.method === 'act').length, 1);
    release.resolve();
    await retry;
    assert.equal(attempts, 2);
    await restarted.act('task', { action: 'snapshot' });
    assert.notEqual(fixture.instance(dataRoot), instance);
  } finally {
    release.resolve();
    await fixture.close();
  }
});

test('dispose drains a first request that has not reached the worker before removing its namespace', async () => {
  const release = deferred();
  const fixture = await harness({ beforeFirstBridge: release.promise });
  try {
    const root = '/synthetic/delayed-first-request';
    const computer = fixture.client(root);
    const action = assert.rejects(
      computer.act('task', { action: 'open', url: 'https://example.com' }),
      /cancelled/,
    );
    let finished = false;
    const disposing = computer.dispose().then(() => {
      finished = true;
    });
    await delay(10);
    assert.equal(finished, false);
    release.resolve();
    await Promise.all([action, disposing]);
    assert.equal(
      fixture.instance(root).calls.filter((call) => call.method === 'dispose').length,
      1,
    );
    await assert.rejects(computer.act('task', { action: 'snapshot' }), /unavailable/);
  } finally {
    release.resolve();
    await fixture.close();
  }
});
