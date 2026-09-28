import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createAgentSession } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type JsonObject,
} from '@earendil-works/pi-ai';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import type {
  Agent,
  AgentToolResult,
  RuntimeContext,
  RuntimeObservation,
} from '../src/ports/agent.ts';
import type { IntegrationProvider } from '../src/ports/integrations.ts';
import { createFilesystemObjectStore } from '../src/providers/object-storage/filesystem.ts';
import { createPiCheckpoint } from '../src/providers/pi/checkpoint.ts';
import { createPiAgent } from '../src/providers/pi/index.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import {
  BrowserConnectionError,
  createBrowserConnections,
} from '../src/server/browser-connections.ts';
import { createIntegrations } from '../src/server/integrations.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

type Execute = (id: string, name: string, input: Record<string, unknown>) => Promise<unknown>;
const value = (result: AgentToolResult) => {
  const part = result.content.find((entry) => entry.type === 'text');
  assert.ok(part && part.type === 'text');
  return part.text === 'Task paused for website sign-in.' ? part.text : JSON.parse(part.text);
};

async function fixture(
  t: TestContext,
  run: (execute: Execute) => Promise<void>,
  options: {
    fail?: 'database' | 'bind' | 'open' | 'hold';
    controller?: AbortController;
    observe?: (event: RuntimeObservation) => Promise<void>;
    piCalls?: Array<{ id: string; name: string; input: JsonObject }>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-browser-connection-recovery-'));
  const owner = randomUUID();
  const taskId = randomUUID();
  const calls: string[] = [];
  const observations: RuntimeObservation[] = [];
  const questions: string[] = [];
  const queries: string[] = [];
  const foreignId = randomUUID();
  const foreignOwner = randomUUID();
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('CREATE TABLE IF NOT EXISTS browser_connections'))
        return { rows: [], rowCount: 0 };
      queries.push(sql);
      if (options.fail === 'database') throw new Error('Private database fixture detail');
      if (sql === 'SELECT id FROM browser_connections WHERE id=$1 AND owner_id=$2') {
        assert.equal(params[1], owner);
        return {
          rows: params[0] === foreignId && params[1] === foreignOwner ? [{ id: foreignId }] : [],
          rowCount: 0,
        };
      }
      if (sql === 'SELECT status,revision FROM tasks WHERE id=$1 AND owner_id=$2') {
        assert.deepEqual(params, [taskId, owner]);
        return { rows: [{ status: 'running', revision: 0 }], rowCount: 1 };
      }
      assert.ok(
        sql.includes('INSERT INTO browser_connections') ||
          sql.includes("SET state='needs_sign_in'"),
        sql,
      );
      return { rows: [], rowCount: 1 };
    },
    connect: async () => {
      throw new Error('Unexpected fixture transaction');
    },
  } as unknown as Pick<Pool, 'query' | 'connect'>;
  const operation = async (name: string) => {
    calls.push(name);
    if (options.fail === name)
      throw new BrowserConnectionError('Private dispatched fixture detail', 404);
  };
  const computer = fakeComputer({
    bindProfile: () => operation('bind'),
    act: async (_id, action) => {
      await operation(action.action);
      return { text: 'Synthetic public page', url: 'https://example.test/', candidates: [] };
    },
    inspectLogin: async () => {
      await operation('inspect');
      return {
        origin: 'https://example.test',
        url: 'https://example.test/',
        fields: [],
        methods: [],
      };
    },
    hold: () => operation('hold'),
    close: () => operation('close'),
    openSignIn: async () => {},
    finishSignIn: async () => {},
    signInScreenshot: async () => Buffer.from('synthetic'),
    signInControl: async () => {},
  });
  const service = await createBrowserConnections(pool, { ownerId: owner, computer });
  const store = createFilesystemObjectStore(join(directory, 'objects'));
  const modelResults = new Map<string, AgentToolResult & { isError: boolean }>();
  const checkpoint = options.piCalls
    ? undefined
    : await createPiCheckpoint({ store, taskId, directory });
  const scripted: Agent = {
    open: async ({ tools }) => ({
      resumed: false,
      prompt: async () =>
        run(async (id, name, input) => {
          const tool = tools.find((entry) => entry.name === name)!;
          return value(await checkpoint!.execute(id, name, () => tool.execute(input)));
        }),
      abort() {},
      dispose() {},
    }),
    dispose() {},
  };
  let turns = 0;
  const createSession: typeof createAgentSession = async (input) => {
    const result = await createAgentSession(input);
    result.session.agent.streamFunction = (model, request) => {
      for (const message of request.messages)
        if (message.role === 'toolResult') modelResults.set(message.toolCallId, message);
      const call = options.piCalls?.[turns++];
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: call ? 'toolUse' : 'stop',
        content: call
          ? [{ type: 'toolCall', id: call.id, name: call.name, arguments: call.input }]
          : [{ type: 'text', text: 'Synthetic inspection complete.' }],
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
      stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message });
      return stream;
    };
    return result;
  };
  const agent = options.piCalls
    ? createPiAgent({
        provider: 'openai',
        apiKey: 'fixture',
        sessionRoot: join(directory, 'cache'),
        objectStore: store,
        createSession,
      })
    : scripted;
  const runtime = createAgentRuntime({ agent, computer, workspace: fakeWorkspace() });
  t.after(async () => {
    try {
      await runtime.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const context: RuntimeContext = {
    taskId,
    ownerId: owner,
    prompt: 'Inspect a synthetic saved account. Do not submit any credentials.',
    history: [],
    memories: [],
    attachments: [],
    workspacePath: directory,
    signal: (options.controller ?? new AbortController()).signal,
    emit: async () => {},
    reply: async () => {},
    delta() {},
    remember: async () => {},
    publish: async () => {
      throw new Error('Unexpected publication');
    },
    requestCredential: async () => {
      throw new Error('Unexpected credential request');
    },
    integration: async () => ({}),
    manage: async () => ({}),
    browserConnection: (input) =>
      service.request(input, { id: taskId, revision: 0 }, context.signal),
    waitForUser: async (question) => {
      questions.push(question);
    },
    observe: async (event) => {
      observations.push(event);
      await options.observe?.(event);
    },
  };
  return {
    calls,
    queries,
    observations,
    questions,
    modelResults,
    foreignId,
    store,
    run: () => runtime.runTask(context),
    saved: async () =>
      (await store.read(`sessions/${taskId}.jsonl`, 1024 * 1024))!.bytes.toString(),
    restore: () => createPiCheckpoint({ store, taskId, directory: join(directory, 'restored') }),
  };
}

const receipts = (text: string, state: 'pending' | 'completed') =>
  text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.customType === `otto_tool_${state}`);

test('saved credentials and browser sessions have explicit model metadata while UI IDs stay unchanged', async (t) => {
  const owner = randomUUID(),
    vaultId = randomUUID(),
    sessionId = randomUUID();
  const app = Fastify();
  t.after(() => app.close());
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql === 'SELECT * FROM app_connections WHERE owner_id = $1')
        assert.deepEqual(params, [owner]);
      else
        assert.ok(
          sql.includes('CREATE TABLE IF NOT EXISTS app_connections') ||
            sql.includes('UPDATE app_connections SET watch_requested=true'),
        );
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const unexpected = async () => {
    throw new Error('Unexpected provider call');
  };
  const provider: IntegrationProvider = {
    id: 'fixture',
    configured: false,
    webhooksConfigured: false,
    supportsSubscriptions: [],
    createSession: unexpected,
    restoreSession: unexpected,
    deleteSession: unexpected,
    inspectAccount: unexpected,
    deleteAccount: unexpected,
    subscribe: unexpected,
    unsubscribe: unexpected,
    parseCallback: unexpected,
    verifyWebhook: unexpected,
    matchesSubscription: () => false,
  };
  const integrations = await createIntegrations(pool, {
    ownerId: owner,
    provider,
    baseUrl: 'http://localhost:4310',
    wake: unexpected,
    browserAccounts: async () => [
      {
        kind: 'login',
        id: vaultId,
        label: 'Synthetic Vault login',
        origin: 'https://example.test',
        usernameHint: 'fi…',
        updatedAt: new Date().toISOString(),
      },
    ],
    browserConnections: async () => [
      {
        slug: 'browser-example',
        name: 'example.test',
        status: 'connected',
        connectionId: sessionId,
        browserState: 'saved',
        browserUrl: 'https://example.test/private',
        triggersEnabled: false,
        accessPaths: [{ id: sessionId, kind: 'browser', endpoint: 'https://example.test' }],
      },
    ],
  });
  integrations.registerRoutes(app);
  await app.ready();
  const ui = await integrations.list();
  const listed = (await integrations.manageConnections('list')) as Array<Record<string, unknown>>;
  assert.equal(
    listed.find((entry) => entry.connectionId === vaultId)?.browserAccess,
    'credentials_saved',
  );
  assert.equal(
    listed.find((entry) => entry.connectionId === sessionId)?.browserAccess,
    'browser_session',
  );
  assert.deepEqual(ui.find((entry) => entry.connectionId === vaultId)?.accessPaths, [
    { id: vaultId, kind: 'browser', endpoint: 'https://example.test' },
  ]);
  assert.equal(
    ui.some((entry) => 'browserAccess' in entry),
    false,
  );
  assert.equal(
    listed.some((entry) => 'browserUrl' in entry || 'accountId' in entry),
    false,
  );
});

for (const [name, input] of Object.entries({
  missing_scheme: { action: 'connect', url: 'example.test' },
  insecure_url: { action: 'connect', url: 'http://example.test' },
  credential_url: { action: 'connect', url: 'https://user:private-secret@example.test' },
  unknown_field: { action: 'connect', url: 'https://example.test', privateField: 'private-secret' },
})) {
  test(`${name} is rejected before browser work and completes its receipt`, async (t) => {
    const f = await fixture(t, async (execute) => {
      const rejected = (await execute('invalid', 'browser_connection', input)) as {
        status: string;
        code: string;
      };
      assert.equal(rejected.status, 'rejected');
      assert.equal(rejected.code, 'invalid_browser_connection_arguments');
      assert.doesNotMatch(JSON.stringify(rejected), /private-secret|private-invalid/);
      assert.deepEqual(f.calls, []);
      await execute('observe', 'browser', { action: 'snapshot' });
    });
    assert.deepEqual(await f.run(), { status: 'succeeded' });
    assert.deepEqual(f.calls, ['snapshot']);
    assert.deepEqual(f.queries, []);
    assert.equal(receipts(await f.saved(), 'completed').length, 2);
    const restored = await f.restore();
    await assert.rejects(
      restored.execute('invalid', 'browser_connection', async () => {
        assert.fail('A rejected call must not replay');
      }),
      /could not be saved/,
    );
  });
}

for (const action of ['connect', 'use']) {
  test(`${action} rejects a foreign or absent session ID without browser work`, async (t) => {
    const f = await fixture(t, async (execute) => {
      for (const [index, connectionId] of [f.foreignId, randomUUID()].entries()) {
        const rejected = (await execute(`missing-${index}`, 'browser_connection', {
          action,
          connectionId,
          url: 'https://example.test',
        })) as { status: string; code: string };
        assert.equal(rejected.status, 'rejected');
        assert.equal(rejected.code, 'browser_connection_unavailable');
      }
    });
    assert.deepEqual(await f.run(), { status: 'succeeded' });
    assert.deepEqual(f.calls, []);
    assert.equal(f.queries.length, 2);
    assert.equal(receipts(await f.saved(), 'completed').length, 2);
    assert.deepEqual(f.questions, []);
  });
}

test('real Pi distinguishes schema rejection from completed server preflight receipts', async (t) => {
  const rejectedByPi: Array<{ id: string; input: JsonObject }> = [
    { id: 'missing-id', input: { action: 'use', url: 'https://example.test' } },
    {
      id: 'malformed-id',
      input: { action: 'use', connectionId: 'synthetic-invalid-id', url: 'https://example.test' },
    },
    { id: 'unknown-action', input: { action: 'wrong', url: 'https://example.test' } },
  ];
  const f = await fixture(t, async () => assert.fail('Real Pi must execute the calls'), {
    piCalls: [
      ...rejectedByPi.map((call) => ({ ...call, name: 'browser_connection' })),
      {
        id: 'vault-id',
        name: 'browser_connection',
        input: { action: 'use', connectionId: randomUUID(), url: 'https://example.test' },
      },
      {
        id: 'invalid-url',
        name: 'browser_connection',
        input: { action: 'connect', url: 'example.test' },
      },
      { id: 'fresh-observation', name: 'browser', input: { action: 'snapshot' } },
    ],
  });
  assert.deepEqual(await f.run(), { status: 'succeeded' });
  for (const call of rejectedByPi) assert.equal(f.modelResults.get(call.id)?.isError, true);
  for (const [id, code] of [
    ['vault-id', 'browser_connection_unavailable'],
    ['invalid-url', 'invalid_browser_connection_arguments'],
  ]) {
    const result = f.modelResults.get(id)!;
    assert.equal(result.isError, false);
    assert.equal(value(result).code, code);
  }
  assert.deepEqual(f.calls, ['snapshot']);
  assert.equal(f.queries.length, 1);
  assert.equal(f.observations.filter((event) => event.type === 'tool_start').length, 3);
  const saved = await f.saved();
  const completed = receipts(saved, 'completed').map((entry) => entry.data.callId);
  assert.deepEqual(completed, ['vault-id', 'invalid-url', 'fresh-observation']);
  assert.deepEqual(
    receipts(saved, 'pending').map((entry) => entry.data.callId),
    completed,
  );
  const restored = await f.restore();
  assert.equal(
    restored.manager
      .buildSessionContext()
      .messages.filter((message) => message.role === 'toolResult').length,
    6,
  );
  await assert.rejects(
    restored.execute('vault-id', 'browser_connection', async () => assert.fail('No replay')),
    /could not be saved/,
  );
});

test('a valid new connection still opens a private sign-in link and stops the segment', async (t) => {
  const f = await fixture(t, async (execute) => {
    await execute('connect', 'browser_connection', {
      action: 'connect',
      url: 'https://example.test',
    });
  });
  assert.equal((await f.run()).status, 'waiting_user');
  assert.deepEqual(f.calls, ['bind', 'open', 'inspect', 'hold']);
  assert.equal(f.questions.length, 1);
  assert.match(f.questions[0], /\[Connect website\]\(\/browser-connect\/[A-Za-z0-9_-]{43}\)/);
  assert.equal(receipts(await f.saved(), 'completed').length, 1);
});

for (const fail of ['database', 'bind', 'open', 'hold'] as const) {
  test(`${fail} failures remain unresolved and cannot be replayed`, async (t) => {
    const f = await fixture(
      t,
      async (execute) => {
        await execute('failed', 'browser_connection', {
          action: 'connect',
          url: 'https://example.test',
        });
      },
      { fail },
    );
    await assert.rejects(f.run());
    assert.equal(receipts(await f.saved(), 'pending').length, 1);
    assert.equal(receipts(await f.saved(), 'completed').length, 0);
    await assert.rejects(f.restore(), /interrupted before its result was saved/);
    assert.deepEqual(f.questions, []);
    assert.doesNotMatch(JSON.stringify(f.observations), /Private dispatched|Private database/);
  });
}

test('cancellation while recording a rejection leaves the pending receipt fenced', async (t) => {
  const controller = new AbortController();
  const f = await fixture(
    t,
    async (execute) => {
      await execute('cancelled', 'browser_connection', {
        action: 'use',
        url: 'https://example.test',
        connectionId: randomUUID(),
      });
      assert.fail('Cancellation must not return another model result');
    },
    {
      controller,
      observe: async (event) => {
        if (event.type === 'tool_end') controller.abort();
      },
    },
  );
  await assert.rejects(f.run());
  assert.deepEqual(f.calls, []);
  assert.equal(f.observations.filter((event) => event.type === 'tool_end').length, 1);
  assert.equal(receipts(await f.saved(), 'completed').length, 0);
  await assert.rejects(f.restore(), /interrupted before its result was saved/);
});

test('a failed rejection receipt write stops the model and fences restoration', async (t) => {
  const f = await fixture(t, async (execute) => {
    await execute('unsaved', 'browser_connection', {
      action: 'use',
      url: 'https://example.test',
      connectionId: randomUUID(),
    });
    assert.fail('An unsaved rejection must not return to the model');
  });
  const write = f.store.write;
  f.store.write = async (...args) => {
    if (receipts(Buffer.from(args[1]).toString(), 'completed').length)
      throw new Error('Private write failure');
    return write(...args);
  };
  await assert.rejects(f.run());
  assert.deepEqual(f.calls, []);
  assert.equal(receipts(await f.saved(), 'completed').length, 0);
  await assert.rejects(f.restore(), /interrupted before its result was saved/);
});
