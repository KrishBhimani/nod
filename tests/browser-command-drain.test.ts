import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import { containerBrowserOptions } from '../src/providers/container-browser/config.ts';
import { stagedLoginBrowser } from './login-fixture.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('container launches the package native CLI directly for both supported image architectures', () => {
  for (const architecture of ['arm64', 'x64'] as const) {
    const options = containerBrowserOptions('/data/synthetic-task', architecture);
    assert.equal(
      options.executable,
      `/app/node_modules/agent-browser/bin/agent-browser-linux-${architecture}`,
    );
    assert.equal(options.browserExecutable, '/usr/bin/chromium');
    assert.equal(options.platform, 'linux');
    assert.equal(options.dataRoot, '/data/synthetic-task');
    assert.equal(options.sandbox, false);
  }
  assert.throws(() => containerBrowserOptions('/data/synthetic-task', 'ia32'), /unsupported/);
});

test('cancellation remains pending until the accepted daemon operation is closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-browser-drain-'));
  const fixture = stagedLoginBrowser();
  const started = deferred();
  const closing = deferred();
  const release = deferred();
  const controller = new AbortController();
  let interrupted = false;
  let failOpen = true;
  const commands: string[] = [];
  const computer = createAgentBrowserComputer({
    dataRoot: directory,
    run: async (executable, args, options) => {
      const action = args[args.indexOf('--idle-timeout') + 2];
      commands.push(action);
      if (action === 'open' && failOpen) {
        failOpen = false;
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('Task cancelled.')), {
            once: true,
          });
        });
      }
      if (action === 'close' && controller.signal.aborted && !interrupted) {
        assert.equal(options?.signal, undefined);
        closing.resolve();
        await release.promise;
      }
      return fixture.run(executable, args, options);
    },
  });
  try {
    const operation = computer.act(
      'fixture',
      { action: 'open', url: 'https://1.1.1.1/login' },
      controller.signal,
    );
    const rejected = assert.rejects(operation, /cancelled/).then(() => {
      interrupted = true;
    });
    await started.promise;
    controller.abort();
    await closing.promise;
    assert.equal(interrupted, false);
    const queued = assert.rejects(computer.act('fixture', { action: 'snapshot' }), /expired/);
    assert.deepEqual(commands, ['open', 'close']);
    release.resolve();
    await Promise.all([rejected, queued]);
    assert.equal(interrupted, true);
    const reopened = await computer.act('fixture', {
      action: 'open',
      url: 'https://1.1.1.1/login',
    });
    assert.equal(reopened.url, 'https://1.1.1.1/login');
  } finally {
    release.resolve();
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed interruption cleanup blocks later actions until an explicit close succeeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-browser-drain-failure-'));
  const fixture = stagedLoginBrowser();
  const commands: string[] = [];
  let failClose = true;
  const computer = createAgentBrowserComputer({
    dataRoot: directory,
    run: async (executable, args, options) => {
      const action = args[args.indexOf('--idle-timeout') + 2];
      commands.push(action);
      if (action === 'open' && failClose)
        throw new Error('Runtime command exceeded its time limit.');
      if (action === 'close' && failClose) throw new Error('Synthetic close unavailable.');
      return fixture.run(executable, args, options);
    },
  });
  try {
    await assert.rejects(
      computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' }),
      /could not stop safely/,
    );
    const count = commands.length;
    await assert.rejects(computer.act('fixture', { action: 'snapshot' }), /expired/);
    await assert.rejects(
      computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' }),
      /expired/,
    );
    assert.equal(commands.length, count);
    failClose = false;
    await computer.close('fixture');
    const reopened = await computer.act('fixture', {
      action: 'open',
      url: 'https://1.1.1.1/login',
    });
    assert.equal(reopened.url, 'https://1.1.1.1/login');
  } finally {
    failClose = false;
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
