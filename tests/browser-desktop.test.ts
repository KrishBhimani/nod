import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSignInDesktop } from '../src/providers/agent-browser/desktop.ts';

function fixture() {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(800, 20);
  const calls: Array<{
    command: string;
    args: string[];
    options: SpawnOptions;
    input: string;
    signals: Array<NodeJS.Signals | number | undefined>;
    finish(code?: number): void;
  }> = [];
  let hold = '';
  let badCapture = false;
  let failServer = false;
  return {
    calls,
    png,
    hold(command: string) {
      hold = command;
    },
    badCapture() {
      badCapture = true;
    },
    failServer() {
      failServer = true;
    },
    spawn(command: string, args: string[], options: SpawnOptions) {
      const child = new EventEmitter();
      const stdout = new PassThrough();
      const stdin = new PassThrough();
      let finished = false;
      const call = {
        command,
        args,
        options,
        input: '',
        signals: [] as Array<NodeJS.Signals | number | undefined>,
        finish(code = 0) {
          if (finished) return;
          finished = true;
          if (command.endsWith('/ffmpeg')) stdout.write(badCapture ? Buffer.from('invalid') : png);
          if (args[0] === 'getdisplaygeometry') stdout.write('1280 800\n');
          child.emit('close', code, null);
        },
      };
      calls.push(call);
      stdin.on('data', (chunk) => {
        call.input += chunk.toString();
      });
      stdin.once('finish', () => {
        if (command !== hold) queueMicrotask(() => call.finish());
      });
      if (command.endsWith('/Xvfb') && failServer) queueMicrotask(() => call.finish(1));
      return Object.assign(child, {
        stdout,
        stdin,
        kill(signal?: NodeJS.Signals | number) {
          call.signals.push(signal);
          queueMicrotask(() => call.finish());
          return true;
        },
      }) as unknown as ChildProcess;
    },
  };
}

test('Linux sign-in creates a private authenticated display and transient bounded screenshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sk-desktop-'));
  const f = fixture();
  const desktop = await createSignInDesktop({ spawn: f.spawn })(root);
  try {
    const auth = f.calls.find((call) => call.command.endsWith('/xauth'))!;
    const display = f.calls.find((call) => call.command.endsWith('/Xvfb'))!;
    assert.match(auth.input, /^add :\d+ \. [a-f0-9]{32}\n$/);
    assert.deepEqual(auth.args, ['-f', desktop.environment.XAUTHORITY]);
    assert.deepEqual(display.args, [
      desktop.environment.DISPLAY,
      '-screen',
      '0',
      '1280x800x24',
      '-nolisten',
      'tcp',
      '-auth',
      desktop.environment.XAUTHORITY,
      '-noreset',
    ]);
    assert.equal(display.options.shell, false);
    assert.equal((await stat(String(desktop.environment.XAUTHORITY))).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, (await readdir(root))[0]))).mode & 0o777, 0o700);
    assert.equal(
      Object.keys(desktop.environment).some((key) => /KEY|TOKEN|PASSWORD|DOCKER/.test(key)),
      false,
    );
    assert.deepEqual(await desktop.screenshot(), f.png);
    const capture = f.calls.at(-1)!;
    assert.equal(capture.command, '/usr/bin/ffmpeg');
    assert.equal(capture.args.at(-1), 'pipe:1');
    assert.ok(capture.args.includes('1280x800'));
    assert.equal((await readdir(join(root, (await readdir(root))[0]))).length, 1);
    f.badCapture();
    await assert.rejects(desktop.screenshot(), /screen is unavailable/);
  } finally {
    await desktop.close();
    assert.deepEqual(await readdir(root), []);
    await rm(root, { recursive: true, force: true });
  }
});

test('Native input uses fixed commands and sends typed credentials only through stdin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sk-desktop-'));
  const f = fixture();
  const desktop = await createSignInDesktop({ spawn: f.spawn })(root);
  try {
    const secret = 'synthetic password --shell $(not-code)';
    await desktop.control({ action: 'type', text: secret });
    const typing = f.calls.at(-1)!;
    assert.equal(typing.command, '/usr/bin/xdotool');
    assert.deepEqual(typing.args, ['type', '--clearmodifiers', '--delay', '0', '--file', '-']);
    assert.equal(typing.input, secret);
    assert.equal(JSON.stringify(typing.args).includes(secret), false);
    assert.equal(JSON.stringify(typing.options).includes(secret), false);
    await desktop.control({ action: 'click', x: 1, y: 1 });
    assert.deepEqual(f.calls.at(-1)!.args, ['mousemove', '--sync', '1279', '799', 'click', '1']);
    await desktop.control({ action: 'press', key: 'ControlOrMeta+A' });
    assert.deepEqual(f.calls.at(-1)!.args, ['key', '--clearmodifiers', 'ctrl+a']);
    await desktop.control({ action: 'press', key: 'ArrowLeft', modifiers: ['Control', 'Shift'] });
    assert.deepEqual(f.calls.at(-1)!.args, ['key', '--clearmodifiers', 'ctrl+shift+Left']);
    await desktop.control({ action: 'press', key: 'PageDown' });
    assert.deepEqual(f.calls.at(-1)!.args, ['key', '--clearmodifiers', 'Next']);
    await desktop.control({ action: 'press', key: 'Tab', modifiers: ['Shift'] });
    assert.deepEqual(f.calls.at(-1)!.args, ['key', '--clearmodifiers', 'shift+Tab']);
    await desktop.control({ action: 'type', text: 'ç日本語\nSynthetic paste' });
    assert.equal(f.calls.at(-1)!.input, 'ç日本語\nSynthetic paste');
    assert.equal(f.calls.at(-1)!.options.env?.LANG, 'C.UTF-8');
    await desktop.control({ action: 'wheel', deltaX: 60, deltaY: -140 });
    assert.deepEqual(f.calls.at(-1)!.args, ['click', '--repeat', '1', '--delay', '0', '4']);
    await desktop.control({ action: 'scroll', direction: 'down' });
    assert.deepEqual(f.calls.at(-1)!.args, ['click', '--repeat', '3', '--delay', '60', '5']);
    const count = f.calls.length;
    await assert.rejects(desktop.control({ action: 'click', x: -1, y: 0 }));
    await assert.rejects(desktop.control({ action: 'type', text: 'bad\0value' }));
    await assert.rejects(desktop.control({ action: 'type', text: 'x'.repeat(8193) }));
    await assert.rejects(desktop.control({ action: 'press', key: 'a' }));
    await assert.rejects(
      desktop.control({ action: 'press', key: 'a', modifiers: ['Control', 'Control'] }),
    );
    await assert.rejects(desktop.control({ action: 'wheel', deltaX: 0, deltaY: 2001 }));
    assert.equal(f.calls.length, count);
  } finally {
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('native trackpad deltas accumulate per display and reset after focus input or replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sk-desktop-wheel-'));
  const f = fixture();
  const start = createSignInDesktop({ spawn: f.spawn });
  let desktop = await start(root);
  try {
    let before = f.calls.length;
    for (let index = 0; index < 7; index++)
      await desktop.control({ action: 'wheel', deltaX: 0, deltaY: 10 });
    assert.equal(f.calls.length, before);
    await desktop.control({ action: 'wheel', deltaX: 0, deltaY: 10 });
    assert.equal(f.calls.length, before + 1);
    assert.deepEqual(f.calls.at(-1)!.args, ['click', '--repeat', '1', '--delay', '0', '5']);
    await desktop.control({ action: 'wheel', deltaX: -50, deltaY: 30 });
    await desktop.control({ action: 'wheel', deltaX: -30, deltaY: -110 });
    assert.deepEqual(f.calls.at(-1)!.args, [
      'click',
      '--repeat',
      '1',
      '--delay',
      '0',
      '4',
      'click',
      '--repeat',
      '1',
      '--delay',
      '0',
      '6',
    ]);
    await desktop.control({ action: 'wheel', deltaX: 0, deltaY: 79 });
    await desktop.control({ action: 'click', x: 0.5, y: 0.5 });
    before = f.calls.length;
    await desktop.control({ action: 'wheel', deltaX: 0, deltaY: 1 });
    assert.equal(f.calls.length, before);
    await desktop.control({ action: 'wheel', deltaX: 0, deltaY: 78 });
    await desktop.close();
    await assert.rejects(desktop.control({ action: 'wheel', deltaX: 0, deltaY: 1 }), /closed/);
    desktop = await start(root);
    before = f.calls.length;
    await desktop.control({ action: 'wheel', deltaX: 0, deltaY: 1 });
    assert.equal(f.calls.length, before);
  } finally {
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelled or failed native input clears accumulated wheel movement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sk-desktop-wheel-'));
  const f = fixture();
  const desktop = await createSignInDesktop({ spawn: f.spawn })(root);
  try {
    await desktop.control({ action: 'wheel', deltaX: 0, deltaY: 79 });
    await assert.rejects(
      desktop.control({ action: 'wheel', deltaX: 0, deltaY: 1 }, AbortSignal.abort()),
      { name: 'AbortError' },
    );
    let before = f.calls.length;
    await desktop.control({ action: 'wheel', deltaX: 0, deltaY: 1 });
    assert.equal(f.calls.length, before);
    f.hold('/usr/bin/xdotool');
    const pending = desktop.control({ action: 'wheel', deltaX: 0, deltaY: 158 });
    f.calls.at(-1)!.finish(1);
    await assert.rejects(pending, /operation failed/);
    f.hold('');
    before = f.calls.length;
    await desktop.control({ action: 'wheel', deltaX: 0, deltaY: 1 });
    assert.equal(f.calls.length, before);
  } finally {
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Cancelling or closing a native display drains owned capture processes and rejects later input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sk-desktop-'));
  const f = fixture();
  const desktop = await createSignInDesktop({ spawn: f.spawn })(root);
  try {
    f.hold('/usr/bin/ffmpeg');
    const controller = new AbortController();
    const capturing = assert.rejects(desktop.screenshot(controller.signal), /operation failed/);
    const call = f.calls.at(-1)!;
    controller.abort();
    await capturing;
    assert.deepEqual(call.signals, ['SIGKILL']);
    const pending = assert.rejects(desktop.screenshot(), /operation failed/);
    const closing = desktop.close();
    await pending;
    await closing;
    await desktop.exited;
    assert.deepEqual(f.calls.find((value) => value.command.endsWith('/Xvfb'))!.signals, [
      'SIGTERM',
    ]);
    const count = f.calls.length;
    await assert.rejects(desktop.control({ action: 'press', key: 'Enter' }), /closed/);
    assert.equal(f.calls.length, count);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('A failed private display launch removes its authority file and reports a fixed error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sk-desktop-'));
  const f = fixture();
  f.failServer();
  try {
    await assert.rejects(createSignInDesktop({ spawn: f.spawn })(root), /display could not start/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
