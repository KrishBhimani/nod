import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  InspectorObservationsResponse,
  ModelUsage,
  ToolCall,
  ToolUsage,
} from '../src/shared/inspector.ts';
import { ProviderUsageRow } from '../src/web/components/inspector-providers.tsx';
import type { ProviderUsageSummary } from '../src/shared/provider-usage.ts';
import {
  ModelUsageRecord,
  ModelUsageSummary,
  ToolCallRecord,
  ToolUsageGroup,
} from '../src/web/components/inspector-tools.tsx';
import {
  completeObservationRefresh,
  filterToolCalls,
  formatModelCost,
  formatToolDuration,
  mergeObservationPage,
  groupTurnActivity,
  compactActivityText,
} from '../src/web/lib/inspector-observations.ts';

function call(id: string, patch: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    turnId: 'fixture-turn',
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
    turnId: 'fixture-turn',
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
function toolUsage(patch: Partial<ToolUsage> = {}): ToolUsage {
  return {
    name: 'browser',
    calls: 204,
    succeeded: 200,
    failed: 2,
    running: 1,
    cancelled: 0,
    interrupted: 1,
    durationSamples: 201,
    totalDurationMs: 603000,
    averageDurationMs: 3000,
    maxDurationMs: 10000,
    lastStartedAt: '2026-09-24T12:00:00.000Z',
    ...patch,
  };
}
function page(patch: Partial<InspectorObservationsResponse> = {}): InspectorObservationsResponse {
  return {
    calls: [],
    usage: [],
    toolUsage: [],
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
    toolUsage: [toolUsage({ calls: 203 })],
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
  assert.deepEqual(combined.toolUsage, current.toolUsage);
  assert.equal(combined.nextBeforeId, 'older-cursor');
  const refresh = page({
    calls: [call('b', { status: 'succeeded', output: { result: 'ready' }, durationMs: 124 })],
    usage: [usage('m-b', { costSource: 'sdk_estimate', costUsd: 0.001 })],
    summary: { ...current.summary, calls: 204 },
    toolUsage: [toolUsage()],
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
  assert.equal(refreshed.toolUsage[0].calls, 204);
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
  assert.match(empty, /No model requests recorded/);
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
});

test('tool usage rows show retained totals, failures and measured durations without inventing per-tool cost', () => {
  const html = renderToStaticMarkup(
    createElement(ToolUsageGroup, { turnId: 'fixture-turn', usage: toolUsage() }),
  );
  assert.match(html, /204/);
  assert.match(html, /2 failed/);
  assert.match(html, /3.0 s average/);
  assert.match(html, /10.0 s longest/);
  assert.match(html, /Duration recorded for 201 of 204 calls/);
  assert.doesNotMatch(html, /USD|estimate|invoice/);
  const unknown = renderToStaticMarkup(
    createElement(ToolUsageGroup, {
      turnId: 'fixture-turn',
      usage: toolUsage({
        durationSamples: 0,
        averageDurationMs: null,
        totalDurationMs: null,
        maxDurationMs: null,
      }),
    }),
  );
  assert.match(unknown, /Duration unavailable/);
  assert.doesNotMatch(unknown, /0 ms/);
});

test('activity pairs legacy tool starts and outcomes without duplicate rows or raw kinds', () => {
  const event = (id: string, type: string, summary: string, second: number, turnId = 'turn-a') => ({
    id,
    type,
    summary,
    turnId,
    createdAt: new Date(Date.UTC(2026, 8, 25, 10, 0, second)).toISOString(),
  });
  const result = groupTurnActivity(
    [
      event('1', 'started', 'Turn started.', 0),
      event('2', 'tool_start', 'browse web', 1),
      event('3', 'tool_start', 'execute code', 2),
      event('4', 'tool_failed', 'execute code', 4),
      event('5', 'tool_complete', 'browse web', 5),
      event('6', 'tool_start', 'browse web', 6),
      event('7', 'tool_complete', 'browse web', 9, 'turn-b'),
    ].reverse(),
  );
  assert.equal(result.length, 5);
  assert.equal(result.find((item) => item.id === '2')?.durationMs, 4000);
  assert.equal(result.find((item) => item.id === '3')?.status, 'failed');
  assert.equal(result.find((item) => item.id === '6')?.status, 'running');
  assert.equal(result.find((item) => item.id === '7')?.durationMs, null);
  assert.equal(result.at(-1)?.title, 'Turn started');
});

test('activity prefers exact tool records even when same-name calls overlap', () => {
  const events = ['tool_start', 'tool_start', 'tool_complete', 'tool_failed'].map(
    (type, index) => ({
      id: `event-${index}`,
      turnId: 'fixture-turn',
      type,
      summary: 'browser',
      createdAt: `2026-09-24T12:00:0${index}.000Z`,
    }),
  );
  const exact = [
    call('a', { status: 'failed', durationMs: 3200, finishedAt: '2026-09-24T12:00:03.200Z' }),
    call('b', {
      status: 'succeeded',
      durationMs: 80,
      startedAt: '2026-09-24T12:00:00.990Z',
      finishedAt: '2026-09-24T12:00:02.080Z',
    }),
  ];
  const result = groupTurnActivity(events, exact);
  assert.equal(result.length, 2);
  assert.equal(result.find((item) => item.id === 'a')?.durationMs, 3200);
  assert.equal(result.find((item) => item.id === 'b')?.durationMs, 80);
  assert.equal(
    compactActivityText(
      'Hourly review of active goals, current context, and saved connection updates. Look for a concrete next action that is due.',
    ),
    'Hourly goal and context review',
  );
  assert.ok(compactActivityText('A long user task '.repeat(50)).length <= 160);
});

test('provider usage distinguishes adapter operations, unknown prices and partial SDK subtotals', () => {
  const usage: ProviderUsageSummary = {
    provider: 'fixture',
    category: 'browser',
    operation: 'act',
    model: null,
    requests: 20,
    failures: 2,
    cancelled: 1,
    durationMs: 5000,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    audioSeconds: null,
    characters: null,
    messages: null,
    bytes: null,
    costUsd: null,
    pricedRequests: 0,
    pricing: 'unavailable',
    lastRecordedAt: '2026-09-25T00:00:00.000Z',
  };
  const unknown = renderToStaticMarkup(createElement(ProviderUsageRow, { usage }));
  assert.match(unknown, /20 operations/);
  assert.match(unknown, /Price unavailable/);
  assert.match(unknown, /can still incur charges/);
  assert.doesNotMatch(unknown, /USD 0|Input tokens/);
  const partial = renderToStaticMarkup(
    createElement(ProviderUsageRow, {
      usage: {
        ...usage,
        provider: '<img src="https://example.com">',
        costUsd: 0.032,
        pricedRequests: 12,
        pricing: 'sdk_estimate',
        inputTokens: 1200,
      },
    }),
  );
  assert.match(partial, /USD 0.0320 estimated/);
  assert.match(partial, /12 of 20 operations priced · partial subtotal/);
  assert.match(partial, /Not an invoice total/);
  assert.match(partial, /Input tokens/);
  assert.doesNotMatch(partial, /<img/);
});

test('legacy activity does not invent durations for overlapping same-name calls or leave completed turns running', () => {
  const types = ['tool_start', 'tool_start', 'tool_complete', 'failed'];
  const result = groupTurnActivity(
    types.map((type, index) => ({
      id: `event-${index}`,
      type,
      turnId: 'turn-a',
      summary: 'browser',
      createdAt: `2026-09-24T12:00:0${index}.000Z`,
    })),
  );
  assert.equal(result.find((item) => item.id === 'event-0')!.durationMs, null);
  assert.equal(result.find((item) => item.id === 'event-1')!.status, 'interrupted');
  assert.ok(result.every((item) => item.status !== 'running'));
});

test('recorded tools do not hide unrecorded tools or older turns in activity', () => {
  const events = [
    {
      id: 'old',
      turnId: 'old-turn',
      type: 'tool_complete',
      summary: 'browser',
      createdAt: '2026-09-24T12:00:01.000Z',
    },
    {
      id: 'earlier',
      turnId: 'fixture-turn',
      type: 'tool_complete',
      summary: 'browser',
      createdAt: '2026-09-24T11:00:00.000Z',
    },
    {
      id: 'missing',
      turnId: 'fixture-turn',
      type: 'tool_complete',
      summary: 'execute code',
      createdAt: '2026-09-24T12:00:00.000Z',
    },
    {
      id: 'matched',
      turnId: 'fixture-turn',
      type: 'tool_complete',
      summary: 'browser',
      createdAt: '2026-09-24T12:00:01.000Z',
    },
    {
      id: 'later',
      turnId: 'fixture-turn',
      type: 'tool_complete',
      summary: 'browser',
      createdAt: '2026-09-24T12:00:03.000Z',
    },
  ];
  const result = groupTurnActivity(events, [
    call('recorded', {
      status: 'succeeded',
      finishedAt: '2026-09-24T12:00:02.000Z',
      durationMs: 2000,
    }),
  ]);
  assert.deepEqual(
    new Set(result.map((item) => item.id)),
    new Set(['old', 'earlier', 'missing', 'later', 'recorded']),
  );
  assert.equal(groupTurnActivity(events, []).length, 5);
});
