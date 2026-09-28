import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentSession } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { RuntimeContext, RuntimeObservation } from '../src/ports/agent.ts';
import { WorkspaceExitError } from '../src/ports/computer.ts';
import { createCommandWorkspace } from '../src/providers/docker/index.ts';
import {
  runSupervisedCommand,
  workspaceCommandProgram,
  WorkspaceCommandError,
} from '../src/providers/docker/command.ts';
import { createFilesystemObjectStore } from '../src/providers/object-storage/filesystem.ts';
import { createPiCheckpoint } from '../src/providers/pi/checkpoint.ts';
import { createPiAgent } from '../src/providers/pi/index.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { fakeComputer } from './runtime-fixtures.ts';

async function fixture(options: {
  commands: string[];
  toolName?: 'shell' | 'read_file';
  run?: Parameters<typeof createCommandWorkspace>[0]['runCommand'];
  signal?: AbortSignal;
  observe?: (event: RuntimeObservation) => Promise<void>;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-shell-recovery-'));
  const id = randomUUID();
  const workspacePath = join(directory, id);
  const store = createFilesystemObjectStore(join(directory, 'objects'));
  const observations: RuntimeObservation[] = [];
  const events: string[] = [];
  const inputs: string[] = [];
  const replies: string[] = [];
  let executions = 0;
  const factory: typeof createAgentSession = async (options) => {
    const result = await createAgentSession(options);
    result.session.agent.streamFunction = (model, context) => {
      const index = inputs.length;
      inputs.push(JSON.stringify(context.messages));
      const command = commands[index];
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: command ? 'toolUse' : 'stop',
        content: command
          ? [
              {
                type: 'toolCall',
                id: `shell-${index}`,
                name: toolName,
                arguments: toolName === 'shell' ? { command } : { path: command },
              },
            ]
          : [{ type: 'text', text: 'The fixture calculation is complete.' }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: command ? 'toolUse' : 'stop', message });
      return stream;
    };
    return result;
  };
  const commands = options.commands;
  const toolName = options.toolName ?? 'shell';
  const runtime = createAgentRuntime({
    agent: createPiAgent({
      provider: 'openai',
      apiKey: 'fixture',
      sessionRoot: join(directory, 'cache'),
      objectStore: store,
      createSession: factory,
    }),
    computer: fakeComputer(),
    workspace: createCommandWorkspace({
      workspaceRoot: directory,
      status: 'Synthetic workspace',
      instructions: 'Use only the synthetic fixture workspace.',
      runCommand: (...args) => {
        executions++;
        if (options.run) return options.run(...args);
        return runSupervisedCommand({
          args: args[1],
          ...args[2],
          launch: () =>
            spawn('python3', ['-u', '-c', workspaceCommandProgram], {
              cwd: workspacePath,
              env: { PATH: '/usr/bin:/bin:/usr/local/bin' },
              stdio: 'pipe',
            }),
        });
      },
    }),
  });
  const context: RuntimeContext = {
    taskId: id,
    ownerId: 'fixture',
    prompt: 'Calculate the synthetic fixture result.',
    history: [],
    memories: [],
    attachments: [],
    workspacePath,
    signal: options.signal ?? new AbortController().signal,
    emit: async (type) => {
      events.push(type);
    },
    observe: async (event) => {
      observations.push(event);
      await options.observe?.(event);
    },
    reply: async (text) => {
      replies.push(text);
    },
    delta() {},
    remember: async () => {},
    publish: async () => {
      throw new Error('unused');
    },
    requestCredential: async () => ({}),
    integration: async () => ({}),
    manage: async () => ({}),
  };
  const saved = async () => {
    const value = await store.read(`sessions/${id}.jsonl`, 1024 * 1024);
    return value!.bytes.toString();
  };
  return {
    directory,
    workspacePath,
    id,
    store,
    inputs,
    replies,
    observations,
    events,
    saved,
    executions: () => executions,
    run: () => runtime.runTask(context),
    restore: () =>
      createPiCheckpoint({ store, taskId: id, directory: join(directory, 'replacement') }),
    async close() {
      try {
        await runtime.dispose();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

test('a confirmed nonzero shell exit reaches the model and completes its durable receipt before recovery', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const checkpointing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture({
    commands: [
      'otto-missing-python-fixture',
      `python3 -c 'from pathlib import Path; Path("result.txt").write_text(str(123456 * 789)); print(123456 * 789)'`,
    ],
  });
  const write = f.store.write;
  let held = false;
  f.store.write = async (...args) => {
    if (!held && Buffer.from(args[1]).toString().includes('otto_tool_completed')) {
      held = true;
      entered();
      await gate;
    }
    return write(...args);
  };
  try {
    const operation = f.run();
    await Promise.race([
      checkpointing,
      operation.then(() => {
        throw new Error('The model continued without waiting for its durable receipt.');
      }),
    ]);
    assert.equal(f.inputs.length, 1);
    assert.equal(f.executions(), 1);
    assert.match(await f.saved(), /otto_tool_pending/);
    assert.doesNotMatch(await f.saved(), /otto_tool_completed/);
    release();
    assert.deepEqual(await operation, { status: 'succeeded' });
    assert.equal(f.executions(), 2);
    assert.equal(f.inputs.length, 3);
    assert.match(f.inputs[1], /exitCode\\?":127/);
    assert.match(f.inputs[1], /otto-missing-python-fixture/);
    assert.match(f.inputs[2], /97406784/);
    assert.equal(await readFile(join(f.workspacePath, 'result.txt'), 'utf8'), '97406784');
    assert.deepEqual(f.events, ['tool_start', 'tool_failed', 'tool_start', 'tool_complete']);
    assert.deepEqual(
      f.observations.filter((event) => event.type === 'tool_end').map((event) => event.status),
      ['failed', 'succeeded'],
    );
    const entries = (await f.saved())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const receipt = entries.find(
      (entry) =>
        entry.type === 'custom' &&
        entry.customType === 'otto_tool_completed' &&
        entry.data.callId === 'shell-0',
    );
    assert.ok(receipt);
    const failure = JSON.parse(receipt.data.result.content[0].text);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.exitCode, 127);
    assert.match(failure.output, /otto-missing-python-fixture.*(?:not found|No such file)/);
    const restored = await f.restore();
    assert.match(
      JSON.stringify(restored.manager.buildSessionContext().messages),
      /exitCode\\?":127/,
    );
    await assert.rejects(
      restored.execute('shell-0', 'shell', async () => {
        throw new Error('A completed shell command must not be replayed.');
      }),
      /could not be saved/,
    );
    assert.equal(f.executions(), 2);
  } finally {
    release();
    await f.close();
  }
});

test('only confirmed shell exits recover; cancellation, bounds and unknown outcomes remain fenced', async (t) => {
  const cases = [
    { name: 'lost transport', error: new WorkspaceCommandError(true, 'private transport detail') },
    {
      name: 'timeout after drain',
      error: new WorkspaceCommandError(
        false,
        'Workspace command exceeded its time or output limit.',
      ),
    },
    {
      name: 'cancellation after drain',
      error: new WorkspaceCommandError(false, 'Task cancelled.'),
    },
    { name: 'unknown adapter failure', error: new Error('private provider detail') },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const f = await fixture({
        commands: ['fixture command'],
        run: async () => {
          throw entry.error;
        },
      });
      try {
        await assert.rejects(f.run(), /could not be saved/);
        assert.equal(f.executions(), 1);
        assert.equal(f.inputs.length, 1);
        const saved = await f.saved();
        assert.match(saved, /otto_tool_pending/);
        assert.doesNotMatch(
          saved,
          /otto_tool_completed|private transport detail|private provider detail/,
        );
        await assert.rejects(f.restore(), /interrupted before its result/);
        assert.deepEqual(f.replies, []);
      } finally {
        await f.close();
      }
    });
  }
});

test('cancellation while recording a confirmed shell failure cannot become a completed action receipt', async () => {
  const controller = new AbortController();
  const f = await fixture({
    commands: ['fixture command'],
    signal: controller.signal,
    run: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('synthetic error'),
      exitCode: 7,
    }),
    observe: async (event) => {
      if (event.type === 'tool_end') controller.abort();
    },
  });
  try {
    await assert.rejects(f.run());
    assert.equal(f.inputs.length, 1);
    assert.match(await f.saved(), /otto_tool_pending/);
    assert.doesNotMatch(await f.saved(), /otto_tool_completed/);
    await assert.rejects(f.restore(), /interrupted before its result/);
    assert.deepEqual(f.replies, []);
  } finally {
    await f.close();
  }
});

test('confirmed exit diagnostics are bounded and cannot come from arbitrary error text', async () => {
  const error = new WorkspaceExitError(23, 'x'.repeat(30_000));
  assert.equal(error.output.length, 20_000);
  assert.equal(error.message, 'Workspace command failed.');
  for (const code of [0, NaN, Infinity, 1.5])
    assert.throws(() => new WorkspaceExitError(code, 'private diagnostic'));
  const f = await fixture({
    commands: ['fixture command'],
    run: async () => ({
      stdout: Buffer.from('x'.repeat(30_000)),
      stderr: Buffer.alloc(0),
      exitCode: 23,
    }),
  });
  try {
    assert.deepEqual(await f.run(), { status: 'succeeded' });
    const rows = (await f.saved())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const receipt = rows.find(
      (row) => row.type === 'custom' && row.customType === 'otto_tool_completed',
    );
    const output = JSON.parse(receipt.data.result.content[0].text);
    assert.equal(output.output.length, 20_000);
    assert.equal(output.exitCode, 23);
  } finally {
    await f.close();
  }
});

test('a failed durable error receipt prevents model continuation and restart replay', async () => {
  const f = await fixture({
    commands: ['fixture command'],
    run: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('synthetic failure'),
      exitCode: 2,
    }),
  });
  const write = f.store.write;
  f.store.write = async (...args) => {
    if (Buffer.from(args[1]).toString().includes('otto_tool_completed'))
      throw new Error('private storage failure');
    return write(...args);
  };
  try {
    await assert.rejects(f.run(), /could not be saved/);
    assert.equal(f.executions(), 1);
    assert.equal(f.inputs.length, 1);
    assert.doesNotMatch(await f.saved(), /otto_tool_completed|private storage failure/);
    await assert.rejects(f.restore(), /interrupted before its result/);
    assert.deepEqual(f.replies, []);
  } finally {
    await f.close();
  }
});

test('a nonzero file helper exit does not receive shell recovery privileges', async () => {
  const f = await fixture({
    commands: ['missing-fixture.txt'],
    toolName: 'read_file',
    run: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('synthetic file failure'),
      exitCode: 1,
    }),
  });
  try {
    await assert.rejects(f.run(), /could not be saved/);
    assert.equal(f.executions(), 1);
    assert.equal(f.inputs.length, 1);
    assert.doesNotMatch(await f.saved(), /otto_tool_completed/);
    await assert.rejects(f.restore(), /interrupted before its result/);
  } finally {
    await f.close();
  }
});
