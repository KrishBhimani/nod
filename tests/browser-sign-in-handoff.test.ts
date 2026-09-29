import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { redactBrowserText } from '../src/providers/agent-browser/index.ts';
import { createBrowserFixture as createAgentBrowserComputer } from './browser-fixture.ts';
import { stagedLoginBrowser } from './login-fixture.ts';
import type { ManualBrowserInput } from '../src/ports/computer.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function handoff(
  options: {
    manualTimeoutMs?: number;
    idleTimeoutMs?: number;
    browserExecutable?: string;
    sandbox?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-sign-in-'));
  const fixture = stagedLoginBrowser();
  const events: string[] = [];
  const launches: Array<{
    profilePath: string;
    proxyUrl: string;
    url?: string;
    executablePath?: string;
  }> = [];
  const commands: string[][] = [];
  const forcedCloses: boolean[] = [];
  let opening = async () => {};
  let closing = async (_options?: { force?: boolean }) => {};
  let beforeCommand = async (_command: string[]) => {};
  let nativeExit = () => {};
  let closed = true;
  let screen = async (_signal?: AbortSignal) => Buffer.from('native-private-frame');
  let nativeInput = async (_value: ManualBrowserInput, _signal?: AbortSignal) => {};
  const run: typeof fixture.run = async (executable, args, input) => {
    commands.push(args);
    const command = args.slice(args.indexOf('--idle-timeout') + 2);
    events.push(command[0]);
    await beforeCommand(command);
    return fixture.run(executable, args, input);
  };
  const dependencies = {
    dataRoot: directory,
    run,
    ...options,
    resolveSignInBrowser: async () => '/fixture/chrome',
    signInLauncher: {
      async start(input: (typeof launches)[number]) {
        events.push('native-start');
        launches.push(input);
        await opening();
        closed = false;
        const exit = deferred();
        nativeExit = () => {
          closed = true;
          exit.resolve();
        };
        return {
          get closed() {
            return closed;
          },
          exited: exit.promise,
          screenshot: (signal?: AbortSignal) => screen(signal),
          control: (value: ManualBrowserInput, signal?: AbortSignal) => nativeInput(value, signal),
          async close(options?: { force?: boolean }) {
            events.push('native-close');
            forcedCloses.push(options?.force === true);
            await closing(options);
            closed = true;
            exit.resolve();
          },
        };
      },
    },
  };
  const computer = createAgentBrowserComputer(dependencies);
  await computer.act('fixture', {
    action: 'open',
    url: 'https://1.1.1.1/login?token=fixture-secret#private',
  });
  return {
    computer,
    directory,
    events,
    launches,
    commands,
    page: () => fixture.pages.get('fixture')!,
    forcedCloses,
    dependencies,
    screen(value: typeof screen) {
      screen = value;
    },
    input(value: typeof nativeInput) {
      nativeInput = value;
    },
    isClosed: () => closed,
    opening(value: typeof opening) {
      opening = value;
    },
    closing(value: typeof closing) {
      closing = value;
    },
    beforeCommand(value: typeof beforeCommand) {
      beforeCommand = value;
    },
    quitNative() {
      nativeExit();
    },
    async cleanup() {
      opening = async () => {};
      closing = async () => {};
      beforeCommand = async () => {};
      await computer.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('sign-in stops automation first, keeps the task profile and blocks observation and input', async () => {
  const fixture = await handoff();
  try {
    await fixture.computer.openSignIn!('fixture');
    assert.equal(fixture.events[fixture.events.indexOf('native-start') - 1], 'close');
    assert.equal(
      fixture.launches[0].profilePath,
      join(fixture.directory, 'runtime/profiles/fixture'),
    );
    assert.equal(fixture.launches[0].url, 'https://1.1.1.1/login');
    assert.equal(fixture.launches[0].executablePath, '/fixture/chrome');
    assert.match(fixture.launches[0].proxyUrl, /^http:\/\/127\.0\.0\.1:\d+/);
    const count = fixture.commands.length;
    await assert.rejects(fixture.computer.act('fixture', { action: 'snapshot' }), /paused/);
    await assert.rejects(
      fixture.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1' }),
      /paused/,
    );
    await assert.rejects(fixture.computer.screenshot('fixture'), /paused/);
    await assert.rejects(fixture.computer.inspectLogin('fixture'), /paused/);
    await assert.rejects(fixture.computer.takeControl!('fixture'), /paused/);
    await assert.rejects(
      fixture.computer.selectLoginMethod('fixture', 'https://1.1.1.1', 'oauth-google'),
      /paused/,
    );
    await assert.rejects(
      fixture.computer.injectCredentials({
        threadId: 'fixture',
        origin: 'https://1.1.1.1',
        kind: 'password',
        password: 'secret',
        passwordSelector: 'input',
      }),
      /paused/,
    );
    assert.equal(fixture.commands.length, count);
    const saved = await readFile(join(fixture.directory, 'runtime/screen-fixture.json'), 'utf8');
    assert.equal(JSON.parse(saved).signInPending, true);
    assert.equal(JSON.parse(saved).active, false);
    assert.equal(saved.includes('fixture-secret'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('container sign-in uses one fixed browser binary and exposes its display only through native methods', async () => {
  const fixture = await handoff({ browserExecutable: '/usr/bin/chromium', sandbox: false });
  const inputs: ManualBrowserInput[] = [];
  fixture.input(async (value) => {
    inputs.push(value);
  });
  try {
    await assert.rejects(fixture.computer.signInScreenshot!('fixture'), /no longer active/);
    await fixture.computer.openSignIn!('fixture');
    assert.equal(fixture.launches[0].executablePath, '/usr/bin/chromium');
    for (const command of fixture.commands.filter((args) => args.includes('--profile'))) {
      assert.equal(command[command.indexOf('--executable-path') + 1], '/usr/bin/chromium');
      assert.ok(command[command.indexOf('--args') + 1].split(',').includes('--no-sandbox'));
    }
    const frame = await fixture.computer.signInScreenshot!('fixture');
    assert.equal(frame?.toString(), 'native-private-frame');
    await fixture.computer.signInControl!('fixture', {
      action: 'type',
      text: 'native-fixture-secret',
    });
    assert.deepEqual(inputs, [{ action: 'type', text: 'native-fixture-secret' }]);
    await assert.rejects(fixture.computer.screenshot('fixture'), /paused/);
    await assert.rejects(fixture.computer.act('fixture', { action: 'snapshot' }), /paused/);
    await assert.rejects(fixture.computer.signInScreenshot!('foreign-task'), /no longer active/);
    const stored = await readFile(join(fixture.directory, 'runtime/screen-fixture.json'), 'utf8');
    assert.doesNotMatch(stored, /native-fixture-secret|native-private-frame/);
    await fixture.computer.finishSignIn!('fixture');
    await assert.rejects(fixture.computer.signInScreenshot!('fixture'), /no longer active/);
    await assert.rejects(
      fixture.computer.signInControl!('fixture', { action: 'press', key: 'Enter' }),
      /no longer active/,
    );
    const reopened = fixture.commands.filter((args) => args.includes('open')).at(-1)!;
    assert.equal(reopened[reopened.indexOf('--executable-path') + 1], '/usr/bin/chromium');
  } finally {
    await fixture.cleanup();
  }
});

test('native typing redacts completed values after resume without hiding unrelated text for each key', async () => {
  const f = await handoff();
  const identifier = 'synthetic-private@example.test';
  const password = 'private-synthetic-password';
  try {
    await f.computer.openSignIn!('fixture');
    for (const text of identifier)
      await f.computer.signInControl!('fixture', { action: 'type', text });
    await f.computer.signInControl!('fixture', { action: 'press', key: 'Tab' });
    for (const text of password)
      await f.computer.signInControl!('fixture', { action: 'type', text });
    await f.computer.finishSignIn!('fixture');
    f.page().echo.innerText = `Account preferences ${identifier} ${password}`;
    const result = await f.computer.act('fixture', { action: 'snapshot' });
    assert.match(result.text, /Account preferences/);
    assert.doesNotMatch(result.text, /synthetic-private@example.test|private-synthetic-password/);
    const stored = await readFile(join(f.directory, 'runtime/screen-fixture.json'), 'utf8');
    assert.doesNotMatch(stored, /synthetic-private@example.test|private-synthetic-password/);
  } finally {
    await f.cleanup();
  }
});

test('short or overlapping private values cannot recursively expand redaction markers', () => {
  assert.equal(redactBrowserText('redact', ['r', 'e', 'd', 'a', 'c', 't']), '[redacted]'.repeat(6));
  assert.equal(redactBrowserText('private-value', ['private', 'private-value']), '[redacted]');
});

test('failed native text retains redaction of the value entered before the failed extension', async () => {
  const f = await handoff();
  try {
    await f.computer.openSignIn!('fixture');
    await f.computer.signInControl!('fixture', { action: 'type', text: 'kept-private' });
    f.input(async () => {
      throw new Error('synthetic failure');
    });
    await assert.rejects(f.computer.signInControl!('fixture', { action: 'type', text: '-suffix' }));
    await f.computer.finishSignIn!('fixture');
    f.page().echo.innerText = 'kept-private';
    assert.equal(
      (await f.computer.act('fixture', { action: 'snapshot' })).text.includes('kept-private'),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test('native display cancellation aborts the active capture and rejects queued input before release', async () => {
  const fixture = await handoff();
  const begun = deferred();
  const finish = deferred();
  let signal: AbortSignal | undefined;
  let inputCount = 0;
  fixture.screen(async (value) => {
    signal = value;
    begun.resolve();
    await finish.promise;
    return Buffer.from('late-private-frame');
  });
  fixture.input(async () => {
    inputCount += 1;
  });
  try {
    await fixture.computer.openSignIn!('fixture');
    const capture = assert.rejects(
      fixture.computer.signInScreenshot!('fixture'),
      /no longer active/,
    );
    await begun.promise;
    const input = assert.rejects(
      fixture.computer.signInControl!('fixture', { action: 'press', key: 'Enter' }),
      /no longer active/,
    );
    const release = fixture.computer.releaseControl!('fixture');
    assert.equal(signal?.aborted, true);
    finish.resolve();
    await Promise.all([capture, input, release]);
    assert.equal(inputCount, 0);
    assert.equal(fixture.isClosed(), true);
    await assert.rejects(fixture.computer.screenshot('fixture'), /paused/);
  } finally {
    finish.resolve();
    await fixture.cleanup();
  }
});

test('a native display request forwards caller cancellation without releasing the sign-in lease', async () => {
  const fixture = await handoff();
  const begun = deferred();
  const finish = deferred();
  let signal: AbortSignal | undefined;
  fixture.screen(async (value) => {
    signal = value;
    begun.resolve();
    await finish.promise;
    return Buffer.from('cancelled-frame');
  });
  try {
    await fixture.computer.openSignIn!('fixture');
    const controller = new AbortController();
    const capture = assert.rejects(
      fixture.computer.signInScreenshot!('fixture', controller.signal),
    );
    await begun.promise;
    controller.abort();
    assert.equal(signal?.aborted, true);
    finish.resolve();
    await capture;
    assert.equal(fixture.isClosed(), false);
    fixture.screen(async () => Buffer.from('fresh-private-frame'));
    assert.equal(
      (await fixture.computer.signInScreenshot!('fixture'))?.toString(),
      'fresh-private-frame',
    );
  } finally {
    finish.resolve();
    await fixture.cleanup();
  }
});

test('explicit continuation waits for native exit and reopens the same profile and binary', async () => {
  const fixture = await handoff();
  const closing = deferred();
  try {
    await fixture.computer.openSignIn!('fixture');
    fixture.closing(() => closing.promise);
    const pending = fixture.computer.finishSignIn!('fixture');
    await delay(5);
    assert.equal(fixture.events.at(-1), 'native-close');
    await assert.rejects(fixture.computer.screenshot('fixture'), /paused/);
    closing.resolve();
    await pending;
    assert.deepEqual(fixture.forcedCloses, [false]);
    const resumed = fixture.commands.findLast((args) => args.includes('open'))!;
    assert.equal(resumed[resumed.indexOf('--profile') + 1], fixture.launches[0].profilePath);
    assert.equal(resumed[resumed.indexOf('--executable-path') + 1], '/fixture/chrome');
    assert.equal(resumed.at(-1), 'https://1.1.1.1/login');
    await fixture.computer.act('fixture', { action: 'snapshot' });
    assert.equal(fixture.isClosed(), true);
  } finally {
    closing.resolve();
    await fixture.cleanup();
  }
});

test('continuation stays paused when native sign-in cannot close gracefully', async () => {
  const fixture = await handoff();
  try {
    await fixture.computer.openSignIn!('fixture');
    fixture.closing(async ({ force = false } = {}) => {
      if (!force) throw new Error('Quit the sign-in browser before resuming the task.');
    });
    const count = fixture.commands.length;
    await assert.rejects(fixture.computer.finishSignIn!('fixture'), /Quit the sign-in browser/);
    assert.equal(fixture.isClosed(), false);
    assert.equal(fixture.commands.length, count);
    await assert.rejects(fixture.computer.screenshot('fixture'), /paused/);
    await assert.rejects(fixture.computer.act('fixture', { action: 'snapshot' }), /paused/);
    const saved = JSON.parse(
      await readFile(join(fixture.directory, 'runtime/screen-fixture.json'), 'utf8'),
    );
    assert.equal(saved.signInPending, true);
    assert.equal(saved.active, false);
    await fixture.computer.releaseControl!('fixture');
    assert.deepEqual(fixture.forcedCloses, [false, true]);
    assert.equal(fixture.isClosed(), true);
    assert.equal(fixture.commands.length, count);
  } finally {
    await fixture.cleanup();
  }
});

test('release and expiry close native sign-in without restarting automation', async () => {
  for (const expires of [false, true]) {
    const fixture = await handoff({ manualTimeoutMs: expires ? 15 : 10000 });
    try {
      await fixture.computer.openSignIn!('fixture');
      const count = fixture.commands.length;
      if (expires) await delay(40);
      else await fixture.computer.releaseControl!('fixture');
      assert.equal(fixture.isClosed(), true);
      assert.equal(fixture.commands.length, count);
      await assert.rejects(fixture.computer.act('fixture', { action: 'snapshot' }), /paused/);
      await fixture.computer.finishSignIn!('fixture');
      await fixture.computer.act('fixture', { action: 'snapshot' });
    } finally {
      await fixture.cleanup();
    }
  }
});

test('failed native launch stays paused and can be explicitly restored', async () => {
  const fixture = await handoff();
  try {
    fixture.opening(async () => {
      throw new Error('private launch failure');
    });
    await assert.rejects(fixture.computer.openSignIn!('fixture'), /sign-in window could not open/);
    await assert.rejects(fixture.computer.screenshot('fixture'), /paused/);
    await fixture.computer.finishSignIn!('fixture');
    await fixture.computer.act('fixture', { action: 'snapshot' });
  } finally {
    await fixture.cleanup();
  }
});

test('cancellation during native launch closes the late window without resuming', async () => {
  const fixture = await handoff();
  const opening = deferred();
  const started = deferred();
  try {
    fixture.opening(async () => {
      started.resolve();
      await opening.promise;
    });
    const pending = fixture.computer.openSignIn!('fixture');
    const rejected = assert.rejects(pending, /sign-in window could not open/);
    await started.promise;
    const closing = fixture.computer.close('fixture');
    opening.resolve();
    await Promise.all([rejected, closing]);
    assert.equal(fixture.isClosed(), true);
    assert.equal(fixture.events.filter((event) => event === 'open').length, 1);
  } finally {
    opening.resolve();
    await fixture.cleanup();
  }
});

test('restart keeps native sign-in hidden until explicit continuation', async () => {
  const fixture = await handoff();
  try {
    await fixture.computer.openSignIn!('fixture');
    await fixture.computer.dispose();
    const restored = createAgentBrowserComputer(fixture.dependencies);
    try {
      await assert.rejects(restored.screenshot('fixture'), /paused/);
      await assert.rejects(restored.act('fixture', { action: 'snapshot' }), /paused/);
      await restored.finishSignIn!('fixture');
      await restored.act('fixture', { action: 'snapshot' });
    } finally {
      await restored.dispose();
    }
  } finally {
    await fixture.cleanup();
  }
});

test('cancellation during automated restoration keeps sign-in paused and closes the restored browser', async () => {
  const fixture = await handoff();
  const reopening = deferred();
  const started = deferred();
  try {
    await fixture.computer.openSignIn!('fixture');
    fixture.beforeCommand(async (command) => {
      if (command[0] === 'open') {
        started.resolve();
        await reopening.promise;
      }
    });
    const pending = fixture.computer.finishSignIn!('fixture');
    const rejected = assert.rejects(pending, /Resume agent again|paused/);
    await started.promise;
    const closing = fixture.computer.close('fixture');
    reopening.resolve();
    await Promise.all([rejected, closing]);
    const saved = JSON.parse(
      await readFile(join(fixture.directory, 'runtime/screen-fixture.json'), 'utf8'),
    );
    assert.equal(saved.signInPending, true);
    assert.equal(saved.active, false);
    assert.equal(fixture.events.at(-1), 'close');
    await assert.rejects(fixture.computer.screenshot('fixture'), /paused/);
  } finally {
    reopening.resolve();
    await fixture.cleanup();
  }
});

test('native sign-in does not save or reopen a known credential in the return URL path', async () => {
  const fixture = await handoff();
  const secret = 'fixture private/identifier+value';
  const encoded = encodeURIComponent(secret);
  try {
    await fixture.computer.injectCredentials({
      threadId: 'fixture',
      origin: 'https://1.1.1.1',
      kind: 'identifier',
      username: secret,
      usernameSelector: 'input',
    });
    await fixture.computer.act('fixture', {
      action: 'open',
      url: `https://1.1.1.1/login/${encoded}?token=private-query#private-fragment`,
    });
    const saved = await readFile(join(fixture.directory, 'runtime/screen-fixture.json'), 'utf8');
    for (const value of [secret, encoded, 'private-query', 'private-fragment'])
      assert.equal(saved.includes(value), false);
    assert.equal(JSON.parse(saved).resumeUrl, 'https://1.1.1.1/');
    await fixture.computer.openSignIn!('fixture');
    assert.equal(fixture.launches[0].url, 'https://1.1.1.1/');
  } finally {
    await fixture.cleanup();
  }
});

test('crash recovery preserves the pause when native Chrome still owns the profile', async () => {
  const fixture = await handoff();
  let restored: ReturnType<typeof createAgentBrowserComputer> | undefined;
  try {
    await fixture.computer.openSignIn!('fixture');
    const count = fixture.commands.length;
    fixture.beforeCommand(async (command) => {
      if (command[0] === 'open' && !fixture.isClosed())
        throw new Error('private-profile-path: ProcessSingleton profile lock');
    });
    restored = createAgentBrowserComputer(fixture.dependencies);
    await assert.rejects(restored.screenshot('fixture'), /paused/);
    await assert.rejects(restored.act('fixture', { action: 'snapshot' }), /paused/);
    assert.equal(fixture.commands.length, count);
    await assert.rejects(restored.finishSignIn!('fixture'), (error: Error) => {
      assert.match(error.message, /Resume agent again/);
      assert.doesNotMatch(error.message, /private-profile-path|ProcessSingleton/);
      return true;
    });
    const saved = JSON.parse(
      await readFile(join(fixture.directory, 'runtime/screen-fixture.json'), 'utf8'),
    );
    assert.equal(saved.signInPending, true);
    assert.equal(saved.active, false);
    await assert.rejects(restored.screenshot('fixture'), /paused/);
    await assert.rejects(restored.inspectLogin('fixture'), /paused/);
    assert.equal(fixture.isClosed(), false);
    fixture.quitNative();
    await restored.finishSignIn!('fixture');
    await restored.act('fixture', { action: 'snapshot' });
    const continued = JSON.parse(
      await readFile(join(fixture.directory, 'runtime/screen-fixture.json'), 'utf8'),
    );
    assert.equal(continued.signInPending, false);
    assert.equal(continued.active, true);
  } finally {
    fixture.beforeCommand(async () => {});
    await restored?.dispose();
    await fixture.cleanup();
  }
});

test('a completed native sign-in keeps its session restoration after idle cleanup', async () => {
  const fixture = await handoff({ idleTimeoutMs: 80 });
  try {
    await fixture.computer.openSignIn!('fixture');
    await fixture.computer.finishSignIn!('fixture');
    const image = await fixture.computer.screenshot('fixture');
    const closedBefore = fixture.events.filter((event) => event === 'close').length;
    const metadataPath = join(fixture.directory, 'runtime/screen-fixture.json');
    const deadline = Date.now() + 2000;
    let saved = JSON.parse(await readFile(metadataPath, 'utf8'));
    while (saved.active && Date.now() < deadline) {
      await delay(5);
      saved = JSON.parse(await readFile(metadataPath, 'utf8'));
    }
    assert.equal(fixture.events.filter((event) => event === 'close').length, closedBefore + 1);
    assert.equal(saved.active, false);
    assert.equal(saved.restoreSession, true);
    assert.equal(saved.sensitive, true);
    assert.equal(saved.browserExecutable, undefined);
    const count = fixture.commands.length;
    assert.deepEqual(await fixture.computer.screenshot('fixture'), image);
    assert.equal(fixture.commands.length, count);
    await fixture.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/account' });
    const reopened = fixture.commands.findLast((args) => args.includes('open'))!;
    assert.match(reopened[reopened.indexOf('--args') + 1], /(?:^|,)--restore-last-session(?:,|$)/);
    assert.equal(reopened[reopened.indexOf('--executable-path') + 1], '/fixture/chrome');
    assert.equal(reopened[reopened.indexOf('--profile') + 1], fixture.launches[0].profilePath);
  } finally {
    await fixture.cleanup();
  }
});

test('a completed native sign-in restores session cookies only on explicit reopen after restart', async () => {
  const fixture = await handoff();
  let restored: ReturnType<typeof createAgentBrowserComputer> | undefined;
  const resolutions: string[] = [];
  try {
    await fixture.computer.openSignIn!('fixture');
    await fixture.computer.finishSignIn!('fixture');
    const image = await fixture.computer.screenshot('fixture');
    await fixture.computer.dispose();
    const count = fixture.commands.length;
    restored = createAgentBrowserComputer({
      ...fixture.dependencies,
      resolveSignInBrowser: async (profilePath) => {
        resolutions.push(profilePath);
        return '/fixture/chrome';
      },
    });
    assert.deepEqual(await restored.screenshot('fixture'), image);
    await assert.rejects(restored.inspectLogin('fixture'), /Open the login page/);
    assert.equal(fixture.commands.length, count);
    assert.deepEqual(resolutions, []);
    await restored.act('fixture', { action: 'open', url: 'https://1.1.1.1/account' });
    assert.deepEqual(resolutions, [fixture.launches[0].profilePath]);
    const reopened = fixture.commands.findLast((args) => args.includes('open'))!;
    assert.match(reopened[reopened.indexOf('--args') + 1], /(?:^|,)--restore-last-session(?:,|$)/);
    assert.equal(reopened[reopened.indexOf('--executable-path') + 1], '/fixture/chrome');
    assert.equal(reopened[reopened.indexOf('--profile') + 1], fixture.launches[0].profilePath);
    const saved = await readFile(join(fixture.directory, 'runtime/screen-fixture.json'), 'utf8');
    assert.equal(JSON.parse(saved).restoreSession, true);
    assert.equal(JSON.parse(saved).sensitive, true);
    assert.equal(saved.includes('/fixture/chrome'), false);
  } finally {
    await restored?.dispose();
    await fixture.cleanup();
  }
});

test('manual workspace control opens an isolated blank browser before any agent navigation', async () => {
  const f = await handoff();
  try {
    const current = f.computer.currentSession?.();
    const count = f.commands.length;
    await f.computer.openSignIn!('idle-workspace');
    assert.equal(f.commands.length, count);
    assert.equal(f.launches.at(-1)?.url, 'about:blank');
    assert.equal(
      f.launches.at(-1)?.profilePath,
      join(f.directory, 'runtime/profiles/idle-workspace'),
    );
    assert.deepEqual(f.computer.currentSession?.(), current);
    assert.equal(
      (await f.computer.signInScreenshot!('idle-workspace'))?.toString(),
      'native-private-frame',
    );
    await assert.rejects(f.computer.screenshot('idle-workspace'), /paused/);
    await f.computer.signInControl!('idle-workspace', { action: 'type', text: 'private fixture' });
    assert.deepEqual(f.computer.currentSession?.(), current);
    await f.computer.releaseControl!('idle-workspace');
    await f.computer.close('idle-workspace');
    assert.equal(f.isClosed(), true);
    const closed = JSON.parse(
      await readFile(join(f.directory, 'runtime/screen-idle-workspace.json'), 'utf8'),
    );
    assert.equal(closed.signInPending, false);
    assert.doesNotMatch(JSON.stringify(closed), /private fixture/);
    await f.computer.openSignIn!('idle-workspace');
    assert.equal(f.launches.at(-1)?.url, 'about:blank');
    assert.equal(f.commands.length, count);
  } finally {
    await f.cleanup();
  }
});

test('new native workspace windows respect the browser session capacity', async () => {
  const f = await handoff();
  try {
    await f.computer.hold('fixture', Date.now() + 60_000);
    for (const id of ['manual-one', 'manual-two', 'manual-three']) await f.computer.openSignIn!(id);
    await assert.rejects(f.computer.openSignIn!('manual-four'));
    assert.equal(f.launches.length, 3);
    assert.match(f.computer.status(), /^4 /);
  } finally {
    await f.cleanup();
  }
});

test('an abandoned blank native window releases its capacity when the lease expires without polling', async () => {
  const f = await handoff({ manualTimeoutMs: 20 });
  try {
    await f.computer.openSignIn!('idle-workspace');
    assert.match(f.computer.status(), /^2 /);
    await delay(60);
    assert.equal(f.isClosed(), true);
    assert.match(f.computer.status(), /^1 /);
    const saved = JSON.parse(
      await readFile(join(f.directory, 'runtime/screen-idle-workspace.json'), 'utf8'),
    );
    assert.equal(saved.signInPending, false);
    await assert.rejects(f.computer.signInScreenshot!('idle-workspace'));
  } finally {
    await f.cleanup();
  }
});
