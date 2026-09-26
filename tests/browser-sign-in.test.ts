import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  createBrowserSignIn,
  resolveSignInBrowser,
} from '../src/providers/agent-browser/sign-in.ts';

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

async function fixture() {
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

test('native sign-in uses the exact browser version that wrote the task profile', async () => {
  const f = await fixture();
  try {
    for (const version of ['142.0.0.0', '155.0.0.0']) {
      const path = join(f.browsersDirectory, `chrome-${version}`, 'chrome');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '', { mode: 0o700 });
    }
    assert.equal(
      await resolveSignInBrowser(f.profilePath, {
        browsersDirectory: f.browsersDirectory,
        platform: 'linux',
      }),
      f.executablePath,
    );
    await rm(f.executablePath);
    await assert.rejects(
      resolveSignInBrowser(f.profilePath, {
        browsersDirectory: f.browsersDirectory,
        platform: 'linux',
      }),
      /matching task browser is unavailable/,
    );
  } finally {
    await f.cleanup();
  }
});

test('native sign-in version lookup supports the pinned macOS cache layout and rejects unsafe metadata', async () => {
  const f = await fixture();
  try {
    const executable = join(
      f.browsersDirectory,
      'chrome-154.0.8037.57',
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    );
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, '', { mode: 0o700 });
    assert.equal(
      await resolveSignInBrowser(f.profilePath, {
        browsersDirectory: f.browsersDirectory,
        platform: 'darwin',
      }),
      executable,
    );
    await writeFile(join(f.profilePath, 'Last Version'), '../../private-profile');
    await assert.rejects(
      resolveSignInBrowser(f.profilePath),
      /task browser version is unavailable/,
    );
    await rm(join(f.profilePath, 'Last Version'));
    await symlink(f.executablePath, join(f.profilePath, 'Last Version'));
    await assert.rejects(
      resolveSignInBrowser(f.profilePath),
      /task browser version is unavailable/,
    );
  } finally {
    await f.cleanup();
  }
});

test('native sign-in retains task isolation and networking protections without browser automation', async () => {
  const f = await fixture();
  const process = processFixture();
  try {
    const launcher = createLauncher({ spawn: process.spawn, startupMs: 1 });
    const handle = await launcher.start({ ...f.input, url: 'https://example.com/sign-in' });
    const call = process.calls[0];
    assert.equal(call.executable, f.executablePath);
    assert.deepEqual(call.args, [
      `--user-data-dir=${f.profilePath}`,
      '--proxy-server=http://127.0.0.1:4311',
      '--proxy-bypass-list=<-loopback>',
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-background-networking',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--password-store=basic',
      '--use-mock-keychain',
      '--restore-last-session',
      '--ozone-platform=x11',
      '--window-position=0,0',
      '--window-size=1280,800',
      '--new-window',
      'https://example.com/sign-in',
    ]);
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

test('forced cleanup waits for process exit and only escalates its own child', async () => {
  const f = await fixture();
  const process = processFixture({ ignoreTerm: true });
  try {
    const handle = await createLauncher({
      spawn: process.spawn,
      startupMs: 1,
      closeMs: 5,
      killMs: 5,
    }).start(f.input);
    let settled = false;
    const closing = handle.close({ force: true }).then(() => {
      settled = true;
    });
    assert.equal(settled, false);
    assert.equal(handle.closed, false);
    await closing;
    assert.deepEqual(process.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(handle.closed, true);
  } finally {
    await f.cleanup();
  }
});

test('native sign-in refuses to release a profile whose process cannot close', async () => {
  const f = await fixture();
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

test('forced cancellation cannot satisfy a pending graceful continuation', async () => {
  const f = await fixture();
  const process = processFixture({ ignoreGraceful: true });
  try {
    const handle = await createLauncher({
      spawn: process.spawn,
      startupMs: 1,
      closeMs: 10,
    }).start(f.input);
    const continuation = assert.rejects(handle.close(), /workspace sign-in browser.*clos/);
    await handle.close({ force: true });
    await continuation;
    assert.equal(handle.closed, true);
    assert.deepEqual(process.signals, ['SIGINT', 'SIGTERM']);
    await assert.rejects(handle.close(), /workspace sign-in browser.*clos/);
  } finally {
    await f.cleanup();
  }
});

test('failed forced cleanup keeps its profile reserved', async () => {
  const f = await fixture();
  const process = processFixture({ neverClose: true });
  try {
    const launcher = createLauncher({
      spawn: process.spawn,
      startupMs: 1,
      closeMs: 1,
      killMs: 1,
    });
    const handle = await launcher.start(f.input);
    await assert.rejects(handle.close({ force: true }), /workspace sign-in browser.*clos/);
    assert.deepEqual(process.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(handle.closed, false);
    await assert.rejects(launcher.start(f.input), /already open/);
    process.child.emit('close', 0);
    await handle.close({ force: true });
  } finally {
    await f.cleanup();
  }
});

test('native sign-in rejects a failed launch and prevents concurrent use of one profile', async () => {
  const f = await fixture();
  const process = processFixture({ exitEarly: true });
  try {
    const launcher = createLauncher({ spawn: process.spawn, startupMs: 5 });
    const start = launcher.start(f.input);
    await assert.rejects(launcher.start(f.input), /already open/);
    await assert.rejects(start, /could not start/);
    assert.deepEqual(process.signals, []);
    await assert.rejects(launcher.start(f.input), /could not start/);
  } finally {
    await f.cleanup();
  }
});

test('native sign-in masks process launch errors and releases failed launch reservations', async () => {
  const f = await fixture();
  const process = processFixture();
  let attempt = 0;
  try {
    const launcher = createLauncher({
      startupMs: 1,
      spawn(executable, args, options) {
        if (attempt++ === 0) throw new Error('private-launch-details');
        const child = process.spawn(executable, args, options);
        if (attempt === 2)
          queueMicrotask(() => {
            process.child.emit('error', new Error('private-child-details'));
            process.child.emit('close', -1, null);
          });
        return child;
      },
    });
    for (let index = 0; index < 2; index++)
      await assert.rejects(launcher.start(f.input), (error: Error) => {
        assert.match(error.message, /could not start/);
        assert.doesNotMatch(error.message, /private/);
        return true;
      });
    const handle = await launcher.start(f.input);
    await handle.close();
  } finally {
    await f.cleanup();
  }
});

test('native sign-in validates profile and proxy boundaries without echoing private input', async () => {
  const f = await fixture();
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
