import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import type { Agent, RuntimeContext } from '../src/ports/agent.ts';
import { createBrowserFixture as createAgentBrowserComputer } from './browser-fixture.ts';
import { createBrowserProxy } from '../src/providers/agent-browser/network.ts';
import type { runProcess } from '../src/providers/process.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { integrationResultSnapshot } from '../src/server/integration-result.ts';
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
  const directory = await mkdtemp(join(tmpdir(), 'otto-computer-'));
  const fixture = browserFixture();
  const protocol: Record<string, unknown>[] = [];
  const computer = createAgentBrowserComputer({
    dataRoot: directory,
    run: fixture.run,
    onDaemonCommand: (command) => protocol.push(command),
  });
  try {
    const page = await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/' });
    assert.match(page.text, /Readable article body/);
    assert.deepEqual(page.candidates, [{ id: '@e2', label: '- button "Continue" [ref=e2]' }]);
    assert.deepEqual(
      protocol.filter((command) => command.action === 'snapshot'),
      [{ action: 'snapshot', compact: true }],
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
    assert.deepEqual(await computer.screenshot('fixture'), fixture.png);
    assert.equal(computer.screenStatus?.('fixture').state, 'last_known');
    assert.equal(fixture.commands.filter((command) => command[0] === 'close').length, 1);
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('computer factories isolate browser namespaces and dispose idle state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-lifecycle-'));
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
    assert.deepEqual(await computer.screenshot('same-task'), first.png);
    assert.equal(computer.screenStatus?.('same-task').state, 'last_known');
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

test('current browser changes when an accepted navigation starts and late completion cannot steal focus', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-current-browser-'));
  const fixture = browserFixture();
  let release: () => void = () => {};
  let started: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const computer = createAgentBrowserComputer({
    dataRoot: directory,
    run: async (...args) => {
      const command = args[1].slice(args[1].indexOf('--idle-timeout') + 2);
      if (command[0] === 'open' && command[1].endsWith('/slow')) {
        started();
        await pending;
      }
      return fixture.run(...args);
    },
  });
  let navigation: Promise<unknown> | undefined;
  try {
    await computer.act('earlier', { action: 'open', url: 'https://1.1.1.1/' });
    navigation = computer.act('current', { action: 'open', url: 'https://1.1.1.1/slow' });
    await entered;
    assert.equal(computer.currentSession?.()?.taskId, 'current');
    await computer.act('earlier', { action: 'scroll', direction: 'down' });
    assert.equal(computer.currentSession?.()?.taskId, 'earlier');
    release();
    await navigation;
    assert.equal(computer.currentSession?.()?.taskId, 'earlier');
    await assert.rejects(computer.act('blocked', { action: 'open', url: 'file:///private' }));
    assert.equal(computer.currentSession?.()?.taskId, 'earlier');
    await assert.rejects(
      computer.act('cancelled', { action: 'open', url: 'https://1.1.1.1/' }, AbortSignal.abort()),
    );
    assert.equal(computer.currentSession?.()?.taskId, 'earlier');
  } finally {
    release();
    await navigation?.catch(() => {});
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser proxy ownership includes its listener lifecycle', async () => {
  const proxy = createBrowserProxy();
  const endpoint = await proxy.url();
  const response = await fetch(endpoint);
  assert.equal(response.status, 400);
  await response.text();
  await proxy.dispose();
  await assert.rejects(proxy.url(), /stopped/);
  await assert.rejects(fetch(endpoint));
});

test('a failed browser close blocks observations until the daemon can be closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-close-failure-'));
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
    assert.deepEqual(await computer.screenshot('fixture'), fixture.png);
    assert.equal(computer.screenStatus?.('fixture').state, 'last_known');
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
  const directory = await mkdtemp(join(tmpdir(), 'otto-substitute-'));
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

test('runtime preserves incomplete app evidence and read-only narrowing guidance without replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-incomplete-integration-'));
  const omitted = integrationResultSnapshot({
    results: [
      { title: 'Unrelated page', description: 'x'.repeat(18_000) },
      { title: 'Synthetic requested page' },
    ],
    has_more: false,
  });
  let calls = 0;
  const observations: unknown[] = [];
  const runtime = createAgentRuntime({
    agent: {
      open: async (input) => ({
        resumed: false,
        abort: () => {},
        dispose: () => {},
        prompt: async () => {
          const apps = input.tools.find((tool) => tool.name === 'apps')!;
          assert.match(apps.description, /incomplete evidence, not a not-found result/);
          assert.match(apps.description, /narrower read-only query/);
          assert.match(apps.description, /Never repeat a completed write/);
          const result = await apps.execute({
            action: 'NOTION_SEARCH_NOTION_PAGE',
            args: { query: 'Synthetic requested page', page_size: 100 },
          });
          assert.equal(result.content.length, 1);
          const content = result.content[0];
          assert.equal(content.type, 'text');
          if (content.type !== 'text') assert.fail('Expected bounded JSON text.');
          assert.deepEqual(JSON.parse(content.text), omitted);
          assert.ok(Buffer.byteLength(content.text) <= 18_000);
          assert.ok(!content.text.includes('Unrelated page'));
        },
      }),
      dispose: () => {},
    },
    computer: fakeComputer(),
    workspace: fakeWorkspace(),
  });
  try {
    const result = await runtime.runTask({
      ...context(directory),
      integration: async () => {
        calls += 1;
        return omitted;
      },
      observe: async (event) => {
        if (event.type === 'tool_end') observations.push(event.output);
      },
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(calls, 1);
    assert.deepEqual(observations, [omitted]);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime disposal aborts an active task before releasing computer and workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-abort-'));
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

test('stalled observations release active tasks on cancellation and disposal', async (t) => {
  for (const method of ['cancel', 'dispose'] as const) {
    await t.test(method, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'otto-stalled-observer-'));
      const controller = new AbortController();
      let entered!: () => void;
      const observed = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let rejectObservation!: (error: Error) => void;
      const stalled = new Promise<void>((_resolve, reject) => {
        rejectObservation = reject;
      });
      let executed = false;
      const runtime = createAgentRuntime({
        agent: {
          open: async (input) => ({
            resumed: false,
            abort: () => {},
            dispose: () => {},
            prompt: async () => {
              await input.tools
                .find((tool) => tool.name === 'apps')!
                .execute({ action: 'FIXTURE_ACTION', args: {} });
              executed = true;
            },
          }),
          dispose: () => {},
        },
        computer: fakeComputer(),
        workspace: fakeWorkspace(),
      });
      const running = runtime
        .runTask({
          ...context(directory),
          signal: controller.signal,
          observe: async () => {
            entered();
            return stalled;
          },
          integration: async () => {
            executed = true;
            return {};
          },
        })
        .then(
          () => 'succeeded',
          (error: unknown) => error,
        );
      try {
        await observed;
        const disposing =
          method === 'dispose' ? runtime.dispose() : Promise.resolve(controller.abort());
        const completed = await Promise.race([
          Promise.all([running, disposing]),
          setTimeout(250).then(() => null),
        ]);
        assert.ok(completed, 'A stalled optional observer blocked cancellation');
        assert.match(String(completed[0]), /cancelled/);
        assert.equal(runtime.status().activeTasks, 0);
        assert.equal(executed, false);
        rejectObservation(new Error('Late private observer failure'));
        await setTimeout(0);
      } finally {
        rejectObservation(new Error('Fixture observer cleanup'));
        controller.abort();
        await running;
        await runtime.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('runtime shutdown drains tasks and releases every capability after adapter failures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-disposal-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
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
          events.push('session');
        },
      }),
      dispose: () => {
        events.push('agent');
        throw new Error('Synthetic agent cleanup failure');
      },
    },
    computer: fakeComputer({
      dispose: () => {
        events.push('computer');
        throw new Error('Synthetic browser cleanup failure');
      },
    }),
    workspace: fakeWorkspace({
      dispose: () => {
        events.push('workspace');
      },
    }),
  });
  const running = assert.rejects(runtime.runTask(context(directory)), /abort/i);
  await started;
  const disposal = runtime.dispose();
  assert.equal(runtime.dispose(), disposal);
  await assert.rejects(disposal, /Some runtime resources could not close/);
  await running;
  assert.equal(runtime.status().activeTasks, 0);
  assert.equal(events.filter((value) => value === 'computer').length, 1);
  assert.equal(events.filter((value) => value === 'workspace').length, 1);
  assert.ok(events.indexOf('session') < events.indexOf('computer'));
  assert.ok(events.indexOf('computer') < events.indexOf('workspace'));
  await assert.rejects(runtime.runTask(context(directory)), /stopped/);
});

test('runtime retries only failed cleanup stages and coalesces each shutdown attempt', async (t) => {
  for (const failedStage of ['agent', 'computer', 'workspace'] as const) {
    await t.test(failedStage, async () => {
      const attempts = { agent: 0, computer: 0, workspace: 0 };
      const close = (stage: keyof typeof attempts) => {
        attempts[stage]++;
        if (stage === failedStage && attempts[stage] === 1)
          throw new Error('Synthetic transient cleanup failure');
      };
      const runtime = createAgentRuntime({
        agent: {
          open: async () => {
            throw new Error('A closed runtime cannot open a model');
          },
          dispose: () => close('agent'),
        },
        computer: fakeComputer({ dispose: async () => close('computer') }),
        workspace: fakeWorkspace({ dispose: () => close('workspace') }),
      });
      const first = runtime.dispose();
      assert.equal(runtime.dispose(), first);
      await assert.rejects(first, /Some runtime resources could not close/);
      assert.deepEqual(attempts, { agent: 1, computer: 1, workspace: 1 });
      await assert.rejects(runtime.runTask(context('/unused')), /stopped/);
      const second = runtime.dispose();
      assert.notEqual(second, first);
      assert.equal(runtime.dispose(), second);
      await second;
      assert.deepEqual(attempts, { agent: 1, computer: 1, workspace: 1, [failedStage]: 2 });
      assert.equal(runtime.dispose(), second);
      await assert.rejects(runtime.runTask(context('/unused')), /stopped/);
    });
  }
});
