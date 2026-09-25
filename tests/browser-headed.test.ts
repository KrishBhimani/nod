import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import type { SignInDesktop } from '../src/providers/agent-browser/desktop.ts';
import { stagedLoginBrowser } from './login-fixture.ts';

async function fixture() {
  const directory = await mkdtemp('/tmp/sk-headed-');
  const pages = stagedLoginBrowser();
  const events: string[] = [];
  const displays: string[] = [];
  let failClose = false;
  let interruptOpen = false;
  const computer = createAgentBrowserComputer({
    dataRoot: directory,
    platform: 'linux',
    headless: false,
    browserExecutable: '/fixture/chromium',
    desktop: async (root): Promise<SignInDesktop> => {
      assert.equal(root, `${directory}/runtime`);
      const display = `:${400 + displays.length}`;
      displays.push(display);
      events.push(`display:${display}`);
      return {
        environment: { DISPLAY: display, XAUTHORITY: `${root}/private-${display}/Xauthority` },
        exited: new Promise(() => {}),
        async screenshot() {
          return Buffer.from('unused');
        },
        async control() {},
        async close() {
          events.push(`display-close:${display}`);
        },
      };
    },
    run: async (executable, args, options) => {
      const action = args[args.indexOf('--idle-timeout') + 2];
      events.push(`browser:${action}:${options?.env?.DISPLAY}`);
      assert.equal(args.includes('--headed'), true);
      assert.equal(args.includes('--headless'), false);
      assert.equal(
        args.some((value) => value.includes('--start-minimized')),
        false,
      );
      if (action === 'open') {
        assert.ok(displays.includes(String(options?.env?.DISPLAY)));
        assert.match(String(options?.env?.XAUTHORITY), /\/private-:\d+\/Xauthority$/);
        if (interruptOpen) throw new Error('Synthetic interrupted launch');
      }
      if (action === 'close' && failClose) throw new Error('Synthetic close failure');
      return pages.run(executable, args, options);
    },
    signInLauncher: {
      async start() {
        events.push('native-open');
        return {
          closed: false,
          exited: new Promise(() => {}),
          async close() {
            events.push('native-close');
          },
        };
      },
    },
  });
  return {
    computer,
    events,
    displays,
    open: (id = 'fixture') => computer.act(id, { action: 'open', url: 'https://1.1.1.1/login' }),
    failClose(value: boolean) {
      failClose = value;
    },
    interruptOpen() {
      interruptOpen = true;
    },
    async cleanup() {
      failClose = false;
      await computer.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('headed workspace sessions use separate private displays and reuse them until browser closure', async () => {
  const f = await fixture();
  try {
    await f.open();
    await f.computer.act('fixture', { action: 'snapshot' });
    assert.deepEqual(f.displays, [':400']);
    await f.open('second');
    assert.deepEqual(f.displays, [':400', ':401']);
    await f.computer.close('fixture');
    assert.ok(f.events.indexOf('browser:close::400') < f.events.indexOf('display-close::400'));
    assert.equal(f.events.includes('display-close::401'), false);
    await f.computer.close('second');
    assert.equal(f.events.includes('display-close::401'), true);
  } finally {
    await f.cleanup();
  }
});

test('native handoff closes the automated display and continuation creates a fresh one', async () => {
  const f = await fixture();
  try {
    await f.open();
    await f.computer.openSignIn!('fixture');
    assert.ok(f.events.indexOf('display-close::400') < f.events.indexOf('native-open'));
    await assert.rejects(f.computer.act('fixture', { action: 'snapshot' }), /paused/);
    await f.computer.finishSignIn!('fixture');
    assert.ok(f.events.indexOf('native-close') < f.events.indexOf('display::401'));
    assert.deepEqual(f.displays, [':400', ':401']);
    assert.equal(
      (await f.computer.act('fixture', { action: 'snapshot' })).url,
      'https://1.1.1.1/login',
    );
  } finally {
    await f.cleanup();
  }
});

test('a failed browser close retains its display until the browser can be closed', async () => {
  const f = await fixture();
  try {
    await f.open();
    f.failClose(true);
    await assert.rejects(f.computer.close('fixture'), /close failure/);
    assert.equal(f.events.includes('display-close::400'), false);
    f.failClose(false);
    await f.computer.close('fixture');
    assert.equal(f.events.includes('display-close::400'), true);
  } finally {
    await f.cleanup();
  }
});

test('an interrupted headed launch drains its browser before closing the private display', async () => {
  const f = await fixture();
  try {
    f.interruptOpen();
    await assert.rejects(f.open(), /interrupted launch/);
    assert.ok(f.events.indexOf('browser:close::400') < f.events.indexOf('display-close::400'));
    assert.equal(f.events.filter((event) => event === 'display-close::400').length, 1);
  } finally {
    await f.cleanup();
  }
});
