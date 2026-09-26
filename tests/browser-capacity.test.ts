import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { createBrowserFixture as createAgentBrowserComputer } from './browser-fixture.ts';
import { stagedLoginBrowser } from './login-fixture.ts';

async function fixture() {
  const directory = await mkdtemp('/tmp/sk-capacity-');
  const browser = stagedLoginBrowser();
  let before = async (_task: string, _command: string[]) => {};
  let nativeClosed = true;
  const computer = createAgentBrowserComputer({
    dataRoot: directory,
    run: async (executable, args, options) => {
      const task = args[args.indexOf('--profile') + 1]?.split('/').at(-1) ?? '';
      const command = args.slice(args.indexOf('--idle-timeout') + 2);
      await before(task, command);
      return browser.run(executable, args, options);
    },
    resolveSignInBrowser: async () => '/fixture/chromium',
    signInLauncher: {
      async start() {
        nativeClosed = false;
        return {
          get closed() {
            return nativeClosed;
          },
          exited: Promise.resolve(),
          async close() {
            nativeClosed = true;
          },
          async screenshot() {
            return Buffer.from('private-native-frame');
          },
        };
      },
    },
  });
  return {
    computer,
    browser,
    open: (id: string) => computer.act(id, { action: 'open', url: 'https://1.1.1.1/login' }),
    before(value: typeof before) {
      before = value;
    },
    nativeClosed: () => nativeClosed,
    async close() {
      before = async () => {};
      await computer.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('new browser tasks evict the oldest idle session and retain its cached screen', async () => {
  const f = await fixture();
  try {
    for (const id of ['one', 'two', 'three', 'four']) await f.open(id);
    await f.computer.act('one', { action: 'snapshot' });
    await f.open('five');
    assert.equal(f.browser.pages.get('two')!.closed, true);
    assert.equal(f.browser.pages.get('one')!.closed, false);
    assert.ok(await f.computer.screenshot('two'));
    assert.equal(f.computer.screenStatus?.('two').state, 'last_known');
    for (const id of ['six', 'seven', 'eight']) await f.open(id);
    assert.equal([...f.browser.pages.values()].filter((page) => !page.closed).length, 4);
  } finally {
    await f.close();
  }
});

test('capacity preserves credential holds and native sign-in and rejects a fifth protected session', async () => {
  const f = await fixture();
  try {
    for (const id of ['one', 'two', 'three', 'four']) {
      await f.open(id);
      await f.computer.hold(id, Date.now() + 60_000);
    }
    await f.computer.openSignIn!('one');
    await assert.rejects(f.open('five'), /browser sessions.*busy/i);
    assert.equal(f.nativeClosed(), false);
    assert.equal(f.browser.pages.has('five'), false);
    assert.match(f.computer.status(), /^4 /);
    for (const id of ['two', 'three', 'four']) assert.equal(f.browser.pages.get(id)!.closed, false);
    await f.computer.hold('two', null);
    await f.open('five');
    assert.equal(f.browser.pages.get('two')!.closed, true);
    assert.equal(f.nativeClosed(), false);
  } finally {
    await f.close();
  }
});

test('concurrent browser launches reserve capacity and never evict in-flight commands', async () => {
  const f = await fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let count = 0;
  f.before(async (_task, command) => {
    if (command[0] !== 'open') return;
    if (++count === 4) entered();
    await blocked;
  });
  const opens = ['one', 'two', 'three', 'four'].map(f.open);
  try {
    await ready;
    await assert.rejects(f.open('five'), /browser sessions.*busy/i);
    assert.equal(count, 4);
    release();
    await Promise.all(opens);
    await f.open('five');
    assert.equal([...f.browser.pages.values()].filter((page) => !page.closed).length, 4);
  } finally {
    release();
    await Promise.allSettled(opens);
    await f.close();
  }
});

test('a failed eviction keeps the occupied slot and does not launch another browser', async () => {
  const f = await fixture();
  try {
    for (const id of ['one', 'two', 'three', 'four']) await f.open(id);
    f.before(async (_task, command) => {
      if (command[0] === 'close') throw new Error('Synthetic close failure');
    });
    await assert.rejects(f.open('five'), /browser sessions.*busy/i);
    assert.equal(f.browser.pages.has('five'), false);
    assert.equal([...f.browser.pages.values()].filter((page) => !page.closed).length, 4);
  } finally {
    await f.close();
  }
});
