import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  InspectorObservationsResponse,
  ModelUsage,
  ToolCall,
} from '../src/shared/inspector.ts';
import {
  ModelUsageRecord,
  ModelUsageSummary,
  ToolCallRecord,
} from '../src/web/components/inspector-tools.tsx';
import {
  completeObservationRefresh,
  filterToolCalls,
  formatModelCost,
  formatToolDuration,
  mergeObservationPage,
} from '../src/web/lib/inspector-observations.ts';

function call(id: string, patch: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    taskId: 'fixture-task',
    revision: 1,
    name: 'browser',
    input: { action: 'read', url: 'https://example.com' },
    output: null,
    status: 'running',
    startedAt: '2026-09-24T12:00:00.000Z',
    finishedAt: null,
    durationMs: null,
    error: null,
    ...patch,
  };
}
function usage(id: string, patch: Partial<ModelUsage> = {}): ModelUsage {
  return {
    id,
    taskId: 'fixture-task',
    revision: 1,
    provider: 'fixture',
    model: 'fixture-model',
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 25,
    cacheWriteTokens: 10,
    totalTokens: 175,
    costUsd: null,
    costSource: 'unavailable',
    createdAt: '2026-09-24T12:00:00.000Z',
    ...patch,
  };
}
function page(patch: Partial<InspectorObservationsResponse> = {}): InspectorObservationsResponse {
  return {
    calls: [],
    usage: [],
    summary: {
      calls: 0,
      modelRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      knownCostUsd: null,
      unpricedRequests: 0,
    },
    hasOlder: false,
    ...patch,
  };
}

test('inspector pagination merges unified pages without duplicate calls, stale outcomes, or page-based cost totals', () => {
  const current = page({
    calls: [call('b')],
    usage: [usage('m-b')],
    summary: {
      ...page().summary,
      calls: 203,
      modelRequests: 51,
      totalTokens: 10000,
      knownCostUsd: 0.1234,
    },
    hasOlder: true,
    nextBefore: '2026-09-24T11:00:00.000Z',
    nextBeforeId: 'first-cursor',
  });
  const older = page({
    calls: [call('a'), call('b', { status: 'interrupted' })],
    usage: [usage('m-a'), usage('m-b')],
    nextBefore: '2026-09-24T10:00:00.000Z',
    nextBeforeId: 'older-cursor',
    hasOlder: true,
  });
  const combined = mergeObservationPage(current, older, 'older');
  assert.deepEqual(
    combined.calls.map((item) => item.id),
    ['b', 'a'],
  );
  assert.deepEqual(
    combined.usage.map((item) => item.id),
    ['m-b', 'm-a'],
  );
  assert.equal(combined.calls[0].status, 'running');
  assert.deepEqual(combined.summary, current.summary);
  assert.equal(combined.nextBeforeId, 'older-cursor');
  const refresh = page({
    calls: [call('b', { status: 'succeeded', output: { result: 'ready' }, durationMs: 124 })],
    usage: [usage('m-b', { costSource: 'sdk_estimate', costUsd: 0.001 })],
    summary: { ...current.summary, calls: 204 },
    hasOlder: true,
    nextBeforeId: 'newest-page-cursor',
  });
  const refreshed = mergeObservationPage(combined, refresh, 'refresh');
  assert.equal(refreshed.calls[0].status, 'succeeded');
  assert.equal(refreshed.calls.length, 2);
  assert.equal(refreshed.usage[0].costUsd, 0.001);
  assert.equal(refreshed.nextBeforeId, 'older-cursor');
  assert.equal(refreshed.nextBefore, older.nextBefore);
  assert.equal(refreshed.summary.calls, 204);
});

test('inspector search filters loaded call names, input, output and status', () => {
  const calls = [
    call('browser', { status: 'succeeded', output: { title: 'Synthetic report' } }),
    call('shell', {
      name: 'shell',
      input: { command: 'node --version' },
      status: 'failed',
      error: 'Fixture command failed',
    }),
  ];
  assert.deepEqual(
    filterToolCalls(calls, 'REPORT', 'succeeded').map((row) => row.id),
    ['browser'],
  );
  assert.deepEqual(
    filterToolCalls(calls, 'node --version', 'all').map((row) => row.id),
    ['shell'],
  );
  assert.deepEqual(
    filterToolCalls(calls, 'Fixture command', 'failed').map((row) => row.id),
    ['shell'],
  );
  assert.deepEqual(filterToolCalls(calls, 'report', 'failed'), []);
});

test('refresh catches every intermediate unified page when hundreds of recordings arrive', async () => {
  function records(high: number, low: number): InspectorObservationsResponse {
    const rows = Array.from({ length: high - low + 1 }, (_, offset) => {
      const index = high - offset;
      const timestamp = new Date(Date.UTC(2026, 8, 24, 12, 0, index)).toISOString();
      const id = `record-${String(index).padStart(4, '0')}`;
      return index % 2
        ? { kind: 'usage' as const, record: usage(id, { createdAt: timestamp }) }
        : {
            kind: 'call' as const,
            record: call(id, { startedAt: timestamp, status: 'succeeded' }),
          };
    });
    return page({
      calls: rows.filter((row) => row.kind === 'call').map((row) => row.record),
      usage: rows.filter((row) => row.kind === 'usage').map((row) => row.record),
      summary: { ...page().summary, calls: 200, modelRequests: 200, knownCostUsd: 0.1234 },
      hasOlder: true,
      nextBefore: new Date(Date.UTC(2026, 8, 24, 12, 0, low)).toISOString(),
      nextBeforeId: `record-${String(low).padStart(4, '0')}`,
    });
  }
  const current = records(100, 1);
  current.summary = { ...current.summary, calls: 50, modelRequests: 50, knownCostUsd: 0.001 };
  const pages = [records(300, 201), records(200, 101), records(100, 1)];
  const cursors: string[] = [];
  const result = await completeObservationRefresh(
    current,
    records(400, 301),
    async (cursor) => {
      cursors.push(cursor.beforeId!);
      return pages.shift()!;
    },
    new AbortController().signal,
  );
  assert.equal(result.reset, false);
  assert.equal(result.data.calls.length, 200);
  assert.equal(result.data.usage.length, 200);
  assert.equal(
    new Set([...result.data.calls, ...result.data.usage].map((row) => row.id)).size,
    400,
  );
  assert.deepEqual(cursors, ['record-0301', 'record-0201', 'record-0101']);
  assert.equal(result.data.nextBeforeId, current.nextBeforeId);
  assert.equal(result.data.summary.knownCostUsd, 0.1234);
  assert.equal(result.data.calls[0].id, 'record-0400');
  assert.equal(result.data.usage[0].id, 'record-0399');
});

test('refresh updates loaded running calls even when the first page already overlaps', async () => {
  const current = page({
    calls: [call('recent', { status: 'succeeded' }), call('older-running')],
    summary: { ...page().summary, calls: 2 },
  });
  const newest = page({
    calls: [call('recent', { status: 'succeeded' })],
    summary: current.summary,
    hasOlder: true,
    nextBefore: '2026-09-24T12:00:00.000Z',
    nextBeforeId: 'recent',
  });
  let loaded = 0;
  const result = await completeObservationRefresh(
    current,
    newest,
    async () => {
      loaded++;
      return page({ calls: [call('older-running', { status: 'succeeded', output: 'done' })] });
    },
    new AbortController().signal,
  );
  assert.equal(loaded, 1);
  assert.equal(result.data.calls.find((row) => row.id === 'older-running')?.status, 'succeeded');
  assert.equal(result.data.calls.find((row) => row.id === 'older-running')?.output, 'done');
});

test('failed or aborted catch-up cannot change the last loaded observations', async () => {
  const current = page({
    calls: [call('existing', { status: 'succeeded' })],
    summary: { ...page().summary, calls: 1 },
  });
  const original = structuredClone(current);
  const newest = page({
    calls: [call('new', { status: 'succeeded' })],
    summary: { ...current.summary, calls: 2 },
    hasOlder: true,
    nextBefore: '2026-09-24T12:00:00.000Z',
    nextBeforeId: 'new',
  });
  await assert.rejects(
    completeObservationRefresh(
      current,
      newest,
      async () => {
        throw new Error('Fixture network failure');
      },
      new AbortController().signal,
    ),
    /Fixture network failure/,
  );
  assert.deepEqual(current, original);
  await assert.rejects(
    completeObservationRefresh(current, newest, async () => newest, new AbortController().signal),
    /cursor did not advance/,
  );
  const controller = new AbortController();
  await assert.rejects(
    completeObservationRefresh(
      current,
      newest,
      async () => {
        controller.abort();
        return original;
      },
      controller.signal,
    ),
    { name: 'AbortError' },
  );
  assert.deepEqual(current, original);
});

test('retention changes reset loaded history to the current server page', async () => {
  const current = page({
    calls: [call('expired', { status: 'succeeded' })],
    summary: { ...page().summary, calls: 5 },
  });
  const newest = page({
    calls: [call('retained', { status: 'succeeded' })],
    summary: { ...page().summary, calls: 1 },
  });
  const result = await completeObservationRefresh(
    current,
    newest,
    async () => {
      assert.fail('A retention reset must not fetch older pages');
    },
    new AbortController().signal,
  );
  assert.deepEqual(result, { data: newest, reset: true });
});

test('missing model cost and historical recordings never appear as a zero invoice', () => {
  assert.equal(formatModelCost(null), 'Price unavailable');
  assert.equal(formatModelCost(0), 'USD 0.0000');
  assert.equal(formatModelCost(0.0000001), '< USD 0.000001');
  const empty = renderToStaticMarkup(createElement(ModelUsageSummary, { summary: page().summary }));
  assert.match(empty, /No tool or model recordings/);
  assert.doesNotMatch(empty, /USD 0|\$0/);
  const partial = renderToStaticMarkup(
    createElement(ModelUsageSummary, {
      summary: {
        ...page().summary,
        calls: 2,
        modelRequests: 3,
        knownCostUsd: 0.0012,
        unpricedRequests: 2,
      },
    }),
  );
  assert.match(partial, /SDK estimate/);
  assert.match(partial, /USD 0.0012/);
  assert.match(partial, /estimate is partial/);
  assert.match(partial, /recorded assistant model requests/);
  assert.match(
    partial,
    /Compaction, cache warming, speech, browser-provider, other tool\/provider fees, and hosting charges are excluded/,
  );
  assert.match(partial, /not an invoice total/);
  const unavailable = renderToStaticMarkup(
    createElement(ModelUsageRecord, {
      usage: usage('missing', { costUsd: 10, costSource: 'unavailable' }),
    }),
  );
  assert.match(unavailable, /Price unavailable/);
  assert.doesNotMatch(unavailable, /USD 10/);
  assert.equal(formatToolDuration(119999), '2 min 0 s');
});

test('inspector payloads and tool errors render as escaped text without executing HTML or loading remote images', () => {
  const html = renderToStaticMarkup(
    createElement(ToolCallRecord, {
      call: call('hostile', {
        name: '<script>fixture</script>',
        input: { html: '<img src="https://example.com/tracker" onerror="fixture()">' },
        output: '<iframe src="https://example.com">',
        status: 'failed',
        error: '<script>error()</script>',
      }),
    }),
  );
  assert.doesNotMatch(html, /<script|<iframe|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  assert.match(html, /Input JSON/);
  assert.match(html, /Output JSON/);
  assert.match(html, /Private developer data/);
  assert.match(html, /revision 1/);
});
