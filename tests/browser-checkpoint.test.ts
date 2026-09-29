import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import type { Computer } from '../src/ports/computer.ts';
import { startContainerBrowserWorker } from '../src/providers/container-browser/worker.ts';
import {
  browserRequest,
  browserResponse,
  type BrowserCall,
  type BrowserResponse,
} from '../src/providers/container-browser/protocol.ts';
import { createBrowserFixture } from './browser-fixture.ts';
import { stagedLoginBrowser } from './login-fixture.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function syntheticComputer(): Computer & { canCheckpoint?: () => boolean } {
  return {
    act: async () => ({ text: 'Synthetic page', url: 'https://example.test/', candidates: [] }),
    screenshot: async () => null,
    injectCredentials: async () => ({ status: 'submitted' }),
    inspectLogin: async () => ({
      origin: 'https://example.test',
      url: 'https://example.test/',
      fields: [],
      methods: [],
    }),
    selectLoginMethod: async () => {},
    hold: async () => {},
    close: async () => {},
    dispose: async () => {},
    status: () => 'Synthetic browser',
    canCheckpoint: () => true,
  };
}

async function workerFixture(createComputer: () => Computer | Promise<Computer>) {
  const directory = await mkdtemp('/tmp/sk-quiesce-');
  const socketPath = join(directory, 'control.sock');
  const worker = await startContainerBrowserWorker({
    socketPath,
    dataRoot: directory,
    createComputer,
  });
  const namespace = 'sk-' + 'a'.repeat(24);
  const request = (call: BrowserCall) =>
    new Promise<BrowserResponse>((resolve, reject) => {
      const socket = connect(socketPath);
      let output = '';
      socket.setEncoding('utf8');
      socket.setTimeout(5000, () => socket.destroy(new Error('Synthetic request timed out.')));
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(
          JSON.stringify({
            type: 'request',
            request: { ...call, id: randomUUID(), namespace },
          }) + '\n',
        );
      });
      socket.on('data', (chunk) => {
        output += chunk;
      });
      socket.once('end', () => {
        try {
          resolve(browserResponse.parse(JSON.parse(output)));
        } catch (error) {
          reject(error);
        }
      });
    });
  return {
    request,
    async close() {
      await worker.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function result(response: BrowserResponse) {
  assert.equal(response.ok, true);
  return response.ok ? response.result : undefined;
}

test('private quiesce accepts no task, leaves absent namespaces absent and requires explicit capability', async () => {
  let creations = 0;
  let disposals = 0;
  const computer = syntheticComputer();
  delete computer.canCheckpoint;
  computer.dispose = async () => {
    disposals++;
  };
  const f = await workerFixture(() => {
    creations++;
    return computer;
  });
  try {
    assert.equal(
      browserRequest.safeParse({
        id: randomUUID(),
        namespace: 'sk-' + 'a'.repeat(24),
        method: 'quiesce',
        threadId: 'task',
      }).success,
      false,
    );
    assert.equal(result(await f.request({ method: 'quiesce' })), true);
    assert.equal(creations, 0);
    result(await f.request({ method: 'status' }));
    assert.equal(result(await f.request({ method: 'quiesce' })), false);
    assert.equal(disposals, 0);
    assert.equal(creations, 1);
    computer.canCheckpoint = () => false;
    assert.equal(result(await f.request({ method: 'quiesce' })), false);
    assert.equal(disposals, 0);
    computer.canCheckpoint = () => true;
    assert.equal(result(await f.request({ method: 'quiesce' })), true);
    assert.equal(disposals, 1);
  } finally {
    await f.close();
  }
});

test('quiesce refuses a pending request without aborting or querying its browser', async () => {
  const entered = deferred();
  const release = deferred();
  const computer = syntheticComputer();
  let checks = 0;
  let disposals = 0;
  let aborted = false;
  computer.canCheckpoint = () => {
    checks++;
    return true;
  };
  computer.act = async (_id, _input, signal) => {
    signal?.addEventListener('abort', () => {
      aborted = true;
    });
    entered.resolve();
    await release.promise;
    return { text: 'Finished', url: 'https://example.test/', candidates: [] };
  };
  computer.dispose = async () => {
    disposals++;
  };
  const f = await workerFixture(() => computer);
  const active = f.request({ method: 'act', threadId: 'task', input: { action: 'snapshot' } });
  try {
    await entered.promise;
    assert.equal(result(await f.request({ method: 'quiesce' })), false);
    assert.equal(checks, 0);
    assert.equal(disposals, 0);
    assert.equal(aborted, false);
    release.resolve();
    result(await active);
    assert.equal(result(await f.request({ method: 'quiesce' })), true);
    assert.equal(disposals, 1);
  } finally {
    release.resolve();
    await active;
    await f.close();
  }
});

test('quiesce fences new calls until disposal finishes and then allows a fresh namespace', async () => {
  const entered = deferred();
  const release = deferred();
  let creations = 0;
  let disposals = 0;
  let actions = 0;
  const f = await workerFixture(() => {
    creations++;
    const computer = syntheticComputer();
    computer.act = async () => {
      actions++;
      return { text: 'Page', url: 'https://example.test/', candidates: [] };
    };
    computer.dispose = async () => {
      disposals++;
      entered.resolve();
      await release.promise;
    };
    return computer;
  });
  try {
    result(await f.request({ method: 'status' }));
    const quiescing = f.request({ method: 'quiesce' });
    await entered.promise;
    const rejected = await f.request({
      method: 'act',
      threadId: 'task',
      input: { action: 'snapshot' },
    });
    assert.equal(rejected.ok, false);
    assert.equal(result(await f.request({ method: 'quiesce' })), false);
    assert.equal(actions, 0);
    assert.equal(creations, 1);
    release.resolve();
    assert.equal(result(await quiescing), true);
    assert.equal(disposals, 1);
    result(await f.request({ method: 'act', threadId: 'task', input: { action: 'snapshot' } }));
    assert.equal(creations, 2);
    assert.equal(actions, 1);
  } finally {
    release.resolve();
    await f.close();
  }
});

test('failed quiescence remains quarantined until explicit disposal succeeds', async () => {
  const computer = syntheticComputer();
  let disposals = 0;
  let creations = 0;
  computer.dispose = async () => {
    if (++disposals === 1) throw new Error('Synthetic private disposal failure');
  };
  const f = await workerFixture(() => {
    creations++;
    return computer;
  });
  try {
    result(await f.request({ method: 'status' }));
    const rejected = await f.request({ method: 'quiesce' });
    assert.equal(rejected.ok, false);
    assert.doesNotMatch(JSON.stringify(rejected), /private disposal/);
    assert.equal((await f.request({ method: 'status' })).ok, false);
    assert.equal(result(await f.request({ method: 'quiesce' })), false);
    assert.equal(disposals, 1);
    assert.equal(creations, 1);
    result(await f.request({ method: 'dispose' }));
    assert.equal(disposals, 2);
    result(await f.request({ method: 'status' }));
    assert.equal(creations, 2);
  } finally {
    await f.close();
  }
});

test('a throwing checkpoint capability cannot reopen its quarantined namespace', async () => {
  const computer = syntheticComputer();
  computer.canCheckpoint = () => {
    throw new Error('Synthetic private state failure');
  };
  const f = await workerFixture(() => computer);
  try {
    result(await f.request({ method: 'status' }));
    assert.equal((await f.request({ method: 'quiesce' })).ok, false);
    assert.equal((await f.request({ method: 'status' })).ok, false);
    assert.equal(result(await f.request({ method: 'quiesce' })), false);
    result(await f.request({ method: 'dispose' }));
  } finally {
    await f.close();
  }
});

async function browserFixture() {
  const directory = await mkdtemp('/tmp/sk-checkpoint-browser-');
  const browser = stagedLoginBrowser();
  const commands: string[][] = [];
  let before = async (_command: string[]) => {};
  let starting = async () => {};
  let nativeClosed = true;
  const computer = createBrowserFixture({
    dataRoot: directory,
    manualTimeoutMs: 60_000,
    run: async (executable, args, options) => {
      const command = args.slice(args.indexOf('--idle-timeout') + 2);
      commands.push(command);
      await before(command);
      return browser.run(executable, args, options);
    },
    resolveSignInBrowser: async () => '/fixture/chromium',
    signInLauncher: {
      async start() {
        await starting();
        nativeClosed = false;
        const exited = deferred();
        return {
          get closed() {
            return nativeClosed;
          },
          exited: exited.promise,
          async close() {
            nativeClosed = true;
            exited.resolve();
          },
        };
      },
    },
  });
  return {
    computer,
    commands,
    directory,
    open: () => computer.act('task', { action: 'open', url: 'https://1.1.1.1/login' }),
    before(value: typeof before) {
      before = value;
    },
    starting(value: typeof starting) {
      starting = value;
    },
    async close() {
      before = async () => {};
      starting = async () => {};
      await computer.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('checkpoint status stays false during browser startup and queued actions', async () => {
  const f = await browserFixture();
  const entered = deferred();
  const release = deferred();
  f.before(async (command) => {
    if (command[0] === 'open') {
      entered.resolve();
      await release.promise;
    }
  });
  const opening = f.open();
  try {
    assert.equal(f.computer.canCheckpoint(), false);
    await entered.promise;
    assert.equal(f.computer.canCheckpoint(), false);
    const queued = f.computer.act('task', { action: 'snapshot' });
    assert.equal(f.computer.canCheckpoint(), false);
    release.resolve();
    await Promise.all([opening, queued]);
    assert.equal(f.computer.canCheckpoint(), true);
    const calls = f.commands.length;
    assert.equal(f.computer.canCheckpoint(), true);
    assert.equal(f.commands.length, calls);
  } finally {
    release.resolve();
    await opening;
    await f.close();
  }
});

test('checkpoint status respects timed holds and manual leases without changing either', async (t) => {
  const f = await browserFixture();
  const now = Date.now;
  try {
    await f.open();
    await f.computer.hold('task', now() + 60_000);
    assert.equal(f.computer.canCheckpoint(), false);
    const beforeHoldCheck = f.commands.length;
    t.mock.method(Date, 'now', () => now() + 61_000);
    assert.equal(f.computer.canCheckpoint(), true);
    assert.equal(f.commands.length, beforeHoldCheck);
    t.mock.restoreAll();
    assert.equal(f.computer.canCheckpoint(), false);
    await f.computer.hold('task', null);
    await f.computer.takeControl!('task');
    assert.equal(f.computer.canCheckpoint(), false);
    const beforeManualCheck = f.commands.length;
    t.mock.method(Date, 'now', () => now() + 61_000);
    assert.equal(f.computer.canCheckpoint(), true);
    assert.equal(f.commands.length, beforeManualCheck);
    t.mock.restoreAll();
    assert.equal(f.computer.canCheckpoint(), false);
    await f.computer.releaseControl!('task');
    assert.equal(f.computer.canCheckpoint(), true);
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test('checkpoint status blocks credential injection until the private call finishes', async () => {
  const f = await browserFixture();
  const entered = deferred();
  const release = deferred();
  try {
    await f.open();
    f.before(async (command) => {
      if (command[0] === 'eval') {
        entered.resolve();
        await release.promise;
      }
    });
    const injecting = f.computer.injectCredentials({
      threadId: 'task',
      origin: 'https://1.1.1.1',
      kind: 'identifier',
      username: 'synthetic@example.test',
      usernameSelector: 'input',
    });
    assert.equal(f.computer.canCheckpoint(), false);
    await entered.promise;
    assert.equal(f.computer.canCheckpoint(), false);
    release.resolve();
    assert.deepEqual(await injecting, { status: 'submitted' });
    assert.equal(f.computer.canCheckpoint(), true);
  } finally {
    release.resolve();
    await f.close();
  }
});

test('native startup and open windows prevent checkpoints while a saved sign-in fence survives closure', async (t) => {
  const f = await browserFixture();
  const entered = deferred();
  const release = deferred();
  const now = Date.now;
  try {
    await f.open();
    f.starting(async () => {
      entered.resolve();
      await release.promise;
    });
    const opening = f.computer.openSignIn!('task');
    assert.equal(f.computer.canCheckpoint(), false);
    await entered.promise;
    assert.equal(f.computer.canCheckpoint(), false);
    release.resolve();
    await opening;
    t.mock.method(Date, 'now', () => now() + 61_000);
    assert.equal(f.computer.canCheckpoint(), false);
    t.mock.restoreAll();
    await f.computer.releaseControl!('task');
    assert.equal(f.computer.canCheckpoint(), true);
    const path = join(f.directory, 'runtime/screen-task.json');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).signInPending, true);
    await f.computer.dispose();
    assert.equal(JSON.parse(await readFile(path, 'utf8')).signInPending, true);
    assert.equal(f.computer.canCheckpoint(), false);
  } finally {
    t.mock.restoreAll();
    release.resolve();
    await f.close();
  }
});
