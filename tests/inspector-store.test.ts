import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createInspectorStore } from '../src/server/inspector.ts';
import { createProviderUsageStore } from '../src/server/provider-usage.ts';
import type { ModelUsageObservation } from '../src/ports/agent.ts';

test(
  'inspector records owned turns, private payloads, usage and stable history',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 45_000 },
  async (t) => {
    const schema = `test_inspector_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const { pool, initializeDatabase, createInspectorPool } = await import('../src/server/db.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { configuration, ownerId, port } = await import('../src/server/config.ts');
    let enabled = true;
    const secret = 'fixture-provider-secret';
    const store = createInspectorStore(pool, {
      ownerId,
      enabled: () => enabled,
      secrets: [secret],
    });
    const app = await createApp({
      inspector: store,
      configuration: () => configuration({ inspectorEnabled: enabled }),
      runtime: {
        status: () => ({ browser: 'fixture', workspace: 'fixture' }),
        inspectTools: () => [
          { name: 'fixture_tool', description: 'Fixture action', parameters: { type: 'object' } },
        ],
      },
    });
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    const request = (path: string) => app.inject({ url: path, headers });
    const turnId = randomUUID();
    const foreignTurnId = randomUUID();
    const time = new Date().toISOString();
    const usage = (id = randomUUID()): ModelUsageObservation => ({
      type: 'model_usage',
      id,
      provider: 'fixture',
      model: 'fixture-model',
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      totalTokens: 21,
      costUsd: 0.001,
      costSource: 'sdk_estimate',
      createdAt: time,
    });
    async function start(id = randomUUID(), target = turnId) {
      await store.record(target, {
        type: 'tool_start',
        id,
        name: 'fixture_tool',
        input: { query: 'useful', password: 'form-private', result: secret },
        startedAt: time,
      });
      return id;
    }
    try {
      await initializeDatabase();
      await createProviderUsageStore(pool, {
        ownerId,
        enabled: () => true,
        coverage: [],
      }).initialize();
      await t.test(
        'slow inspector queries are cancelled without occupying the task pool',
        async () => {
          const observations = createInspectorPool();
          try {
            await assert.rejects(observations.query('SELECT pg_sleep(5)'), { code: '57014' });
            assert.equal((await observations.query('SELECT 1 AS ready')).rows[0].ready, 1);
            assert.equal((await pool.query('SELECT 1 AS ready')).rows[0].ready, 1);
          } finally {
            await observations.end();
          }
        },
      );
      const threadId = randomUUID();
      const foreignThreadId = randomUUID();
      await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2),($3,$4)', [
        threadId,
        ownerId,
        foreignThreadId,
        'foreign',
      ]);
      await pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status) VALUES($1,$2,$3,'user','fixture','running'),($4,'foreign',$5,'user','foreign','running')",
        [turnId, ownerId, threadId, foreignTurnId, foreignThreadId],
      );
      await t.test(
        'catalog is available before the first run and HTTP access stays private',
        async () => {
          const catalog = await request('/api/inspector/tools');
          assert.equal(catalog.statusCode, 200);
          assert.equal(catalog.json().tools[0].name, 'fixture_tool');
          assert.equal(catalog.headers['cache-control'], 'no-store');
          assert.equal(
            (await request(`/api/inspector/observations?turnId=${foreignTurnId}`)).statusCode,
            404,
          );
          assert.equal(
            (
              await app.inject({
                url: '/api/inspector/tools',
                headers: { ...headers, origin: 'https://foreign.test' },
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (await request(`/api/inspector/observations?turnId=${turnId}&beforeId=${randomUUID()}`))
              .statusCode,
            400,
          );
          assert.equal(
            (await request('/api/inspector/observations?turnId=invalid')).statusCode,
            400,
          );
          assert.equal((await store.read(turnId))!.summary.knownCostUsd, null);
          const all = await request('/api/inspector/observations');
          assert.equal(all.statusCode, 200);
          assert.equal(all.json().scope, 'owner');
        },
      );
      await t.test(
        'starts, results, failures and cancellations are bounded and idempotent',
        async () => {
          const id = await start();
          await start(id);
          await store.record(turnId, {
            type: 'tool_end',
            id,
            name: 'fixture_tool',
            status: 'succeeded',
            output: {
              result: 'useful response',
              password: 'returned-private',
              url: '/credentials/private-link',
            },
            durationMs: 12,
            finishedAt: time,
          });
          await store.record(turnId, {
            type: 'tool_end',
            id,
            name: 'fixture_tool',
            status: 'failed',
            error: 'duplicate',
            durationMs: 20,
            finishedAt: time,
          });
          for (const status of ['failed', 'cancelled'] as const) {
            const next = await start();
            await store.record(turnId, {
              type: 'tool_end',
              id: next,
              name: 'fixture_tool',
              status,
              error: 'Fixed error.',
              durationMs: 13,
              finishedAt: time,
            });
          }
          const read = (await store.read(turnId))!;
          assert.equal(read.summary.calls, 3);
          assert.equal(read.toolUsage.length, 1);
          assert.deepEqual(read.toolUsage[0], {
            name: 'fixture_tool',
            calls: 3,
            succeeded: 1,
            failed: 1,
            cancelled: 1,
            running: 0,
            interrupted: 0,
            durationSamples: 3,
            totalDurationMs: 38,
            averageDurationMs: 38 / 3,
            maxDurationMs: 13,
            lastStartedAt: time,
            providerOperations: 0,
            pricedOperations: 0,
            directCostUsd: null,
            pricing: 'unavailable',
          });
          const call = read.calls.find((row) => row.id === id)!;
          assert.equal(call.status, 'succeeded');
          assert.equal(call.durationMs, 12);
          assert.equal((call.output as { result: string }).result, 'useful response');
          const raw = JSON.stringify((await pool.query('SELECT * FROM inspector_records')).rows);
          for (const value of [secret, 'form-private', 'returned-private', 'private-link'])
            assert.ok(!raw.includes(value), value);
          await start(randomUUID(), foreignTurnId);
          assert.equal(
            (await pool.query('SELECT id FROM inspector_records WHERE turn_id=$1', [foreignTurnId]))
              .rowCount,
            0,
          );
        },
      );
      await t.test(
        'usage counts once, preserves unknown prices and records billed work after the turn ends',
        async () => {
          const priced = usage();
          await store.record(turnId, priced);
          await store.record(turnId, priced);
          await store.record(turnId, { ...usage(), costUsd: 999, costSource: 'unavailable' });
          await store.record(turnId, { ...usage(), costUsd: 0 });
          const pending = await start();
          await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [turnId]);
          await store.record(turnId, {
            type: 'tool_end',
            id: pending,
            name: 'fixture_tool',
            status: 'succeeded',
            output: 'stale result',
            durationMs: 25,
            finishedAt: time,
          });
          await start();
          await store.record(turnId, usage());
          const read = (await store.read(turnId))!;
          assert.equal(read.calls.find((row) => row.id === pending)!.status, 'interrupted');
          assert.equal(read.calls.find((row) => row.id === pending)!.output, null);
          assert.equal(read.summary.calls, 4);
          assert.equal(read.summary.modelRequests, 4);
          assert.equal(read.summary.knownCostUsd, 0.002);
          assert.equal(read.summary.unpricedRequests, 1);
          assert.equal(read.summary.inputTokens, 48);
          assert.equal(read.summary.cacheReadTokens, 12);
          assert.equal(read.summary.totalTokens, 84);
          await pool.query("UPDATE turns SET status='running' WHERE id=$1", [turnId]);
        },
      );
      await t.test(
        'disable stops capture and all new inspector routes; interrupted work is recoverable',
        async () => {
          enabled = false;
          await start();
          await store.record(turnId, usage());
          assert.equal((await store.read(turnId))!.summary.calls, 4);
          assert.equal((await store.read(turnId))!.summary.modelRequests, 4);
          for (const path of [
            '/api/inspector/tools',
            `/api/inspector/observations?turnId=${turnId}`,
          ])
            assert.equal((await request(path)).statusCode, 404);
          enabled = true;
          const first = await start();
          await store.finishSegment(turnId);
          assert.equal(
            (await store.read(turnId))!.calls.find((row) => row.id === first)!.status,
            'interrupted',
          );
          const second = await start();
          await store.recover();
          assert.equal(
            (await store.read(turnId))!.calls.find((row) => row.id === second)!.status,
            'interrupted',
          );
        },
      );
      await t.test(
        'mixed history pages at tied timestamps without duplicates and retains full totals',
        async () => {
          for (let index = 0; index < 105; index++) {
            if (index % 2) await start();
            else await store.record(turnId, usage());
          }
          const first = (await request(`/api/inspector/observations?turnId=${turnId}`)).json();
          assert.equal(first.calls.length + first.usage.length, 100);
          assert.equal(first.hasOlder, true);
          const next = (
            await request(
              `/api/inspector/observations?turnId=${turnId}&before=${encodeURIComponent(first.nextBefore)}&beforeId=${first.nextBeforeId}`,
            )
          ).json();
          const ids = [...first.calls, ...first.usage, ...next.calls, ...next.usage].map(
            (row) => row.id,
          );
          assert.equal(ids.length, 115);
          assert.equal(new Set(ids).size, 115);
          assert.equal(next.hasOlder, false);
          assert.deepEqual(first.summary, next.summary);
          await pool.query(
            "UPDATE inspector_records SET recorded_at=now() - interval '8 days' WHERE id=$1",
            [ids[0]],
          );
          assert.equal(
            (await store.read(turnId))!.summary.calls +
              (await store.read(turnId))!.summary.modelRequests,
            114,
          );
          await createInspectorStore(pool, { ownerId, enabled: () => true }).recover();
          assert.equal(
            (await pool.query('SELECT id FROM inspector_records WHERE id=$1', [ids[0]])).rowCount,
            0,
          );
        },
      );
      await t.test(
        'tool drilldown pages only that tool while aggregates include every retained call',
        async () => {
          const target = randomUUID();
          await pool.query(
            "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status) VALUES($1,$2,$3,'user','aggregate fixture','running')",
            [target, ownerId, threadId],
          );
          await pool.query(
            `INSERT INTO inspector_records(id,owner_id,thread_id,turn_id,kind,name,status,input,started_at,duration_ms)
          SELECT gen_random_uuid(),$1,$3,$2,'tool',CASE WHEN i<=125 THEN 'browser' ELSE 'shell' END,
            CASE WHEN i<=120 THEN 'succeeded' WHEN i<=130 THEN 'failed' ELSE 'running' END,
            jsonb_build_object('index',i),now()-i*interval '1 second',CASE WHEN i<=130 THEN i*10 ELSE NULL END
          FROM generate_series(1,150) i`,
            [ownerId, target, threadId],
          );
          const first = (
            await request(`/api/inspector/observations?turnId=${target}&tool=browser`)
          ).json();
          assert.equal(first.calls.length, 100);
          assert.equal(first.usage.length, 0);
          assert.ok(first.calls.every((row: { name: string }) => row.name === 'browser'));
          assert.equal(first.summary.calls, 150);
          assert.equal(
            first.toolUsage.find((row: { name: string }) => row.name === 'browser').calls,
            125,
          );
          assert.equal(
            first.toolUsage.find((row: { name: string }) => row.name === 'shell').calls,
            25,
          );
          const browser = first.toolUsage[0];
          assert.equal(browser.failed, 5);
          assert.equal(browser.succeeded, 120);
          assert.equal(browser.averageDurationMs, 630);
          assert.equal(browser.maxDurationMs, 1250);
          const second = (
            await request(
              `/api/inspector/observations?turnId=${target}&tool=browser&before=${encodeURIComponent(first.nextBefore)}&beforeId=${first.nextBeforeId}`,
            )
          ).json();
          assert.equal(second.calls.length, 25);
          assert.equal(second.hasOlder, false);
          assert.deepEqual(second.toolUsage, first.toolUsage);
          assert.deepEqual(second.summary, first.summary);
          assert.equal(
            new Set([...first.calls, ...second.calls].map((row: { id: string }) => row.id)).size,
            125,
          );
          const absent = (await store.read(target, { tool: 'unknown_tool' }))!;
          assert.equal(absent.calls.length, 0);
          assert.equal(absent.summary.calls, 150);
          await pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [target]);
          const finished = (await store.read(target, { tool: 'shell' }))!;
          assert.equal(finished.toolUsage.find((row) => row.name === 'shell')!.running, 0);
          assert.equal(finished.toolUsage.find((row) => row.name === 'shell')!.interrupted, 20);
          assert.equal(finished.calls.filter((row) => row.status === 'interrupted').length, 20);
          assert.equal(await store.read(foreignTurnId, { tool: 'browser' }), null);
        },
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
