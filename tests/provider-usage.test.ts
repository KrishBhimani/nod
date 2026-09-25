import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import Fastify from 'fastify';
import { createProviderUsageStore } from '../src/server/provider-usage.ts';
import {
  meterAgent,
  meterIntegrations,
  meterRelevance,
  meterSpeech,
} from '../src/server/provider-metering.ts';
import type { AgentEvent } from '../src/ports/agent.ts';
import type { IntegrationProvider } from '../src/ports/integrations.ts';

test('usage shutdown drains accepted writes and rejects late records', async () => {
  let release!: () => void;
  const pruning = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operations: unknown[] = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.startsWith('DELETE')) await pruning;
      if (sql.includes('INSERT INTO provider_usage')) operations.push(values?.[5]);
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const usage = createProviderUsageStore(pool, {
    ownerId: 'owner',
    enabled: () => true,
    coverage: [],
  });
  const event = {
    provider: 'test',
    category: 'browser' as const,
    status: 'succeeded' as const,
    operation: 'accepted',
    durationMs: 1,
  };
  usage.record(event);
  const closing = usage.close();
  usage.record({ ...event, operation: 'late' });
  release();
  await closing;
  assert.deepEqual(operations, ['accepted']);
});

test(
  'provider usage stays owned, counts all operations, preserves unknown pricing and avoids payload capture',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_usage_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const task = randomUUID(),
      foreign = randomUUID();
    let enabled = true;
    const usage = createProviderUsageStore(pool, {
      ownerId: 'owner',
      enabled: () => enabled,
      coverage: [],
    });
    const app = Fastify();
    try {
      await pool.query('CREATE TABLE tasks(id uuid PRIMARY KEY,owner_id text NOT NULL)');
      await pool.query('INSERT INTO tasks VALUES($1,$2),($3,$4)', [
        task,
        'owner',
        foreign,
        'other',
      ]);
      await usage.initialize();
      usage.registerRoutes(app);
      const base = {
        provider: 'openai',
        category: 'agent' as const,
        operation: 'response',
        status: 'succeeded' as const,
        durationMs: 10,
        taskId: task,
      };
      const id = randomUUID();
      usage.record({ ...base, id, inputTokens: 100, costUsd: 0.01, pricing: 'sdk_estimate' });
      usage.record({ ...base, id, inputTokens: 100, costUsd: 0.01, pricing: 'sdk_estimate' });
      usage.record({ ...base, inputTokens: 25, costUsd: 100, pricing: 'unavailable' });
      usage.record({ ...base, taskId: foreign, inputTokens: 999 });
      await usage.withTask(task, () =>
        usage.track(
          { provider: 'composio', category: 'integration', operation: 'execute' },
          async () => ({ private: 'never stored' }),
        ),
      );
      await assert.rejects(
        usage.track({ provider: 'jev', category: 'relevance', operation: 'classify' }, async () => {
          throw new Error('private provider error');
        }),
      );
      await usage.flush();
      const current = await usage.read(task);
      const model = current.providers.find((row) => row.provider === 'openai')!;
      assert.equal(model.requests, 2);
      assert.equal(model.inputTokens, 125);
      assert.equal(model.costUsd, 0.01);
      assert.equal(model.pricedRequests, 1);
      assert.equal(model.pricing, 'sdk_estimate');
      assert.equal(current.providers.find((row) => row.provider === 'composio')?.costUsd, null);
      assert.equal(
        current.providers.some((row) => row.provider === 'jev'),
        false,
      );
      assert.equal(
        (await usage.read()).providers.find((row) => row.provider === 'jev')?.failures,
        1,
      );
      assert.equal(
        (await app.inject(`/api/inspector/providers?taskId=${foreign}`)).statusCode,
        404,
      );
      assert.doesNotMatch(
        JSON.stringify((await pool.query('SELECT * FROM provider_usage')).rows),
        /never stored|private provider error/,
      );
      enabled = false;
      usage.record(base);
      await usage.flush();
      assert.equal(
        (await usage.read(task)).providers.find((row) => row.provider === 'openai')?.requests,
        2,
      );
      assert.equal((await app.inject('/api/inspector/providers')).statusCode, 404);
      enabled = true;
      await pool.query("UPDATE provider_usage SET recorded_at=now()-interval '8 days'");
      assert.equal((await usage.read()).providers.length, 0);
    } finally {
      await app.close();
      await usage.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('metering covers capabilities without recording prompts, arguments, output or secrets', async () => {
  const rows: unknown[][] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO provider_usage')) rows.push(values!);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as pg.Pool;
  const usage = createProviderUsageStore(pool, {
    ownerId: 'owner',
    enabled: () => true,
    coverage: [],
  });
  const task = randomUUID();
  const events: AgentEvent[] = [];
  const agent = meterAgent(
    {
      async open(options) {
        return {
          resumed: false,
          async prompt() {
            options.onEvent({
              type: 'model_usage',
              id: randomUUID(),
              provider: 'openai',
              model: 'fixture',
              inputTokens: 4,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 6,
              costUsd: 0.1,
              costSource: 'sdk_estimate',
              createdAt: new Date().toISOString(),
            });
            options.onEvent({
              type: 'provider_usage',
              usage: {
                provider: 'openai',
                category: 'agent',
                operation: 'compaction',
                status: 'succeeded',
                durationMs: 3,
                inputTokens: 5,
              },
            });
          },
          abort() {},
          dispose() {},
        };
      },
      dispose() {},
    },
    usage,
  );
  await (
    await agent.open({
      taskId: task,
      systemPrompt: 'private prompt',
      tools: [],
      shouldStop: () => false,
      onEvent: (event) => events.push(event),
    })
  ).prompt('private text', []);
  assert.equal(events.filter((event) => event.type === 'provider_usage').length, 0);
  const speech = meterSpeech(
    {
      id: 'openai',
      configured: true,
      transcribe: async () => 'private transcript',
      synthesize: async () => ({
        bytes: Buffer.from('sound'),
        mimeType: 'audio/mpeg',
        fileName: 'reply.mp3',
      }),
    },
    usage,
  );
  await speech.synthesize('private speech');
  await speech.transcribe({
    bytes: Buffer.from('audio'),
    mimeType: 'audio/wav',
    fileName: 'private.wav',
  });
  await meterRelevance(
    { id: 'jev', configured: true, classify: async () => 'ignore' },
    usage,
  ).classify(
    { private: 'context' },
    {
      instructions: 'private policy',
      criteria: { ignore: '', digest: '', wake: '' },
      minWakeConfidence: 0.5,
    },
  );
  const integration = {
    id: 'composio',
    restoreSession: async () => ({
      id: 'private-session',
      authorize: async () => ({ accountId: 'private-account', url: 'https://secret.example' }),
      search: async () => ({ tools: [], suggestions: [] }),
      execute: async () => ({ private: 'result' }),
    }),
  } as unknown as IntegrationProvider;
  await (
    await meterIntegrations(integration, usage).restoreSession('private-session')
  ).execute('ACTION', { secret: 'private-credential' }, 'private-account');
  await usage.flush();
  assert.deepEqual(
    rows.map((row) => row[5]).sort(),
    [
      'response',
      'compaction',
      'synthesize',
      'transcribe',
      'classify',
      'restore_session',
      'execute',
    ].sort(),
  );
  assert.doesNotMatch(JSON.stringify(rows), /private|secret\.example/);
});

test('slow recording is bounded and never holds a provider operation', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('SELECT provider')) return { rows: [] };
      await gate;
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const usage = createProviderUsageStore(pool, {
    ownerId: 'owner',
    enabled: () => true,
    coverage: [],
  });
  for (let index = 0; index < 140; index++)
    usage.record({
      provider: 'fixture',
      category: 'browser',
      operation: 'snapshot',
      status: 'succeeded',
      durationMs: 1,
    });
  assert.equal(
    await usage.track(
      { provider: 'fixture', category: 'relevance', operation: 'classify' },
      async () => 'ready',
    ),
    'ready',
  );
  assert.ok((await usage.read()).droppedEvents > 0);
  release();
  await usage.close();
});
