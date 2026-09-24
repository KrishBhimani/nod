import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import type { Agent, RuntimeContext } from '../src/ports/agent.ts';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import { createBrowserProxy } from '../src/providers/agent-browser/network.ts';
import type { runProcess } from '../src/providers/process.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

function browserFixture() {
  const commands: string[][] = [];
  const launches: string[][] = [];
  const png = Buffer.from('fixture-png');
  const run: typeof runProcess = async (_executable, args, options) => {
    launches.push(args);
    const command = args.slice(args.indexOf('--idle-timeout') + 2);
    commands.push(command);
    let data: Record<string, unknown> = {};
    if (command[0] === 'get')
      data = command[1] === 'url' ? { url: 'https://1.1.1.1/' } : { value: 'text' };
    if (command[0] === 'eval')
      data = {
        result: options?.input?.includes('document.body?.innerText')
          ? { text: 'Readable article body. fixture-secret' }
          : { ok: true },
      };
    if (command[0] === 'snapshot')
      data = {
        snapshot: '- paragraph\n- textbox "Password": fixture-secret\n- button "Continue" [ref=e2]',
      };
    if (command[0] === 'screenshot') await writeFile(command[1], png);
    return { stdout: JSON.stringify({ success: true, data }), stderr: '', exitCode: 0 };
  };
  return { run, commands, launches, png };
}

test('computer observations retain body text, normalize controls, protect credentials and return screenshot bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-computer-'));
  const fixture = browserFixture();
  const computer = createAgentBrowserComputer({ dataRoot: directory, run: fixture.run });
  try {
    const page = await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/' });
    assert.match(page.text, /Readable article body/);
    assert.deepEqual(page.candidates, [{ id: '@e2', label: '- button "Continue" [ref=e2]' }]);
    assert.ok(
      fixture.commands
        .filter((command) => command[0] === 'snapshot')
        .every((command) => !command.includes('-i')),
    );
    await computer.injectCredentials({
      taskId: 'fixture',
      origin: 'https://1.1.1.1',
      password: 'fixture-secret',
      passwordSelector: '#password',
    });
    assert.equal(
      (await computer.act('fixture', { action: 'snapshot' })).text.includes('fixture-secret'),
      false,
    );
    await assert.rejects(
      computer.act('fixture', { action: 'fill', selector: '#password', text: 'other' }),
      /secure credential/,
    );
    assert.deepEqual(await computer.screenshot('fixture'), fixture.png);
    await computer.close('fixture');
    assert.equal(await computer.screenshot('fixture'), null);
    assert.equal(fixture.commands.filter((command) => command[0] === 'close').length, 1);
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('computer factories isolate browser namespaces and dispose idle state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-lifecycle-'));
  const first = browserFixture();
  const second = browserFixture();
  const computer = createAgentBrowserComputer({
    dataRoot: join(directory, 'one'),
    idleTimeoutMs: 25,
    run: first.run,
  });
  const other = createAgentBrowserComputer({ dataRoot: join(directory, 'two'), run: second.run });
  try {
    await computer.act('same-task', { action: 'open', url: 'https://1.1.1.1/' });
    await other.act('same-task', { action: 'open', url: 'https://1.1.1.1/' });
    const namespace = (args: string[]) => args[args.indexOf('--namespace') + 1];
    assert.notEqual(namespace(first.launches[0]), namespace(second.launches[0]));
    for (let attempt = 0; attempt < 100 && !computer.status().startsWith('0 '); attempt += 1)
      await setTimeout(10);
    assert.match(computer.status(), /^0 /);
    assert.match(other.status(), /^1 /);
    assert.equal(await computer.screenshot('same-task'), null);
    assert.equal(first.commands.filter((command) => command[0] === 'close').length, 1);
    await other.dispose();
    assert.equal(second.commands.filter((command) => command[0] === 'close').length, 1);
    await assert.rejects(
      other.act('new-task', { action: 'open', url: 'https://1.1.1.1/' }),
      /stopped/,
    );
  } finally {
    await computer.dispose();
    await other.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser proxy ownership includes its listener lifecycle', async () => {
  const proxy = createBrowserProxy();
  const endpoint = await proxy.url();
  const response = await fetch(endpoint);
  assert.equal(response.status, 403);
  await response.text();
  await proxy.dispose();
  await assert.rejects(proxy.url(), /stopped/);
  await assert.rejects(fetch(endpoint));
});

test('a failed browser close blocks observations until the daemon can be closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-close-failure-'));
  const fixture = browserFixture();
  let fail = true;
  const computer = createAgentBrowserComputer({
    dataRoot: directory,
    run: async (...args) => {
      if (args[1].at(-1) === 'close' && fail) throw new Error('Fixture close failure.');
      return fixture.run(...args);
    },
  });
  try {
    await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/' });
    await computer.injectCredentials({
      taskId: 'fixture',
      origin: 'https://1.1.1.1',
      password: 'fixture-secret',
      passwordSelector: '#password',
    });
    await assert.rejects(computer.close('fixture'), /close failure/);
    await assert.rejects(computer.act('fixture', { action: 'snapshot' }), /expired/);
    await assert.rejects(computer.screenshot('fixture'), /expired/);
    await assert.rejects(
      computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/' }),
      /close failure/,
    );
    fail = false;
    await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/' });
    assert.deepEqual(await computer.screenshot('fixture'), fixture.png);
    await computer.close('fixture');
    assert.equal(await computer.screenshot('fixture'), null);
  } finally {
    fail = false;
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

function context(directory: string): RuntimeContext {
  return {
    taskId: 'fixture',
    ownerId: 'fixture',
    workspacePath: directory,
    prompt: 'Use the replacement tools',
    history: [],
    memories: [],
    attachments: [],
    signal: new AbortController().signal,
    emit: async () => {},
    delta: () => {},
    reply: async () => {},
    remember: async () => {},
    publish: async (path) => ({
      id: 'fixture',
      name: path,
      mimeType: 'text/plain',
      size: 1,
      url: '/api/artifacts/fixture',
    }),
    requestCredential: async () => ({}),
    integration: async () => ({}),
    manage: async () => ({}),
  };
}

test('shared runtime composes replacement agent, computer, workspace and chooser without vendor configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-substitute-'));
  const actions: string[] = [];
  const agent: Agent = {
    open: async (input) => ({
      resumed: false,
      abort: () => {},
      dispose: () => {},
      prompt: async () => {
        assert.match(input.systemPrompt, /\/fixture\/workspace/);
        const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
        const shell = await tools.get('shell')!.execute({ command: 'fixture command' });
        assert.equal(shell.content[0].type === 'text' && shell.content[0].text, 'Fixture output');
        await tools.get('browser_fast_step')!.execute({ goal: 'Continue' });
        await tools.get('publish_artifact')!.execute({ path: 'report.txt' });
      },
    }),
    dispose: () => {
      actions.push('agent disposed');
    },
  };
  const runtime = createAgentRuntime({
    agent,
    workspace: fakeWorkspace({
      dispose: () => {
        actions.push('workspace disposed');
      },
    }),
    computer: fakeComputer({
      act: async (_id, action) => {
        actions.push(action.action);
        return {
          text: 'page',
          url: 'https://example.com',
          candidates: [{ id: 'continue', label: 'Continue' }],
        };
      },
      dispose: async () => {
        actions.push('computer disposed');
      },
    }),
    chooseBrowserAction: async (_goal, observation) => {
      assert.equal(observation.candidates[0].id, 'continue');
      return { action: { action: 'click', selector: 'continue' }, outcome: 'CLICK', elapsedMs: 4 };
    },
  });
  try {
    assert.equal((await runtime.runTask(context(directory))).status, 'succeeded');
    assert.deepEqual(actions, ['snapshot', 'snapshot', 'click']);
    await runtime.dispose();
    assert.deepEqual(actions.slice(-3), [
      'agent disposed',
      'computer disposed',
      'workspace disposed',
    ]);
    await assert.rejects(runtime.runTask(context(directory)), /stopped/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime disposal aborts an active task before releasing computer and workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-abort-'));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const events: string[] = [];
  const runtime = createAgentRuntime({
    agent: {
      open: async () => ({
        resumed: false,
        prompt: async () => {
          entered();
          await stopped;
        },
        abort: () => {
          events.push('abort');
          finish();
        },
        dispose: () => {
          events.push('session disposed');
        },
      }),
      dispose: () => {},
    },
    computer: fakeComputer({
      dispose: async () => {
        events.push('computer disposed');
      },
    }),
    workspace: fakeWorkspace(),
  });
  try {
    const running = assert.rejects(runtime.runTask(context(directory)), /abort/i);
    await started;
    await assert.rejects(runtime.runTask(context(directory)), /active worker/);
    await runtime.dispose();
    await running;
    assert.equal(runtime.status().activeTasks, 0);
    assert.ok(events.indexOf('session disposed') < events.indexOf('computer disposed'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
