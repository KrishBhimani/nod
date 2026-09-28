import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type {
  Agent,
  AgentToolResult,
  RuntimeContext,
  RuntimeObservation,
} from '../src/ports/agent.ts';
import type { IntegrationProvider, IntegrationSession } from '../src/ports/integrations.ts';
import { createFilesystemObjectStore } from '../src/providers/object-storage/filesystem.ts';
import { createPiCheckpoint } from '../src/providers/pi/checkpoint.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { createIntegrations } from '../src/server/integrations.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

const rejection = {
  status: 'rejected',
  code: 'invalid_search_arguments',
  message:
    'SEARCH_TOOLS requires a query of 1 to 1000 characters and accepts an optional UUID connectionId. No app request was sent. Correct the arguments before continuing.',
};
const query = 'List Gmail labels';
const searchResult = {
  tools: { GMAIL_LIST_LABELS: { inputSchema: { type: 'object' } } },
  suggestions: [{ useCase: query, primaryToolSlugs: ['GMAIL_LIST_LABELS'] }],
};
type Execute = (id: string, action: string, args: Record<string, unknown>) => Promise<unknown>;

function resultValue(result: AgentToolResult) {
  const part = result.content.find((value) => value.type === 'text');
  assert.ok(part && part.type === 'text');
  return JSON.parse(part.text);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  t: TestContext,
  run: (execute: Execute, connectionId: string) => Promise<void>,
  options: {
    controller?: AbortController;
    search?: IntegrationSession['search'];
    execute?: IntegrationSession['execute'];
    observe?: (event: RuntimeObservation) => Promise<void>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-integration-search-recovery-'));
  const schema = `test_search_recovery_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  const app = Fastify();
  let runtime: ReturnType<typeof createAgentRuntime> | undefined;
  t.after(async () => {
    try {
      await runtime?.dispose();
      await app.close();
    } finally {
      await pool.end();
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await admin.end();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const owner = randomUUID();
  const connectionId = randomUUID();
  const calendarId = randomUUID();
  const foreignId = randomUUID();
  const taskId = randomUUID();
  const searches: string[] = [];
  const calls: Array<{ action: string; args: Record<string, unknown>; accountId?: string }> = [];
  const sessions: Array<{ owner: string; accounts: unknown }> = [];
  const events: string[] = [];
  const observations: RuntimeObservation[] = [];
  const modelResults: unknown[] = [];
  const session: IntegrationSession = {
    id: 'fixture-search-session',
    authorize: async () => {
      throw new Error('Unexpected fixture authorization.');
    },
    search: async (value) => {
      searches.push(value);
      return options.search ? options.search(value) : searchResult;
    },
    execute: async (action, args, accountId) => {
      calls.push({ action, args, accountId });
      return options.execute
        ? options.execute(action, args, accountId)
        : { successful: true, data: { labels: [{ id: 'fixture-label' }] } };
    },
  };
  const provider: IntegrationProvider = {
    id: 'fixture',
    configured: true,
    webhooksConfigured: false,
    supportsSubscriptions: [],
    createSession: async (sessionOwner, accounts) => {
      sessions.push({ owner: sessionOwner, accounts });
      return session;
    },
    restoreSession: async () => session,
    deleteSession: async () => {},
    inspectAccount: async (id) => ({
      active: true,
      service: id === 'fixture-calendar' ? 'googlecalendar' : 'gmail',
    }),
    deleteAccount: async () => {
      throw new Error('Unexpected fixture account deletion.');
    },
    subscribe: async () => {
      throw new Error('Unexpected fixture subscription.');
    },
    unsubscribe: async () => {
      throw new Error('Unexpected fixture unsubscribe.');
    },
    parseCallback: () => {
      throw new Error('Unexpected fixture callback.');
    },
    verifyWebhook: async () => {
      throw new Error('Unexpected fixture webhook.');
    },
    matchesSubscription: () => false,
  };
  const integrations = await createIntegrations(pool, {
    ownerId: owner,
    provider,
    baseUrl: 'http://localhost:4310',
    wake: async () => {
      throw new Error('Unexpected fixture wake.');
    },
  });
  integrations.registerRoutes(app);
  await app.ready();
  await pool.query(
    `INSERT INTO app_connections(id,owner_id,slug,account_id,provider_id,account_checked_at)
     VALUES($1,$2,'gmail','fixture-gmail','fixture',now()),
     ($3,$2,'googlecalendar','fixture-calendar','fixture',now()),
     ($4,$5,'gmail','fixture-foreign','fixture',now())`,
    [connectionId, owner, calendarId, foreignId, randomUUID()],
  );
  const store = createFilesystemObjectStore(join(directory, 'objects'));
  const checkpoint = await createPiCheckpoint({ store, taskId, directory });
  const agent: Agent = {
    open: async ({ tools }) => ({
      resumed: false,
      prompt: async () => {
        const tool = tools.find((value) => value.name === 'apps')!;
        await run(async (id, action, args) => {
          const result = resultValue(
            await checkpoint.execute(id, 'apps', () => tool.execute({ action, args })),
          );
          modelResults.push(result);
          return result;
        }, connectionId);
      },
      abort() {},
      dispose() {},
    }),
    dispose() {},
  };
  runtime = createAgentRuntime({ agent, computer: fakeComputer(), workspace: fakeWorkspace() });
  const context: RuntimeContext = {
    taskId,
    ownerId: owner,
    prompt: 'Get the synthetic Gmail label count without reading or changing messages.',
    history: [],
    memories: [],
    attachments: [],
    workspacePath: directory,
    signal: (options.controller ?? new AbortController()).signal,
    emit: async (type) => {
      events.push(type);
    },
    observe: async (event) => {
      observations.push(event);
      await options.observe?.(event);
    },
    reply: async () => {},
    delta() {},
    remember: async () => {},
    publish: async () => {
      throw new Error('Unexpected fixture publication.');
    },
    requestCredential: async () => {
      throw new Error('Unexpected fixture credential request.');
    },
    integration: (action, args) =>
      integrations.execute(owner, action, args, taskId, context.signal),
    manage: async () => {
      throw new Error('Unexpected fixture management.');
    },
  };
  const saved = async () =>
    (await store.read(`sessions/${taskId}.jsonl`, 1024 * 1024))!.bytes.toString();
  return {
    searches,
    calls,
    sessions,
    events,
    observations,
    modelResults,
    store,
    owner,
    connectionId,
    calendarId,
    foreignId,
    saved,
    run: () => runtime!.runTask(context),
    restore: () => createPiCheckpoint({ store, taskId, directory: join(directory, 'restored') }),
  };
}

function receipts(saved: string, kind: 'pending' | 'completed') {
  return saved
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'custom' && entry.customType === `otto_tool_${kind}`);
}

test(
  'search accepts an account hint, preserves owner-wide discovery and durably completes before the read',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const entered = deferred();
    const release = deferred();
    const f = await fixture(t, async (execute, connectionId) => {
      const result = await execute('search', 'SEARCH_TOOLS', { query: ` ${query} `, connectionId });
      assert.deepEqual(
        (result as { accounts: Array<{ connectionId: string }> }).accounts
          .map((item) => item.connectionId)
          .sort(),
        [f.connectionId, f.calendarId].sort(),
      );
      await execute('labels', 'GMAIL_LIST_LABELS', { connectionId, user_id: 'me' });
    });
    const write = f.store.write;
    let held = false;
    f.store.write = async (...args) => {
      if (!held && receipts(Buffer.from(args[1]).toString(), 'completed').length) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return write(...args);
    };
    const running = f.run();
    try {
      await Promise.race([entered.promise, running]);
      assert.equal(held, true);
      assert.deepEqual(f.searches, [query]);
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.modelResults, []);
    } finally {
      release.resolve();
    }
    assert.deepEqual(await running, { status: 'succeeded' });
    assert.deepEqual(f.calls, [
      { action: 'GMAIL_LIST_LABELS', args: { user_id: 'me' }, accountId: 'fixture-gmail' },
    ]);
    assert.deepEqual(f.sessions, [
      {
        owner: f.owner,
        accounts: { gmail: ['fixture-gmail'], googlecalendar: ['fixture-calendar'] },
      },
    ]);
    assert.equal(receipts(await f.saved(), 'completed').length, 2);
    const restored = await f.restore();
    await assert.rejects(
      restored.execute('search', 'apps', async () => {
        assert.fail('A completed search must not replay after restore.');
      }),
      /could not be saved/,
    );
    assert.equal(f.searches.length, 1);
    assert.equal(f.calls.length, 1);
  },
);

test(
  'a foreign account hint cannot select another owner or narrow discovery',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, async (execute, connectionId) => {
      const result = await execute('search', 'SEARCH_TOOLS', {
        query,
        connectionId: f.foreignId,
      });
      assert.deepEqual(
        (result as { accounts: Array<{ connectionId: string }> }).accounts
          .map((item) => item.connectionId)
          .sort(),
        [f.connectionId, f.calendarId].sort(),
      );
      assert.doesNotMatch(JSON.stringify(result), /fixture-foreign/);
      await execute('labels', 'GMAIL_LIST_LABELS', { connectionId, user_id: 'me' });
    });
    assert.deepEqual(await f.run(), { status: 'succeeded' });
    assert.deepEqual(f.searches, [query]);
    assert.deepEqual(f.sessions, [
      {
        owner: f.owner,
        accounts: { gmail: ['fixture-gmail'], googlecalendar: ['fixture-calendar'] },
      },
    ]);
    assert.deepEqual(f.calls, [
      {
        action: 'GMAIL_LIST_LABELS',
        args: { user_id: 'me' },
        accountId: 'fixture-gmail',
      },
    ]);
    assert.equal(receipts(await f.saved(), 'completed').length, 2);
  },
);

for (const [name, args] of Object.entries({
  empty: { query: '   ' },
  missing: {},
  wrong_type: { query: 7 },
  too_long: { query: 'x'.repeat(1001) },
  unknown_field: { query, extra: 'private-invalid-field' },
  invalid_account: { query, connectionId: 'private-invalid-id' },
})) {
  test(
    `${name} search rejection is completed before corrected discovery and a bounded read`,
    { skip: !process.env.TEST_DATABASE_URL },
    async (t) => {
      const f = await fixture(t, async (execute, connectionId) => {
        assert.deepEqual(await execute('rejected', 'SEARCH_TOOLS', args), rejection);
        assert.deepEqual(f.searches, []);
        assert.deepEqual(f.sessions, []);
        assert.deepEqual(f.calls, []);
        const completed = receipts(await f.saved(), 'completed');
        assert.equal(completed.length, 1);
        assert.deepEqual(resultValue(completed[0].data.result), rejection);
        await execute('corrected', 'SEARCH_TOOLS', { query });
        await execute('labels', 'GMAIL_LIST_LABELS', { connectionId, user_id: 'me' });
      });
      assert.deepEqual(await f.run(), { status: 'succeeded' });
      assert.deepEqual(f.searches, [query]);
      assert.equal(f.calls.length, 1);
      assert.equal(receipts(await f.saved(), 'pending').length, 3);
      assert.equal(receipts(await f.saved(), 'completed').length, 3);
      const restored = await f.restore();
      assert.match(
        JSON.stringify(restored.manager.buildSessionContext().messages),
        /invalid_search_arguments/,
      );
      await assert.rejects(
        restored.execute('rejected', 'apps', async () => {
          assert.fail('A rejected search must not replay after restore.');
        }),
        /could not be saved/,
      );
      assert.equal(f.searches.length, 1);
      assert.equal(f.calls.length, 1);
    },
  );
}

for (const operation of ['search', 'execute'] as const) {
  test(
    `${operation} provider failure retains its unresolved action and prevents continuation`,
    { skip: !process.env.TEST_DATABASE_URL },
    async (t) => {
      const f = await fixture(
        t,
        async (execute, connectionId) => {
          await execute(
            'uncertain',
            operation === 'search' ? 'SEARCH_TOOLS' : 'GMAIL_LIST_LABELS',
            operation === 'search' ? { query } : { connectionId, user_id: 'me' },
          );
          assert.fail('An uncertain provider result must not continue.');
        },
        {
          [operation]: async () => {
            throw new Error('private-provider-diagnostic');
          },
        },
      );
      await assert.rejects(f.run(), /before its result could be confirmed/);
      assert.equal(f.searches.length + f.calls.length, 1);
      assert.deepEqual(f.modelResults, []);
      assert.equal(receipts(await f.saved(), 'pending').length, 1);
      assert.equal(receipts(await f.saved(), 'completed').length, 0);
      assert.doesNotMatch(await f.saved(), /private-provider-diagnostic/);
      await assert.rejects(f.restore(), /interrupted before its result/);
    },
  );
}

for (const stage of ['provider', 'tool_start', 'tool_end'] as const) {
  test(
    `cancellation during ${stage} wait cannot complete a search receipt`,
    { skip: !process.env.TEST_DATABASE_URL },
    async (t) => {
      const controller = new AbortController();
      const entered = deferred();
      const release = deferred();
      const wait = async () => {
        entered.resolve();
        await release.promise;
      };
      const f = await fixture(
        t,
        async (execute) => {
          await execute(
            'cancelled',
            'SEARCH_TOOLS',
            stage === 'provider' ? { query } : { query: '' },
          );
          assert.fail('Cancellation must prevent the next model action.');
        },
        {
          controller,
          search: async () => {
            await wait();
            return searchResult;
          },
          observe: async (event) => {
            if (event.type === stage) await wait();
          },
        },
      );
      const running = assert.rejects(f.run());
      await entered.promise;
      controller.abort();
      release.resolve();
      await running;
      assert.equal(f.searches.length, stage === 'provider' ? 1 : 0);
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.modelResults, []);
      assert.equal(f.observations.filter((event) => event.type === 'tool_end').length, 1);
      assert.equal(receipts(await f.saved(), 'pending').length, 1);
      assert.equal(receipts(await f.saved(), 'completed').length, 0);
      await assert.rejects(f.restore(), /interrupted before its result/);
    },
  );
}

test(
  'a failed rejection receipt write prevents corrected search and remains unresolved after restore',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, async (execute) => {
      await execute('rejected', 'SEARCH_TOOLS', { query: '' });
      await execute('corrected', 'SEARCH_TOOLS', { query });
    });
    const write = f.store.write;
    f.store.write = async (...args) => {
      if (receipts(Buffer.from(args[1]).toString(), 'completed').length)
        throw new Error('private-checkpoint-diagnostic');
      return write(...args);
    };
    await assert.rejects(f.run(), /could not be saved/);
    assert.deepEqual(f.searches, []);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.modelResults, []);
    assert.equal(receipts(await f.saved(), 'pending').length, 1);
    assert.equal(receipts(await f.saved(), 'completed').length, 0);
    assert.doesNotMatch(await f.saved(), /private-checkpoint-diagnostic/);
    await assert.rejects(f.restore(), /interrupted before its result/);
  },
);
