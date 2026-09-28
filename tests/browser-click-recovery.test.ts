import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  Agent,
  AgentToolResult,
  RuntimeContext,
  RuntimeObservation,
} from '../src/ports/agent.ts';
import { BrowserActionError, type BrowserAction, type Computer } from '../src/ports/computer.ts';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import { createFilesystemObjectStore } from '../src/providers/object-storage/filesystem.ts';
import { createPiCheckpoint } from '../src/providers/pi/checkpoint.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

type Execute = (id: string, input: BrowserAction) => Promise<AgentToolResult>;

async function fixture(
  computer: Computer,
  run: (execute: Execute) => Promise<void>,
  options: {
    controller?: AbortController;
    observe?: (event: RuntimeObservation) => Promise<void>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-click-recovery-'));
  const taskId = randomUUID();
  const store = createFilesystemObjectStore(join(directory, 'objects'));
  const checkpoint = await createPiCheckpoint({ store, taskId, directory });
  const observations: RuntimeObservation[] = [];
  const agent: Agent = {
    open: async ({ tools }) => ({
      resumed: false,
      prompt: async () => {
        const tool = tools.find((value) => value.name === 'browser')!;
        await run((id, input) =>
          checkpoint.execute(id, 'browser', () => tool.execute({ ...input })),
        );
      },
      abort() {},
      dispose() {},
    }),
    dispose() {},
  };
  const runtime = createAgentRuntime({ agent, computer, workspace: fakeWorkspace() });
  const context: RuntimeContext = {
    taskId,
    ownerId: 'fixture',
    prompt: 'Open the synthetic destination after dismissing its covering dialog.',
    history: [],
    memories: [],
    attachments: [],
    workspacePath: directory,
    signal: (options.controller ?? new AbortController()).signal,
    emit: async () => {},
    observe: async (event) => {
      observations.push(event);
      await options.observe?.(event);
    },
    reply: async () => {},
    delta() {},
    remember: async () => {},
    publish: async () => {
      throw new Error('unused');
    },
    requestCredential: async () => ({}),
    integration: async () => ({}),
    manage: async () => ({}),
  };
  return {
    observations,
    run: () => runtime.runTask(context),
    saved: async () =>
      (await store.read(`sessions/${taskId}.jsonl`, 1024 * 1024))!.bytes.toString(),
    restore: () => createPiCheckpoint({ store, taskId, directory: join(directory, 'restored') }),
    async close() {
      try {
        await runtime.dispose();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

const resultValue = (result: AgentToolResult) => {
  const part = result.content.find((value) => value.type === 'text');
  assert.ok(part && part.type === 'text');
  return JSON.parse(part.text);
};

test('a refused click has a terminal receipt and can be observed without replay after restore', async () => {
  let calls = 0;
  const f = await fixture(
    fakeComputer({
      act: async () => {
        calls++;
        if (calls === 1) {
          const error = new BrowserActionError('browser_click_intercepted');
          error.message = 'private fixture blocker value';
          throw error;
        }
        return { text: 'Synthetic blocking dialog', url: 'https://example.test', candidates: [] };
      },
    }),
    async (execute) => {
      const result = resultValue(
        await execute('refused-click', { action: 'click', selector: '@e1' }),
      );
      assert.equal(result.status, 'blocked');
      assert.equal(result.code, 'browser_click_intercepted');
      assert.match(result.message, /click was not performed/);
      assert.doesNotMatch(JSON.stringify(result), /private fixture/);
      assert.equal(calls, 1);
      await execute('observe', { action: 'snapshot' });
    },
  );
  try {
    assert.deepEqual(await f.run(), { status: 'succeeded' });
    assert.equal(calls, 2);
    const saved = await f.saved();
    assert.equal((saved.match(/otto_tool_pending/g) ?? []).length, 2);
    assert.equal((saved.match(/otto_tool_completed/g) ?? []).length, 2);
    assert.doesNotMatch(saved, /private fixture/);
    const restored = await f.restore();
    await assert.rejects(
      restored.execute('refused-click', 'browser', async () => {
        calls++;
        return { content: [] };
      }),
      /could not be saved/,
    );
    assert.equal(calls, 2);
    assert.equal(
      f.observations.filter((event) => event.type === 'tool_end' && event.status === 'failed')
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

for (const failure of ['unknown', 'forged', 'navigation', 'wrong_action', 'cancelled_observation'])
  test(`${failure} browser failure retains an unresolved action receipt`, async () => {
    const controller = new AbortController();
    let calls = 0;
    const f = await fixture(
      fakeComputer({
        act: async () => {
          calls++;
          if (failure === 'unknown') throw new Error('Private unknown outcome');
          if (failure === 'forged')
            throw Object.assign(new Error('Private forged error'), {
              code: 'browser_click_intercepted',
            });
          throw new BrowserActionError(
            failure === 'navigation' ? 'browser_navigation_failed' : 'browser_click_intercepted',
          );
        },
      }),
      async (execute) => {
        await execute('uncertain', {
          action: failure === 'wrong_action' ? 'snapshot' : 'click',
          selector: '@e1',
        });
        assert.fail('An uncertain browser result must not continue.');
      },
      {
        controller,
        observe: async (event) => {
          if (failure === 'cancelled_observation' && event.type === 'tool_end') controller.abort();
        },
      },
    );
    try {
      await assert.rejects(f.run());
      assert.equal(calls, 1);
      assert.match(await f.saved(), /otto_tool_pending/);
      assert.doesNotMatch(await f.saved(), /otto_tool_completed|Private unknown|Private forged/);
      await assert.rejects(f.restore(), /interrupted before its result/);
    } finally {
      await f.close();
    }
  });

test(
  'native covered link refuses input, completes its receipt, and succeeds only after a newly observed dismissal',
  { skip: !process.env.OTTO_TEST_BROWSER_EXECUTABLE, timeout: 60_000 },
  async () => {
    let navigations = 0;
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      if (request.url === '/destination') {
        navigations++;
        response.end('<html><body>Destination reached</body></html>');
      } else
        response.end(
          `<html><body><a href="/destination" style="position:fixed;left:40px;top:40px">Open destination</a><div style="position:fixed;inset:0;z-index:10;background:white"><p>Blocking dialog</p><button onclick="this.parentElement.remove()">Dismiss dialog</button></div></body></html>`,
        );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const root = await mkdtemp(join(tmpdir(), 'otto-native-click-'));
    const computer = createAgentBrowserComputer({
      dataRoot: root,
      browserExecutable: process.env.OTTO_TEST_BROWSER_EXECUTABLE,
      headless: true,
    });
    const f = await fixture(computer, async (execute) => {
      const opened = resultValue(await execute('open', { action: 'open', url: origin }));
      const target = opened.candidates.find((value: { label: string }) =>
        value.label.includes('Open destination'),
      );
      assert.ok(target);
      const refused = resultValue(
        await execute('blocked', { action: 'click', selector: target.id }),
      );
      assert.equal(refused.code, 'browser_click_intercepted');
      assert.equal(refused.status, 'blocked');
      assert.equal(navigations, 0);
      const observed = resultValue(await execute('observe', { action: 'snapshot' }));
      const dismiss = observed.candidates.find((value: { label: string }) =>
        value.label.includes('Dismiss dialog'),
      );
      assert.ok(dismiss);
      assert.equal(navigations, 0);
      const cleared = resultValue(
        await execute('dismiss', { action: 'click', selector: dismiss.id }),
      );
      const fresh = cleared.candidates.find((value: { label: string }) =>
        value.label.includes('Open destination'),
      );
      assert.ok(fresh);
      assert.equal(navigations, 0);
      const arrived = resultValue(
        await execute('navigate', { action: 'click', selector: fresh.id }),
      );
      assert.match(arrived.text, /Destination reached/);
      assert.equal(navigations, 1);
    });
    try {
      assert.deepEqual(await f.run(), { status: 'succeeded' });
      assert.equal((await f.saved()).match(/otto_tool_pending/g)?.length, 5);
      assert.equal((await f.saved()).match(/otto_tool_completed/g)?.length, 5);
      await f.restore();
      assert.equal(navigations, 1);
    } finally {
      try {
        await f.close();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
