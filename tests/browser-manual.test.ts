import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  browserSessionId,
  createAgentBrowserComputer,
} from '../src/providers/agent-browser/index.ts';
import { manualInputSchema, protectFocusedField } from '../src/providers/agent-browser/manual.ts';
import { LoginDom, LoginElement, stagedLoginBrowser } from './login-fixture.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(options: { manualTimeoutMs?: number; idleTimeoutMs?: number } = {}) {
  const directory = await mkdtemp('/tmp/sk-manual-');
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
  const computer = createAgentBrowserComputer({ dataRoot: directory, run, ...options });
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
      await computer.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => daemon.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('capacity eviction preserves manual takeover while removing an idle browser', async () => {
  const f = await fixture();
  try {
    await f.computer.takeControl!('fixture');
    for (const id of ['two', 'three', 'four', 'five'])
      await f.computer.act(id, { action: 'open', url: 'https://1.1.1.1/login' });
    assert.equal(f.page().closed, false);
    assert.equal(f.computer.currentSession?.()?.taskId, 'fixture');
    await f.computer.control!('fixture', { action: 'click', x: 0.5, y: 0.5 });
    assert.ok(f.actions.some((action) => action.action === 'mouseup'));
    assert.match(f.computer.status(), /^4 /);
  } finally {
    await f.cleanup();
  }
});

test('manual input uses normalized socket commands, masks typed data, and locks every agent entry point', async () => {
  const f = await fixture();
  const secret = 'synthetic-manual-secret';
  try {
    await f.computer.takeControl!('fixture');
    await assert.rejects(f.computer.act('fixture', { action: 'snapshot' }), /paused/);
    await assert.rejects(f.computer.inspectLogin('fixture'), /paused/);
    await assert.rejects(
      f.computer.selectLoginMethod('fixture', 'https://1.1.1.1', 'oauth-google'),
      /paused/,
    );
    await assert.rejects(
      f.computer.injectCredentials({
        taskId: 'fixture',
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
    assert.deepEqual(
      f.actions
        .filter((action) => ['mousemove', 'mousedown', 'mouseup'].includes(String(action.action)))
        .map(({ id: _id, ...action }) => action),
      [
        { action: 'mousemove', x: 999, y: 300 },
        { action: 'mousedown', button: 'left' },
        { action: 'mouseup', button: 'left' },
      ],
    );
    await f.computer.control!('fixture', { action: 'type', text: secret });
    await f.computer.control!('fixture', { action: 'press', key: 'Tab' });
    await f.computer.control!('fixture', { action: 'scroll', direction: 'down' });
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
    assert.equal(
      f.actions.some((action) => action.action === 'press' && action.key === 'Tab'),
      true,
    );
    assert.equal(
      f.actions.some((action) => action.action === 'wheel' && action.deltaY === 500),
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test('manual typing accepts only a visible editable field and rejects file/control fields', () => {
  const page = new LoginDom();
  const input = new LoginElement();
  page.body.append(input);
  page.activeElement = input;
  assert.equal(page.evaluate(protectFocusedField), true);
  assert.equal(input.styles.get('color'), 'transparent');
  for (const type of ['file', 'checkbox', 'radio', 'hidden', 'submit']) {
    input.type = type;
    assert.equal(page.evaluate(protectFocusedField), false);
  }
  input.type = 'text';
  input.readOnly = true;
  assert.equal(page.evaluate(protectFocusedField), false);
  input.readOnly = false;
  input.setAttribute('inert', '');
  assert.equal(page.evaluate(protectFocusedField), false);
  assert.throws(() => manualInputSchema.parse({ action: 'press', key: 'ControlOrMeta+Shift+I' }));
  assert.throws(() => manualInputSchema.parse({ action: 'click', x: -1, y: 0 }));
});

test('takeover reserves its lock before socket checks and blocks already queued login reads', async () => {
  const f = await fixture();
  const started = deferred();
  const drain = deferred();
  try {
    await f.computer.takeControl!('fixture');
    await f.computer.releaseControl!('fixture');
    f.before(async (command) => {
      if (command.action === 'screenshot') {
        started.resolve();
        await drain.promise;
      }
    });
    const screen = f.computer.screenshot('fixture');
    await started.promise;
    const queuedInspection = f.computer.inspectLogin('fixture');
    const inspectionRejected = assert.rejects(queuedInspection, /paused/);
    const queuedSelection = assert.rejects(
      f.computer.selectLoginMethod('fixture', 'https://1.1.1.1', 'oauth-google'),
      /paused/,
    );
    await delay(0);
    const acquiring = f.computer.takeControl!('fixture');
    await delay(0);
    await assert.rejects(
      f.computer.injectCredentials({
        taskId: 'fixture',
        origin: 'https://1.1.1.1',
        passwordSelector: '#password',
        password: 'private-fixture',
      }),
      /paused/,
    );
    drain.resolve();
    await screen;
    await acquiring;
    await inspectionRejected;
    await queuedSelection;
  } finally {
    drain.resolve();
    await f.cleanup();
  }
});

test('release and cancellation invalidate queued manual clicks before mouse down', async (t) => {
  for (const operation of ['release', 'close'] as const)
    await t.test(operation, async () => {
      const f = await fixture();
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

test('an expired takeover refuses input and releases its idle hold without resuming the agent', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture({ manualTimeoutMs: 60_000, idleTimeoutMs: 15 });
  try {
    await f.computer.takeControl!('fixture');
    t.mock.timers.setTime(Date.now() + 60_001);
    await assert.rejects(
      f.computer.control!('fixture', { action: 'press', key: 'Enter' }),
      /control|available/,
    );
    for (let attempt = 0; attempt < 30 && !f.page().closed; attempt++) await delay(10);
    assert.equal(f.page().closed, true);
    assert.equal(
      f.actions.some((action) => action.action === 'press'),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test('a recovered browser resumes supported agent actions over its existing private socket', async () => {
  const f = await fixture();
  const restored = createAgentBrowserComputer({ dataRoot: f.directory, run: f.run });
  try {
    await f.computer.screenshot('fixture');
    await restored.takeControl!('fixture');
    await restored.releaseControl!('fixture');
    await restored.act('fixture', { action: 'click', selector: '@e1' });
    await restored.act('fixture', {
      action: 'fill',
      selector: '#ordinary-search',
      text: 'synthetic query',
    });
    await restored.act('fixture', { action: 'scroll', direction: 'up' });
    assert.equal(
      f.actions.some((action) => action.action === 'click' && action.selector === '@e1'),
      true,
    );
    assert.equal(
      f.actions.some((action) => action.action === 'fill' && action.value === 'synthetic query'),
      true,
    );
    assert.equal(
      f.actions.some(
        (action) => action.action === 'getattribute' && action.attribute === 'autocomplete',
      ),
      true,
    );
    assert.equal(
      f.actions.some(
        (action) =>
          action.action === 'scroll' && action.amount === 600 && action.direction === 'up',
      ),
      true,
    );
    assert.equal(
      f.actions.some((action) => action.action === 'navigate'),
      false,
    );
  } finally {
    await restored.dispose();
    await f.cleanup();
  }
});
