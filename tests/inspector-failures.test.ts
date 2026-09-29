import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createInspectorStore } from '../src/server/inspector.ts';
import { createProviderUsageStore } from '../src/server/provider-usage.ts';
import {
  completeObservationRefresh,
  groupTurnActivity,
  mergeObservationPage,
} from '../src/web/lib/inspector-observations.ts';
import type { InspectorFailure, InspectorObservationsResponse } from '../src/shared/inspector.ts';

const failure = (id: string, second = 1): InspectorFailure => ({
  id,
  turnId: 'turn',
  occurredAt: `2026-09-25T10:00:0${second}.000Z`,
  diagnostic: { name: 'Error', message: 'Workspace path is outside the configured root.' },
});
const page = (failures: InspectorFailure[]): InspectorObservationsResponse => ({
  calls: [],
  usage: [],
  failures,
  toolUsage: [],
  summary: {
    calls: 0,
    modelRequests: 0,
    failures: failures.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    knownCostUsd: null,
    unpricedRequests: 0,
  },
  hasOlder: false,
});

test('private failure details enrich one public activity row and remain available without a turn timeline', () => {
  const diagnostic = failure('private');
  const items = groupTurnActivity(
    [
      {
        id: 'public',
        turnId: 'turn',
        type: 'failed',
        summary: 'I could not finish this turn.',
        createdAt: diagnostic.occurredAt,
      },
    ],
    [],
    [diagnostic],
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, 'public');
  assert.equal(items[0]!.title, 'Turn failed');
  assert.deepEqual(items[0]!.diagnostic, diagnostic.diagnostic);
  assert.equal(groupTurnActivity([], [], [diagnostic])[0]!.id, 'private');
});

test('failure-only recordings merge, deduplicate, detect retention and bridge refresh pages', async () => {
  const current = page([failure('old')]);
  const newest = {
    ...page([failure('new', 3)]),
    hasOlder: true,
    nextBefore: failure('new', 3).occurredAt,
    nextBeforeId: 'new',
    summary: { ...current.summary, failures: 3 },
  };
  let loads = 0;
  const result = await completeObservationRefresh(
    current,
    newest,
    async () => {
      loads++;
      return page([failure('middle', 2), failure('old')]);
    },
    new AbortController().signal,
  );
  assert.equal(loads, 1);
  assert.equal(result.reset, false);
  assert.deepEqual(
    result.data.failures?.map(({ id }) => id),
    ['new', 'middle', 'old'],
  );
  assert.equal(mergeObservationPage(current, current, 'older').failures?.length, 1);
  assert.equal(
    (
      await completeObservationRefresh(
        current,
        page([]),
        async () => {
          throw new Error('Retention does not need another page.');
        },
        new AbortController().signal,
      )
    ).reset,
    true,
  );
});

test('failure capture bounds pending writes and close drains accepted work', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let inserts = 0;
  const pool = {
    async query(sql: string) {
      if (sql.startsWith('DELETE')) await blocked;
      else inserts++;
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  const store = createInspectorStore(pool, { ownerId: 'fixture', enabled: () => true });
  const writes = Array.from({ length: 20 }, () =>
    store.recordFailure(randomUUID(), new Error('Synthetic bounded failure.')),
  );
  let closed = false;
  const closing = store.close().then(() => {
    closed = true;
  });
  await store.recordFailure(randomUUID(), new Error('After close.'));
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await Promise.all([...writes, closing]);
  assert.equal(inserts, 8);
  assert.equal(closed, true);
});

test('Activity exposes expandable escaped diagnostic text for failures before any model or tool call', async () => {
  const { JSDOM } = await import('jsdom');
  const { act, createElement } = await import('react');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost:4310',
    pretendToBeVisual: true,
  });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node'] as const;
  const original = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const previousFetch = globalThis.fetch;
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  for (const key of keys)
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  const diagnostic = {
    ...failure('private'),
    diagnostic: { name: 'Error', message: '<img src="https://private.test"> Root unavailable.' },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify(page([diagnostic])), {
      headers: { 'content-type': 'application/json' },
    });
  const { createRoot } = await import('react-dom/client');
  const { InspectorActivity } = await import('../src/web/components/inspector-tools.tsx');
  const element = dom.window.document.createElement('div');
  dom.window.document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(InspectorActivity, { events: [] })));
    assert.equal(element.querySelectorAll('.event-list > li').length, 1);
    assert.match(element.textContent!, /Turn failed|Private failure details|Root unavailable/);
    assert.ok(element.querySelector('details pre')?.textContent?.includes('<img'));
    assert.equal(element.querySelector('img'), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globalThis.fetch = previousFetch;
    for (const key of keys) {
      const descriptor = original.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});

test(
  'private failure capture redacts, fences and retains diagnostics without public error changes',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 20_000 },
  async () => {
    const schema = `test_failure_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const { pool, initializeDatabase } = await import('../src/server/db.ts');
    const ownerId = 'local-development';
    const turnId = randomUUID();
    const foreignId = randomUUID();
    const cancelledId = randomUUID();
    const archivedId = randomUUID();
    const runningId = randomUUID();
    let enabled = true;
    const key = 'synthetic-known-provider-key';
    const store = createInspectorStore(pool, {
      ownerId,
      enabled: () => enabled,
      secrets: [key],
    });
    try {
      await initializeDatabase();
      await createProviderUsageStore(pool, {
        ownerId,
        enabled: () => true,
        coverage: [],
      }).initialize();
      const threadId = randomUUID();
      const foreignThreadId = randomUUID();
      const archivedThreadId = randomUUID();
      await pool.query(
        "INSERT INTO threads(id,owner_id,archived_at) VALUES($1,$4,NULL),($2,'foreign',NULL),($3,$4,now())",
        [threadId, foreignThreadId, archivedThreadId, ownerId],
      );
      await pool.query(
        `INSERT INTO turns(id,owner_id,thread_id,source,prompt,status,error) VALUES
        ($1,$6,$7,'user','owned','failed','Fixed public failure.'),
        ($2,'foreign',$8,'user','foreign','failed',NULL),
        ($3,$6,$7,'user','cancelled','cancelled',NULL),
        ($4,$6,$9,'user','archived','failed',NULL),
        ($5,$6,$7,'user','running','running',NULL)`,
        [
          turnId,
          foreignId,
          cancelledId,
          archivedId,
          runningId,
          ownerId,
          threadId,
          foreignThreadId,
          archivedThreadId,
        ],
      );
      const error = Object.assign(
        new Error(
          `Workspace root rejected ${key}. password=synthetic-password token=synthetic-token. Context: ${JSON.stringify({ response: JSON.stringify({ password: 'synthetic-nested-failure-secret', title: 'Useful diagnostic detail' }) })}`,
          {
            cause: Object.assign(new Error('Filesystem access denied.'), { code: 'EACCES' }),
          },
        ),
        { code: 'WORKSPACE_ROOT', response: { body: 'provider-body-private' } },
      );
      error.stack = `Error: ${error.message}\n    at open (/private/workspace.ts:42:9)\nAuthorization: Bearer synthetic-header-secret`;
      await store.recordFailure(turnId, error);
      await store.recordFailure(turnId, error);
      for (const id of [foreignId, cancelledId, archivedId, runningId])
        await store.recordFailure(id, error);
      const recorded = await store.read(turnId);
      assert.equal(recorded?.failures?.length, 1);
      assert.equal(recorded?.summary.failures, 1);
      assert.equal(recorded?.summary.calls, 0);
      assert.equal(recorded?.summary.modelRequests, 0);
      assert.equal(recorded?.summary.knownCostUsd, null);
      const raw = JSON.stringify((await pool.query('SELECT * FROM inspector_records')).rows);
      assert.match(raw, /Workspace root rejected|WORKSPACE_ROOT|EACCES|workspace.ts:42:9/);
      assert.match(raw, /Useful diagnostic detail/);
      assert.doesNotMatch(
        raw,
        /synthetic-known-provider-key|synthetic-password|synthetic-token|synthetic-header-secret|provider-body-private|synthetic-nested-failure-secret/,
      );
      assert.equal((await pool.query('SELECT * FROM inspector_records')).rowCount, 1);
      assert.equal(
        (await pool.query('SELECT error FROM turns WHERE id=$1', [turnId])).rows[0].error,
        'Fixed public failure.',
      );
      assert.equal(await store.read(foreignId), null);
      enabled = false;
      await pool.query("UPDATE turns SET status='failed' WHERE id=$1", [runningId]);
      await store.recordFailure(runningId, error);
      assert.equal((await pool.query('SELECT * FROM inspector_records')).rowCount, 1);
      enabled = true;
      await pool.query("UPDATE inspector_records SET recorded_at=now()-interval '8 days'");
      assert.equal((await store.read(turnId))?.failures?.length, 0);
    } finally {
      await store.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
