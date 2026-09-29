import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProviderUsageSummary } from '../src/shared/provider-usage.ts';
import { groupProviderUsage, summarizeProviderUsage } from '../src/web/lib/provider-usage.ts';
import { InspectorProviders } from '../src/web/components/inspector-providers.tsx';
import {
  InspectorTools,
  ToolCallRecord,
  ToolUsageGroup,
} from '../src/web/components/inspector-tools.tsx';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Event',
  'MouseEvent',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const usage = (patch: Partial<ProviderUsageSummary> = {}): ProviderUsageSummary => ({
  provider: 'fixture',
  category: 'agent',
  operation: 'response',
  model: null,
  requests: 1,
  failures: 0,
  cancelled: 0,
  durationMs: 1,
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
  lastRecordedAt: new Date().toISOString(),
  ...patch,
});

test('overall recorded cost sums each ledger row once and keeps unknown pricing separate from zero', () => {
  assert.equal(summarizeProviderUsage([]).costUsd, null);
  assert.equal(summarizeProviderUsage([usage({ costUsd: 99 })]).costUsd, null);
  assert.deepEqual(
    summarizeProviderUsage([
      usage({ requests: 2, costUsd: 0.12, pricedRequests: 2, pricing: 'sdk_estimate' }),
      usage({ operation: 'compaction', costUsd: 0.03, pricedRequests: 1, pricing: 'sdk_estimate' }),
      usage({ category: 'browser', requests: 3 }),
    ]),
    { operations: 6, pricedOperations: 3, costUsd: 0.15, pricing: 'sdk_estimate', partial: true },
  );
  assert.equal(
    summarizeProviderUsage([usage({ costUsd: 0, pricedRequests: 1, pricing: 'reported' })]).costUsd,
    0,
  );
});

test('provider grouping combines models and categories without duplicating the ledger total', () => {
  const entries = [
    usage({
      provider: 'openai',
      model: 'agent-model',
      requests: 2,
      costUsd: 0.12,
      pricedRequests: 2,
      pricing: 'sdk_estimate',
    }),
    usage({
      provider: 'OpenAI',
      category: 'relevance',
      operation: 'classify',
      model: 'small-model',
      costUsd: 0.03,
      pricedRequests: 1,
      pricing: 'reported',
    }),
    usage({ provider: 'openai', operation: 'compaction' }),
    usage({
      provider: 'composio',
      category: 'integration',
      operation: 'execute',
      requests: 8,
      failures: 2,
    }),
    usage({ provider: 'fixture', costUsd: 0, pricedRequests: 1, pricing: 'reported' }),
  ];
  const groups = groupProviderUsage(entries);
  assert.equal(groups.length, 3);
  const openai = groups.find((group) => group.provider === 'openai')!;
  assert.equal(openai.name, 'OpenAI');
  assert.equal(openai.rows.length, 3);
  assert.equal(openai.operations, 4);
  assert.equal(openai.pricedOperations, 3);
  assert.equal(openai.costUsd, 0.15);
  assert.equal(openai.pricing, 'mixed');
  assert.equal(openai.partial, true);
  assert.equal(groups.find((group) => group.provider === 'composio')!.costUsd, null);
  assert.equal(groups.find((group) => group.provider === 'composio')!.failures, 2);
  assert.equal(groups.find((group) => group.provider === 'fixture')!.costUsd, 0);
  assert.equal(
    groups.reduce((sum, group) => sum + (group.costUsd ?? 0), 0),
    summarizeProviderUsage(entries).costUsd,
  );
});

test('tool rows show direct provider prices and partial operation coverage without allocating model cost', () => {
  const common = {
    name: 'browser',
    providerOperations: 4,
    pricedOperations: 2,
    directCostUsd: 0.02,
    pricing: 'sdk_estimate' as const,
  };
  const group = renderToStaticMarkup(
    createElement(ToolUsageGroup, {
      usage: {
        ...common,
        calls: 2,
        succeeded: 2,
        failed: 0,
        running: 0,
        cancelled: 0,
        interrupted: 0,
        durationSamples: 2,
        totalDurationMs: 30,
        averageDurationMs: 15,
        maxDurationMs: 20,
        lastStartedAt: new Date().toISOString(),
      },
    }),
  );
  assert.match(group, /USD 0.0200/);
  assert.match(group, /estimated/);
  assert.match(group, /2\/4 operations priced/);
  const call = renderToStaticMarkup(
    createElement(ToolCallRecord, {
      call: {
        ...common,
        id: 'call',
        turnId: 'turn',
        input: {},
        output: null,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
        error: null,
      },
    }),
  );
  assert.match(call, /Direct provider cost/);
  assert.match(call, /2 of 4 operations priced/);
  assert.match(call, /model costs are separate/);
});

test('Costs shows provider operations without a collapsed parent and fetches only the owner ledger', async () => {
  const previous = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    paths.push(String(input));
    return response({
      scope: 'owner',
      retentionDays: 7,
      captureEnabled: true,
      droppedEvents: 1,
      providers: [
        usage({
          provider: 'openai',
          model: 'model-a',
          costUsd: 0.02,
          pricedRequests: 1,
          pricing: 'sdk_estimate',
        }),
        usage({
          provider: 'openai',
          category: 'relevance',
          operation: 'classify',
          model: 'model-b',
        }),
        usage({ provider: 'composio', category: 'integration', operation: 'execute' }),
      ],
      coverage: [
        {
          provider: 'fixture',
          category: 'agent',
          status: 'recorded',
          note: 'Detailed coverage should not be rendered.',
        },
      ],
    });
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(InspectorProviders)));
    assert.deepEqual(paths, ['/api/inspector/providers']);
    assert.match(element.querySelector('.inspector-cost-overview')!.textContent!, /USD 0.0200/);
    assert.match(element.querySelector('.inspector-cost-overview')!.textContent!, /partial/);
    assert.match(
      element.querySelector('.inspector-cost-overview')!.textContent!,
      /1 of 3 operations priced/,
    );
    const groups = [...element.querySelectorAll<HTMLElement>('.inspector-provider-group')];
    assert.equal(groups.length, 2);
    assert.match(groups[0].querySelector('header')!.textContent!, /OpenAI/);
    assert.equal(groups[0].querySelectorAll('.inspector-provider-operation').length, 2);
    assert.equal(groups[0].tagName, 'SECTION');
    assert.equal(
      groups[0].querySelector('.inspector-provider-operation')!.parentElement!.closest('details'),
      null,
    );
    assert.match(groups[0].textContent!, /Assistant responses.*model-a/);
    assert.match(groups[0].textContent!, /Relevance checks.*model-b/);
    assert.match(groups[0].textContent!, /1 of 2 operations priced/);
    assert.match(groups[1].querySelector('header')!.textContent!, /Price unavailable/);
    assert.doesNotMatch(groups[1].querySelector('header')!.textContent!, /USD 0/);
    assert.match(element.textContent!, /records could not be saved/);
    assert.equal(element.querySelectorAll('select').length, 0);
    assert.doesNotMatch(element.textContent!, /Recording coverage|Detailed coverage/);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = previous;
  }
});

test('tools default to owner-wide recordings and do not repeat the overall cost', async () => {
  const previous = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost:4310');
    urls.push(url);
    if (url.pathname === '/api/inspector/tools')
      return response({
        tools: [],
        captureEnabled: true,
        retentionDays: 7,
        payloadLimitBytes: 16384,
      });
    assert.equal(url.pathname, '/api/inspector/observations');
    assert.equal(url.searchParams.has('turnId'), false);
    return response({
      scope: 'owner',
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
    });
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(InspectorTools)));
    assert.match(element.textContent!, /All activity/);
    assert.match(element.textContent!, /No calls recorded yet/);
    assert.equal(element.querySelectorAll('select').length, 0);
    assert.equal(
      urls.some((url) => url.pathname === '/api/inspector/providers'),
      false,
    );
    assert.doesNotMatch(element.textContent!, /Overall recorded cost|select a task|select a turn/);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = previous;
  }
});
