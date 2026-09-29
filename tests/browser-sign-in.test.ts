import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Fastify from 'fastify';
import pg, { type Pool } from 'pg';
import { z } from 'zod';
import type {
  Computer,
  CredentialInput,
  LoginInspection,
  ManualBrowserInput,
} from '../src/ports/computer.ts';
import { browserSessionId } from '../src/providers/agent-browser/index.ts';
import { createBrowserSignIn } from '../src/providers/agent-browser/sign-in.ts';
import { registerLocalAccess } from '../src/server/access.ts';
import { createBrowserConnections } from '../src/server/browser-connections.ts';
import { createTakeover } from '../src/server/takeover.ts';
import { createBrowserFixture as createAgentBrowserComputer } from './browser-fixture.ts';
import { stagedLoginBrowser } from './login-fixture.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Native sign-in browser process and profile boundaries

function createLauncher(options: Parameters<typeof createBrowserSignIn>[0] = {}) {
  return createBrowserSignIn({
    desktop: async () => {
      let finish!: () => void;
      return {
        environment: { DISPLAY: ':123', XAUTHORITY: '/fixture/private-authority' },
        exited: new Promise<void>((resolve) => {
          finish = resolve;
        }),
        screenshot: async () => Buffer.from('private-desktop'),
        control: async () => {},
        close: async () => {
          finish();
        },
      };
    },
    ...options,
  });
}

async function profileFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sk-sign-in-'));
  const profilePath = join(directory, 'runtime', 'profiles', 'test-task');
  const browsersDirectory = join(directory, 'browsers');
  await mkdir(profilePath, { recursive: true });
  await writeFile(join(profilePath, 'Last Version'), '154.0.8037.57');
  const executablePath = join(browsersDirectory, 'chrome-154.0.8037.57', 'chrome');
  await mkdir(dirname(executablePath), { recursive: true });
  await writeFile(executablePath, '', { mode: 0o700 });
  return {
    directory,
    profilePath,
    browsersDirectory,
    executablePath,
    input: { profilePath, executablePath, proxyUrl: 'http://127.0.0.1:4311' },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function processFixture(
  options: {
    ignoreGraceful?: boolean;
    ignoreTerm?: boolean;
    neverClose?: boolean;
    exitEarly?: boolean;
  } = {},
) {
  const child = new EventEmitter();
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const calls: Array<{ executable: string; args: string[]; options: SpawnOptions }> = [];
  const process = Object.assign(child, {
    kill(signal?: NodeJS.Signals | number) {
      signals.push(signal);
      if (
        !options.neverClose &&
        !(options.ignoreGraceful && signal === 'SIGINT') &&
        !(options.ignoreTerm && signal === 'SIGTERM')
      )
        queueMicrotask(() => child.emit('close', 0, signal));
      return true;
    },
  }) as ChildProcess;
  return {
    child,
    signals,
    calls,
    spawn(executable: string, args: string[], launchOptions: SpawnOptions) {
      calls.push({ executable, args, options: launchOptions });
      if (options.exitEarly) queueMicrotask(() => child.emit('close', 1, null));
      return process;
    },
  };
}

test('native sign-in keeps the task profile, proxy and a key-free environment without browser automation', async () => {
  const f = await profileFixture();
  const process = processFixture();
  try {
    const launcher = createLauncher({ spawn: process.spawn, startupMs: 1 });
    const handle = await launcher.start({ ...f.input, url: 'https://example.com/sign-in' });
    const call = process.calls[0];
    assert.equal(call.executable, f.executablePath);
    assert.ok(call.args.includes(`--user-data-dir=${f.profilePath}`));
    assert.ok(call.args.includes('--proxy-server=http://127.0.0.1:4311'));
    assert.doesNotMatch(
      call.args.join(' '),
      /remote-debugging|headless|enable-automation|disable-blink|user-agent|no-sandbox|ignore-certificate/,
    );
    assert.equal(call.options.stdio, 'ignore');
    assert.equal(call.options.shell, false);
    assert.deepEqual(
      Object.keys(call.options.env ?? {}).filter((key) =>
        /KEY|TOKEN|PASSWORD|AGENT_BROWSER/.test(key),
      ),
      [],
    );
    assert.equal((await stat(f.profilePath)).mode & 0o777, 0o700);
    assert.equal(handle.closed, false);
    await Promise.all([handle.close(), handle.close()]);
    assert.equal(handle.closed, true);
    await handle.exited;
    assert.deepEqual(process.signals, ['SIGINT']);
  } finally {
    await f.cleanup();
  }
});

test('native sign-in refuses to release a profile whose process cannot close', async () => {
  const f = await profileFixture();
  const process = processFixture({ neverClose: true });
  try {
    const launcher = createLauncher({
      spawn: process.spawn,
      startupMs: 1,
      closeMs: 1,
      killMs: 1,
    });
    const handle = await launcher.start(f.input);
    await assert.rejects(handle.close(), /workspace sign-in browser.*clos/);
    await assert.rejects(handle.close(), /workspace sign-in browser.*clos/);
    assert.deepEqual(process.signals, ['SIGINT']);
    assert.equal(handle.closed, false);
    await assert.rejects(launcher.start(f.input), /already open/);
    process.child.emit('close', 0);
    await handle.close();
  } finally {
    await f.cleanup();
  }
});

test('native sign-in validates profile and proxy boundaries without echoing private input', async () => {
  const f = await profileFixture();
  const process = processFixture();
  try {
    const launcher = createLauncher({ spawn: process.spawn, startupMs: 1 });
    for (const change of [
      { profilePath: '/' },
      { profilePath: 'relative-profile' },
      { proxyUrl: 'http://example.com:4311' },
      { proxyUrl: 'http://secret:password@127.0.0.1:4311' },
      { proxyUrl: 'private-invalid-proxy' },
      { url: 'file:///private-secret' },
      { url: 'https://secret:password@example.com' },
      { url: 'private-invalid-url' },
    ]) {
      await assert.rejects(launcher.start({ ...f.input, ...change }), (error: Error) => {
        assert.doesNotMatch(error.message, /private-secret|private-invalid|secret:password/);
        return true;
      });
    }
    const linkedProfile = join(f.directory, 'linked-profile');
    await symlink(f.profilePath, linkedProfile);
    await assert.rejects(
      launcher.start({ ...f.input, profilePath: linkedProfile }),
      /could not start/,
    );
    assert.equal(process.calls.length, 0);
  } finally {
    await f.cleanup();
  }
});

// Sign-in handoff pauses automation and keeps typed values private

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

// Manual control locks agent entry points

async function withinDeadline<T>(pending: Promise<T>): Promise<T> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      pending,
      delay(5_000, undefined, { signal: timer.signal }).then(() => {
        throw new Error('Browser fixture operation timed out.');
      }),
    ]);
  } finally {
    timer.abort();
  }
}

async function manualFixture(options: { manualTimeoutMs?: number; idleTimeoutMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sk-manual-'));
  const browser = stagedLoginBrowser();
  const actions: Record<string, unknown>[] = [];
  const launches: string[][] = [];
  const sockets = new Set<Socket>();
  let before = async (_command: Record<string, unknown>) => {};
  const daemon = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    let buffered = '';
    socket.on('data', async (chunk) => {
      buffered += chunk.toString();
      if (!buffered.includes('\n')) return;
      const command = JSON.parse(buffered);
      buffered = '';
      actions.push(command);
      try {
        await before(command);
        if (socket.destroyed) return;
        const page = browser.pages.get('fixture')!;
        let data: Record<string, unknown> = {};
        if (command.action === 'url') data = { url: page.location.href };
        if (command.action === 'tab_list')
          data = { tabs: [{ tabId: 't1', active: true, url: page.location.href }] };
        if (command.action === 'evaluate') data = { result: await page.evaluate(command.script) };
        if (command.action === 'snapshot') data = { snapshot: page.text() };
        if (command.action === 'screenshot') await writeFile(command.path, page.screen());
        if (command.action === 'mouseup') page.focused = page.input;
        if (command.action === 'keyboard') {
          page.input.value += command.text;
          page.echo.innerText = page.input.value;
          page.input.onInput();
        }
        if (command.action === 'getattribute')
          data = {
            value: page.nodes(command.selector)[0]?.getAttribute(command.attribute) ?? null,
            lifecycle: { effectiveLaunch: { browserLaunched: true }, reused: true },
          };
        if (command.action === 'close') page.closed = true;
        socket.end(JSON.stringify({ success: true, data }) + '\n');
      } catch {
        socket.end(JSON.stringify({ success: false }) + '\n');
      }
    });
  });
  const socketPath = join(directory, `${browserSessionId('fixture')}.sock`);
  await new Promise<void>((resolve) => daemon.listen(socketPath, resolve));
  const run: typeof browser.run = async (executable, args, input) => {
    launches.push(args);
    if (args.includes('info'))
      return {
        stdout: JSON.stringify({
          success: true,
          data: {
            active: true,
            namespace: args[args.indexOf('--namespace') + 1],
            session: args[args.indexOf('--session') + 1],
            socketDir: directory,
          },
        }),
        stderr: '',
        exitCode: 0,
      };
    return browser.run(executable, args, input);
  };
  const computer = createAgentBrowserComputer({ dataRoot: directory, run, ...options }, true);
  await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
  return {
    computer,
    actions,
    launches,
    directory,
    run,
    page: () => browser.pages.get('fixture')!,
    before(value: typeof before) {
      before = value;
    },
    async cleanup() {
      before = async () => {};
      try {
        await withinDeadline(computer.dispose());
      } finally {
        for (const socket of sockets) socket.destroy();
        try {
          await withinDeadline(new Promise<void>((resolve) => daemon.close(() => resolve())));
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
  };
}

test('manual control masks typed data and locks every agent entry point', async () => {
  const f = await manualFixture();
  const secret = 'synthetic-manual-secret';
  try {
    await f.computer.takeControl!('fixture');
    await assert.rejects(f.computer.act('fixture', { action: 'snapshot' }), /paused/);
    await assert.rejects(
      f.computer.download!('fixture', { url: 'https://1.1.1.1/file.pdf' }),
      /paused/,
    );
    await assert.rejects(f.computer.inspectLogin('fixture'), /paused/);
    await assert.rejects(
      f.computer.selectLoginMethod('fixture', 'https://1.1.1.1', 'oauth-google'),
      /paused/,
    );
    await assert.rejects(
      f.computer.injectCredentials({
        threadId: 'fixture',
        origin: 'https://1.1.1.1',
        passwordSelector: '#password',
        password: secret,
      }),
      /paused/,
    );
    await assert.rejects(
      f.computer.control!('fixture', { action: 'type', text: secret }),
      /Click a text field/,
    );
    assert.equal(
      f.actions.some((action) => action.action === 'keyboard'),
      false,
    );
    await f.computer.control!('fixture', { action: 'click', x: 1, y: 0.5 });
    await f.computer.control!('fixture', { action: 'type', text: secret });
    assert.equal(f.actions.find((action) => action.action === 'keyboard')?.subaction, 'insertText');
    assert.equal(f.actions.find((action) => action.action === 'keyboard')?.text, secret);
    assert.equal(JSON.stringify(f.launches).includes(secret), false);
    assert.equal((await f.computer.screenshot('fixture'))?.includes(Buffer.from(secret)), false);
    assert.equal(
      (await readFile(join(f.directory, 'runtime/screen-fixture.json'), 'utf8')).includes(secret),
      false,
    );
    await f.computer.releaseControl!('fixture');
    f.page().input.autocomplete = 'off';
    await assert.rejects(
      f.computer.act('fixture', { action: 'fill', selector: 'input', text: 'unsafe replacement' }),
      /secure credential/,
    );
    assert.equal(
      (await f.computer.act('fixture', { action: 'snapshot' })).text.includes(secret),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test('release and cancellation invalidate queued manual clicks before mouse down', async (t) => {
  for (const operation of ['release', 'close'] as const)
    await t.test(operation, async () => {
      const f = await manualFixture();
      const started = deferred();
      const drain = deferred();
      try {
        await f.computer.takeControl!('fixture');
        f.before(async (command) => {
          if (command.action === 'mousemove') {
            started.resolve();
            await drain.promise;
          }
        });
        const first = assert.rejects(
          f.computer.control!('fixture', { action: 'click', x: 0.5, y: 0.5 }),
        );
        await started.promise;
        const second = assert.rejects(
          f.computer.control!('fixture', { action: 'press', key: 'Enter' }),
        );
        const stopped =
          operation === 'release'
            ? f.computer.releaseControl!('fixture')
            : f.computer.close('fixture');
        await Promise.all([first, second, stopped]);
        assert.equal(
          f.actions.some((action) => action.action === 'mousedown' || action.action === 'press'),
          false,
        );
      } finally {
        drain.resolve();
        await f.cleanup();
      }
    });
});

// Takeover routes: drain, reset and private frames

const idle = (signInAvailable: boolean) => ({
  paused: false,
  active: false,
  mode: null,
  signInAvailable,
  resumable: false,
});

async function takeoverFixture(options: { signIn?: boolean } = {}) {
  let thread: { id: string; owner: string; status: string } | undefined = {
    id: randomUUID(),
    owner: 'owner',
    status: 'running',
  };
  const opened: string[] = [];
  const calls: string[] = [];
  let enabled = true;
  let failAcquire = false;
  let failRelease = false;
  let failResume = false;
  let failSignIn = false;
  let failFinish = false;
  let failFrame = false;
  let resumed = 0;
  let drain = Promise.resolve();
  let inputWait = Promise.resolve();
  let releaseWait = Promise.resolve();
  let signInWait = Promise.resolve();
  let finishWait = Promise.resolve();
  let frameWait = Promise.resolve();
  const drainEntered = deferred();
  const inputEntered = deferred();
  const releaseEntered = deferred();
  const signInEntered = deferred();
  const finishEntered = deferred();
  const frameEntered = deferred();
  const pool = {
    query: async (_query: string, values: unknown[]) => ({
      rows: thread && thread.owner === values[0] ? [{ id: thread.id, status: thread.status }] : [],
    }),
  } as unknown as Pool;
  const app = Fastify({ logger: false });
  registerLocalAccess(app, 4310);
  app.setErrorHandler((error, _request, reply) => {
    const known = error as Error & { statusCode?: number };
    reply
      .code(error instanceof z.ZodError ? 400 : (known.statusCode ?? 500))
      .send({ error: known.message });
  });
  createTakeover({
    pool,
    ownerId: 'owner',
    enabled: () => enabled,
    computer: {
      ...(options.signIn
        ? {
            openSignIn: async (id: string) => {
              calls.push('sign-in');
              opened.push(id);
              signInEntered.resolve();
              await signInWait;
              if (failSignIn) throw new Error('private sign-in failure');
            },
            signInScreenshot: async () => {
              calls.push('sign-in-frame');
              frameEntered.resolve();
              await frameWait;
              if (failFrame) throw new Error('private frame failure');
              return Buffer.from('synthetic-private-frame');
            },
            signInControl: async () => {
              calls.push('sign-in-input');
              inputEntered.resolve();
              await inputWait;
            },
            finishSignIn: async () => {
              calls.push('finish');
              finishEntered.resolve();
              await finishWait;
              if (failFinish) throw new Error('private finish failure');
            },
          }
        : {}),
      takeControl: async (id: string) => {
        calls.push('acquire');
        opened.push(id);
        if (failAcquire) throw new Error('private browser failure');
      },
      control: async () => {
        calls.push('input');
        inputEntered.resolve();
        await inputWait;
      },
      releaseControl: async () => {
        calls.push('release');
        releaseEntered.resolve();
        await releaseWait;
        if (failRelease) throw new Error('private release failure');
      },
    },
    pause: async () => {
      calls.push('pause');
      thread ??= { id: randomUUID(), owner: 'owner', status: 'idle' };
      thread.status = 'manual_control';
      return { threadId: thread.id };
    },
    resume: async () => {
      calls.push('resume');
      if (failResume || thread?.status !== 'manual_control')
        throw Object.assign(new Error('Resume failed.'), { statusCode: 409 });
      thread.status = 'idle';
      resumed++;
      return { ok: true };
    },
    waitForThread: async () => {
      calls.push('drain');
      drainEntered.resolve();
      await drain;
    },
  }).registerRoutes(app);
  const request = (suffix: string, body?: unknown, core = false) =>
    app.inject({
      method: body === undefined ? 'GET' : 'POST',
      url: `/api/${core ? 'browser' : 'inspector'}/control${suffix}`,
      headers: { host: 'localhost:4310' },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  return {
    app,
    calls,
    opened,
    request,
    coreRequest: (suffix: string, body?: unknown) => request(suffix, body, true),
    thread: () => thread,
    reset: () => {
      thread = { id: randomUUID(), owner: 'owner', status: 'idle' };
    },
    remove: () => {
      thread = undefined;
    },
    resumed: () => resumed,
    frameEntered: frameEntered.promise,
    drainEntered: drainEntered.promise,
    inputEntered: inputEntered.promise,
    releaseEntered: releaseEntered.promise,
    signInEntered: signInEntered.promise,
    finishEntered: finishEntered.promise,
    setFrame: (value: Promise<void>) => {
      frameWait = value;
    },
    setFrameFailure: (value: boolean) => {
      failFrame = value;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setAcquireFailure: (value: boolean) => {
      failAcquire = value;
    },
    setReleaseFailure: (value: boolean) => {
      failRelease = value;
    },
    setResumeFailure: (value: boolean) => {
      failResume = value;
    },
    setSignInFailure: (value: boolean) => {
      failSignIn = value;
    },
    setFinishFailure: (value: boolean) => {
      failFinish = value;
    },
    setDrain: (value: Promise<void>) => {
      drain = value;
    },
    setInput: (value: Promise<void>) => {
      inputWait = value;
    },
    setRelease: (value: Promise<void>) => {
      releaseWait = value;
    },
    setSignIn: (value: Promise<void>) => {
      signInWait = value;
    },
    setFinish: (value: Promise<void>) => {
      finishWait = value;
    },
  };
}

test('takeover drains agent work before acquiring and serializes input before resume', async () => {
  const f = await takeoverFixture();
  try {
    const drain = deferred();
    f.setDrain(drain.promise);
    const start = f.request('/start', {});
    await f.drainEntered;
    assert.deepEqual(f.calls, ['pause', 'drain']);
    drain.resolve();
    const started = await start;
    assert.equal(started.statusCode, 200);
    assert.deepEqual(started.json(), { mode: 'manual', resumable: true });
    assert.deepEqual(f.opened, [f.thread()!.id]);
    assert.deepEqual((await f.request('')).json(), {
      paused: true,
      active: true,
      mode: 'manual',
      signInAvailable: false,
      resumable: true,
    });
    const input = deferred();
    f.setInput(input.promise);
    const typing = f.request('/input', { input: { action: 'type', text: 'synthetic secret' } });
    const resume = f.request('/resume', {});
    await f.inputEntered;
    assert.deepEqual(f.calls, ['pause', 'drain', 'acquire', 'input']);
    input.resolve();
    assert.equal((await typing).statusCode, 200);
    assert.equal((await resume).statusCode, 200);
    assert.deepEqual(f.calls, ['pause', 'drain', 'acquire', 'input', 'release', 'resume']);
    assert.equal(f.resumed(), 1);
    assert.deepEqual((await f.request('')).json(), idle(false));
    assert.equal(
      (await f.request('/input', { input: { action: 'press', key: 'Enter' } })).statusCode,
      409,
    );
  } finally {
    await f.app.close();
  }
});

test('a thread reset during draining releases the opened browser and fails the start', async () => {
  const f = await takeoverFixture();
  try {
    const drain = deferred();
    f.setDrain(drain.promise);
    const start = f.request('/start', {});
    await f.drainEntered;
    const paused = f.thread()!.id;
    f.reset();
    drain.resolve();
    assert.equal((await start).statusCode, 409);
    assert.deepEqual(f.opened, [paused]);
    assert.ok(f.calls.includes('release'));
    assert.deepEqual((await f.request('')).json(), idle(false));
    assert.equal(f.resumed(), 0);
  } finally {
    await f.app.close();
  }
});

test('browser sign-in drains work, uses private desktop input and restores the browser before resuming', async () => {
  const f = await takeoverFixture({ signIn: true });
  try {
    const drain = deferred();
    f.setDrain(drain.promise);
    const start = f.request('/sign-in', {});
    await f.drainEntered;
    assert.deepEqual(f.calls, ['pause', 'drain']);
    drain.resolve();
    assert.deepEqual((await start).json(), { mode: 'sign_in', resumable: true });
    assert.deepEqual((await f.request('')).json(), {
      paused: true,
      active: true,
      mode: 'sign_in',
      signInAvailable: true,
      resumable: true,
    });
    assert.equal(
      (await f.request('/input', { input: { action: 'type', text: 'private' } })).statusCode,
      200,
    );
    assert.equal(f.calls.includes('input'), false);
    const finish = deferred();
    f.setFinish(finish.promise);
    const resume = f.request('/resume', {});
    await f.finishEntered;
    assert.deepEqual(f.calls, ['pause', 'drain', 'sign-in', 'sign-in-input', 'finish']);
    finish.resolve();
    assert.equal((await resume).statusCode, 200);
    assert.deepEqual(f.calls, [
      'pause',
      'drain',
      'sign-in',
      'sign-in-input',
      'finish',
      'release',
      'resume',
    ]);
    assert.equal((await f.request('')).json().mode, null);
  } finally {
    await f.app.close();
  }
});

test('a reset during native opening or restoration cannot resume the new thread', async () => {
  for (const operation of ['open', 'finish']) {
    const f = await takeoverFixture({ signIn: true });
    try {
      const gate = deferred();
      if (operation === 'open') f.setSignIn(gate.promise);
      else {
        await f.request('/sign-in', {});
        f.setFinish(gate.promise);
      }
      const pending = operation === 'open' ? f.request('/sign-in', {}) : f.request('/resume', {});
      await (operation === 'open' ? f.signInEntered : f.finishEntered);
      f.reset();
      gate.resolve();
      assert.equal((await pending).statusCode, 409);
      assert.equal(f.calls.includes('release'), true);
      assert.equal(f.resumed(), 0);
      assert.equal(f.thread()!.status, 'idle');
      assert.equal((await f.request('')).json().active, false);
    } finally {
      await f.app.close();
    }
  }
});

test('manual control never serves private sign-in frames', async () => {
  const f = await takeoverFixture();
  try {
    assert.equal((await f.coreRequest('/start', {})).json().mode, 'manual');
    assert.equal((await f.coreRequest('/sign-in-screen')).statusCode, 409);
  } finally {
    await f.app.close();
  }
});

test('private frames are discarded when the thread changes during capture', async () => {
  for (const change of ['reset', 'missing', 'resumed']) {
    const f = await takeoverFixture({ signIn: true });
    try {
      await f.coreRequest('/sign-in', {});
      const gate = deferred();
      f.setFrame(gate.promise);
      const capture = f.coreRequest('/sign-in-screen');
      await f.frameEntered;
      if (change === 'reset') f.reset();
      else if (change === 'missing') f.remove();
      else f.thread()!.status = 'idle';
      gate.resolve();
      const response = await capture;
      assert.equal(response.statusCode, 409);
      assert.equal(response.body.includes('synthetic-private-frame'), false);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.ok(f.calls.includes('release'));
      assert.equal(f.calls.includes('resume'), false);
    } finally {
      await f.app.close();
    }
  }
});

test(
  'Pi saves and reuses a verified browser profile for one owner',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `browser_connections_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    try {
      await pool.query(
        'CREATE TABLE threads (id uuid PRIMARY KEY,owner_id text,status text,archived_at timestamptz)',
      );
      await pool.query(
        'CREATE TABLE turns (id uuid PRIMARY KEY,owner_id text,thread_id uuid,status text)',
      );
      const first = { threadId: randomUUID(), turnId: randomUUID() };
      const second = { threadId: randomUUID(), turnId: randomUUID() };
      for (const turn of [first, second]) {
        await pool.query("INSERT INTO threads(id,owner_id,status) VALUES($1,'owner-a','running')", [
          turn.threadId,
        ]);
        await pool.query(
          "INSERT INTO turns(id,owner_id,thread_id,status) VALUES($1,'owner-a',$2,'running')",
          [turn.turnId, turn.threadId],
        );
      }
      let signedIn = false;
      const bindings: string[] = [];
      const removed: string[] = [];
      const computer = {
        async bindProfile(_threadId: string, profileId: string) {
          bindings.push(profileId);
        },
        async act(_threadId: string, input: { action: string; url?: string }) {
          return {
            url: signedIn ? 'https://example.test/account' : 'https://example.test/login',
            text: 'Synthetic page',
            candidates: [],
          };
        },
        async inspectLogin() {
          return {
            origin: 'https://example.test',
            url: signedIn ? 'https://example.test/account' : 'https://example.test/login',
            fields: signedIn
              ? []
              : [{ kind: 'password', selector: '#password', label: 'Password' }],
            methods: [],
          };
        },
        async hold() {},
        async close() {},
        async deleteProfile(profileId: string) {
          removed.push(profileId);
        },
      } as unknown as Computer;
      const service = await createBrowserConnections(pool, { ownerId: 'owner-a', computer });
      const opened = await service.request(
        { action: 'connect', url: 'https://example.test/login' },
        first,
      );
      assert.equal(opened.status, 'profile_opened');
      assert.ok('connectionId' in opened);
      const connectionId = opened.connectionId;
      const save = { action: 'save' as const, url: 'https://example.test/login', connectionId };
      assert.equal((await service.request(save, first)).status, 'needs_sign_in');
      signedIn = true;
      assert.equal((await service.request(save, first)).status, 'session_saved');
      assert.equal((await service.list())[0].browserState, 'saved');
      assert.equal(
        (
          await service.request(
            { action: 'use', url: 'https://example.test/account', connectionId },
            second,
          )
        ).status,
        'session_opened',
      );
      assert.deepEqual(bindings, [bindings[0], bindings[0]]);
      assert.equal(
        (await service.request({ action: 'use', url: 'https://other.test/', connectionId }, second))
          .status,
        'rejected',
      );
      const other = await createBrowserConnections(pool, { ownerId: 'owner-b', computer });
      const foreign = { threadId: randomUUID(), turnId: randomUUID() };
      await pool.query("INSERT INTO threads(id,owner_id,status) VALUES($1,'owner-b','running')", [
        foreign.threadId,
      ]);
      await pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,status) VALUES($1,'owner-b',$2,'running')",
        [foreign.turnId, foreign.threadId],
      );
      await assert.rejects(
        other.request({ action: 'use', url: 'https://example.test/', connectionId }, foreign),
        /unavailable/,
      );
      await pool.query("UPDATE turns SET status='completed' WHERE id=$1", [second.turnId]);
      await assert.rejects(
        service.request({ action: 'use', url: 'https://example.test/', connectionId }, second),
        /no longer active/,
      );
      await service.disconnect(connectionId);
      assert.deepEqual(removed, [bindings[0]]);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
