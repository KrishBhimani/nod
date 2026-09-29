import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createProviderUsageStore } from '../src/server/provider-usage.ts';
import { createInspectorStore } from '../src/server/inspector.ts';

test(
  'direct tool usage is scoped to owned calls, isolated across concurrent work and independent of model costs and paging',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 45_000 },
  async () => {
    const schema = `test_tool_usage_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 4,
    });
    const store = createProviderUsageStore(pool, {
      ownerId: 'owner',
      enabled: () => true,
      coverage: [],
    });
    const inspector = createInspectorStore(pool, { ownerId: 'owner', enabled: () => true });
    const firstTurn = randomUUID();
    const secondTurn = randomUUID();
    const foreignTurn = randomUUID();
    const now = new Date().toISOString();
    async function call(turnId: string, name: string) {
      const id = randomUUID();
      await inspector.record(turnId, {
        type: 'tool_start',
        id,
        name,
        input: {},
        startedAt: now,
      });
      await inspector.record(turnId, {
        type: 'tool_end',
        id,
        name,
        status: 'succeeded',
        output: {},
        durationMs: 10,
        finishedAt: now,
      });
      return id;
    }
    const event = {
      provider: 'priced-fixture',
      category: 'browser' as const,
      operation: 'act',
      status: 'succeeded' as const,
      durationMs: 3,
    };
    try {
      await pool.query(`CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz);
      CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),status text NOT NULL DEFAULT 'running',finished_at timestamptz);
      CREATE TABLE inspector_records(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid REFERENCES threads(id),turn_id uuid REFERENCES turns(id),kind text NOT NULL,name text NOT NULL,status text NOT NULL,input jsonb,output jsonb,error text,usage jsonb,duration_ms double precision,started_at timestamptz NOT NULL,finished_at timestamptz,recorded_at timestamptz NOT NULL DEFAULT now());`);
      const ownerThread = randomUUID();
      const foreignThread = randomUUID();
      await pool.query("INSERT INTO threads(id,owner_id) VALUES($1,'owner'),($2,'foreign')", [
        ownerThread,
        foreignThread,
      ]);
      await pool.query(
        "INSERT INTO turns(id,owner_id,thread_id) VALUES($1,'owner',$4),($2,'owner',$4),($3,'foreign',$5)",
        [firstTurn, secondTurn, foreignTurn, ownerThread, foreignThread],
      );
      await store.initialize();
      const firstCall = await call(firstTurn, 'browser');
      const secondCall = await call(secondTurn, 'google');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await Promise.all([
        store.withTool(firstTurn, firstCall, 'browser', async () => {
          await gate;
          store.record({ ...event, costUsd: 0.02, pricing: 'reported' });
          store.record(event);
          store.record({
            ...event,
            category: 'agent',
            operation: 'response',
            costUsd: 0.5,
            pricing: 'sdk_estimate',
          });
        }),
        store.withTool(secondTurn, secondCall, 'google', async () => {
          await Promise.resolve();
          store.record({
            ...event,
            category: 'integration',
            costUsd: 0.03,
            pricing: 'sdk_estimate',
          });
          release();
        }),
      ]);
      store.withTool(firstTurn, firstCall, 'wrong_name', () =>
        store.record({ ...event, costUsd: 0.07, pricing: 'reported' }),
      );
      store.withTool(firstTurn, secondCall, 'google', () =>
        store.record({ ...event, costUsd: 0.08, pricing: 'reported' }),
      );
      store.withTool(foreignTurn, firstCall, 'browser', () =>
        store.record({ ...event, costUsd: 99, pricing: 'reported' }),
      );
      assert.throws(() => store.withTool(firstTurn, 'invalid', 'browser', () => {}));
      assert.throws(() =>
        store.withTool(firstTurn, firstCall, 'secret name with spaces', () => {}),
      );
      await store.flush();
      const first = (await inspector.read(firstTurn))!;
      assert.equal(first.scope, 'turn');
      assert.equal(first.calls[0].directCostUsd, 0.02);
      assert.equal(first.calls[0].providerOperations, 2);
      assert.equal(first.calls[0].pricedOperations, 1);
      assert.equal(first.calls[0].pricing, 'reported');
      assert.equal(first.toolUsage[0].directCostUsd, 0.02);
      const second = (await inspector.read(secondTurn))!;
      assert.equal(second.calls[0].directCostUsd, 0.03);
      const all = (await inspector.read())!;
      assert.equal(all.scope, 'owner');
      assert.equal(all.summary.calls, 2);
      assert.equal(all.summary.providerOperations, 3);
      assert.equal(all.summary.pricedProviderOperations, 2);
      assert.equal(all.summary.directProviderCostUsd, 0.05);
      assert.equal(all.summary.knownCostUsd, null);
      assert.equal(await inspector.read(foreignTurn), null);
      const providerRows = await pool.query('SELECT * FROM provider_usage ORDER BY cost_usd');
      assert.equal(providerRows.rows.find((row) => row.category === 'agent').tool_call_id, null);
      assert.equal(providerRows.rows.filter((row) => row.tool_call_id).length, 3);
      assert.equal(
        providerRows.rows.some((row) => row.turn_id === foreignTurn),
        false,
      );
      assert.ok(
        Math.abs(
          (await store.read()).providers.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) - 0.7,
        ) < 1e-9,
      );
      for (let index = 0; index < 105; index++) {
        const id = await call(firstTurn, 'browser');
        store.withTool(firstTurn, id, 'browser', () =>
          store.record({ ...event, costUsd: 0.001, pricing: 'sdk_estimate' }),
        );
      }
      await store.flush();
      const page = (await inspector.read(undefined, { tool: 'browser' }))!;
      assert.equal(page.calls.length, 100);
      assert.equal(page.hasOlder, true);
      assert.equal(page.toolUsage.find((row) => row.name === 'browser')!.calls, 106);
      assert.ok(
        Math.abs(page.toolUsage.find((row) => row.name === 'browser')!.directCostUsd! - 0.125) <
          1e-9,
      );
      assert.equal(page.toolUsage.find((row) => row.name === 'browser')!.pricing, 'mixed');
      const next = (await inspector.read(undefined, {
        tool: 'browser',
        before: page.nextBefore,
        beforeId: page.nextBeforeId,
      }))!;
      assert.equal(next.calls.length, 6);
      assert.deepEqual(next.toolUsage, page.toolUsage);
      assert.deepEqual(next.summary, page.summary);
      assert.equal(new Set([...page.calls, ...next.calls].map((row) => row.id)).size, 106);
      await pool.query(
        "UPDATE provider_usage SET recorded_at=now()-interval '8 days' WHERE tool_call_id=$1",
        [firstCall],
      );
      const retained = (await inspector.read(firstTurn))!;
      assert.ok(Math.abs(retained.toolUsage[0].directCostUsd! - 0.105) < 1e-9);
      assert.equal(retained.summary.providerOperations, 105);
    } finally {
      await store.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
