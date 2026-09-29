import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { InspectorModels, InspectorTools } from '../src/web/components/inspector-tools.tsx';
import { Inspector } from '../src/web/pages/inspector.tsx';
import type {
  InspectorObservationsResponse,
  ToolCall,
  ToolUsage,
} from '../src/shared/inspector.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'localStorage',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const timestamp = '2026-09-25T12:00:00.000Z';
const aggregate: ToolUsage = {
  name: 'browser',
  calls: 250,
  succeeded: 248,
  failed: 2,
  running: 0,
  cancelled: 0,
  interrupted: 0,
  durationSamples: 250,
  totalDurationMs: 250000,
  averageDurationMs: 1000,
  maxDurationMs: 8000,
  lastStartedAt: timestamp,
};
function call(id: string, turnId: string): ToolCall {
  return {
    id,
    turnId,
    name: 'browser',
    status: 'succeeded',
    input: { command: `fixture-${id}` },
    output: { done: true },
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 1000,
    error: null,
  };
}
function observations(turnId: string, calls: ToolCall[] = []): InspectorObservationsResponse {
  return {
    calls,
    usage: [],
    toolUsage: [aggregate],
    summary: {
      calls: 250,
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
  };
}
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function commonResponse(url: URL) {
  if (url.pathname === '/api/inspector/tools')
    return response({
      tools: [
        { name: 'browser', description: 'Operate the browser.', parameters: { type: 'object' } },
      ],
      captureEnabled: true,
      retentionDays: 7,
      payloadLimitBytes: 16384,
    });
  if (url.pathname === '/api/inspector/prompts')
    return response({
      prompts: [],
      captureEnabled: true,
      retentionDays: 7,
      dropped: 0,
      hasOlder: false,
    });
  if (url.pathname === '/api/inspector/providers')
    return response({
      scope: url.searchParams.has('turnId') ? 'turn' : 'owner',
      turnId: url.searchParams.get('turnId') ?? undefined,
      retentionDays: 7,
      captureEnabled: true,
      droppedEvents: 0,
      providers: [],
      coverage: [],
    });
  return null;
}

test('tool drilldown keeps full totals, requests exact tool pages and preserves calls on a paging error', async () => {
  const previous = globalThis.fetch;
  const requests: URL[] = [];
  let failOlder = true;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost:4310');
    requests.push(url);
    const common = commonResponse(url);
    if (common) return common;
    assert.equal(url.pathname, '/api/inspector/observations');
    assert.equal(url.searchParams.get('turnId'), 'turn-a');
    if (!url.searchParams.has('tool')) return response(observations('turn-a'));
    assert.equal(url.searchParams.get('tool'), 'browser');
    if (url.searchParams.has('before')) {
      if (failOlder)
        return new Response(JSON.stringify({ error: 'Fixture history unavailable.' }), {
          status: 503,
        });
      return response(observations('turn-a', [call('older', 'turn-a')]));
    }
    return response({
      ...observations('turn-a', [call('recent', 'turn-a')]),
      hasOlder: true,
      nextBefore: timestamp,
      nextBeforeId: 'cursor',
    });
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(InspectorTools, { turnId: 'turn-a' })));
    await act(async () =>
      [...element.querySelectorAll('button')]
        .find((button) => button.textContent === 'By tool')!
        .click(),
    );
    assert.match(element.querySelector('.inspector-tool-call-count')!.textContent!, /250/);
    const group = element.querySelector<HTMLDetailsElement>('.inspector-tool-group')!;
    await act(async () => {
      group.open = true;
      group.dispatchEvent(new Event('toggle'));
    });
    assert.equal(element.querySelectorAll('.inspector-tool-drilldown .inspector-record').length, 1);
    assert.match(element.textContent!, /1 of 250 calls loaded/);
    const earlier = () =>
      [...element.querySelectorAll('button')].find(
        (button) => button.textContent === 'Load earlier calls',
      )!;
    await act(async () => earlier().dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.match(element.textContent!, /Fixture history unavailable/);
    assert.equal(element.querySelectorAll('.inspector-tool-drilldown .inspector-record').length, 1);
    failOlder = false;
    await act(async () => earlier().dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(element.querySelectorAll('.inspector-tool-drilldown .inspector-record').length, 2);
    assert.match(element.querySelector('.inspector-tool-call-count')!.textContent!, /250/);
    assert.doesNotMatch(element.textContent!, /Fixture history unavailable/);
    assert.equal(element.querySelectorAll('select').length, 0);
    assert.equal(
      requests.some((url) => url.pathname === '/api/inspector/providers'),
      false,
    );
    assert.match(element.querySelector('.inspector-tool-call-count')!.textContent!, /250/);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = previous;
  }
});

test('late turn observations cannot overwrite the newly selected turn', async () => {
  const previous = globalThis.fetch;
  let finishOld!: (value: Response) => void;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost:4310');
    const common = commonResponse(url);
    if (common) return common;
    if (url.searchParams.get('turnId') === 'turn-a')
      return new Promise<Response>((resolve) => {
        finishOld = resolve;
      });
    return response({
      ...observations('turn-b'),
      toolUsage: [{ ...aggregate, name: 'new_turn_tool' }],
    });
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(InspectorTools, { turnId: 'turn-a' })));
    await act(async () => root.render(createElement(InspectorTools, { turnId: 'turn-b' })));
    await act(async () =>
      [...element.querySelectorAll('button')]
        .find((button) => button.textContent === 'By tool')!
        .click(),
    );
    assert.match(element.querySelector('.inspector-tool-groups')!.textContent!, /new_turn_tool/);
    await act(async () => finishOld(response(observations('turn-a'))));
    assert.match(element.querySelector('.inspector-tool-groups')!.textContent!, /new_turn_tool/);
    assert.doesNotMatch(element.querySelector('.inspector-tool-groups')!.textContent!, /browser/);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = previous;
  }
});

test('inspector follows the current browser independently of message focus with accessible views', async () => {
  const previous = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost:4310');
    requests.push(url);
    if (url.pathname === '/api/inspector/screen') return new Response(null, { status: 404 });
    if (url.pathname.startsWith('/api/browser/control'))
      return response({ active: false, paused: false });
    if (url.pathname === '/api/inspector')
      return response({
        turns: [
          {
            id: 'turn-a',
            source: 'schedule',
            status: 'running',
            createdAt: timestamp,
          },
        ],
        currentBrowser: {
          threadId: 'browser-thread',
          title: 'Open a website',
          status: 'running',
          lastActivityAt: timestamp,
        },
        events: [],
        runtime: { browser: 'Ready', workspace: 'Ready', database: 'Ready' },
      });
    return commonResponse(url) ?? response(observations('turn-a'));
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(Inspector, { onClose() {} })));
    assert.deepEqual(
      [...element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
      ['Screen', 'Activity', 'Tools', 'Models', 'Costs', 'Prompts'],
    );
    assert.equal(element.querySelectorAll('.inspector-context').length, 0);
    assert.doesNotMatch(element.textContent!, /Current run|Selected task|Follow current activity/);
    assert.equal(element.querySelectorAll('select').length, 0);
    assert.match(element.textContent!, /Take control/);
    assert.equal(element.querySelectorAll('.inspector-cost-overview').length, 0);
    assert.equal(
      requests.some((url) => url.pathname === '/api/inspector/providers'),
      false,
    );
    assert.equal(element.querySelectorAll('[role="tab"][tabindex="0"]').length, 1);
    const tabs = [...element.querySelectorAll<HTMLElement>('[role="tab"]')];
    await act(async () =>
      tabs[0]!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      ),
    );
    assert.equal(document.activeElement?.id, 'inspector-tab-activity');
    assert.equal(
      element.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby'),
      'inspector-tab-activity',
    );
    assert.match(element.textContent!, /All activity/);
    assert.match(element.textContent!, /Recent actions/);
    assert.equal(element.querySelector('.inspector-activity')!.closest('details'), null);
    assert.equal(
      requests.some((url) => url.pathname === '/api/inspector/observations'),
      true,
    );
    await act(async () =>
      root.render(
        createElement(Inspector, {
          onClose() {},
          focus: { messageId: 'message-a', turnId: 'turn-a' },
        }),
      ),
    );
    assert.match(element.textContent!, /From this message/);
    await act(async () => tabs[3]!.click());
    assert.match(element.textContent!, /From this message|Model requests/);
    assert.equal(
      requests
        .filter((url) => url.pathname === '/api/inspector/observations')
        .at(-1)
        ?.searchParams.get('turnId'),
      'turn-a',
    );
    await act(async () =>
      tabs[3]!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      ),
    );
    assert.equal(document.activeElement?.id, 'inspector-tab-prompts');
    assert.equal(element.querySelector('[role="tab"][tabindex="0"]')?.id, 'inspector-tab-prompts');
    await act(async () =>
      tabs[5]!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      ),
    );
    assert.equal(document.activeElement?.id, 'inspector-tab-screen');
    await act(async () =>
      tabs[0]!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      ),
    );
    assert.equal(document.activeElement?.id, 'inspector-tab-prompts');
    await act(async () =>
      tabs[5]!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      ),
    );
    assert.equal(document.activeElement?.id, 'inspector-tab-screen');
    await act(async () => tabs[4]!.click());
    assert.doesNotMatch(element.textContent!, /From this message/);
    assert.match(element.textContent!, /Recorded cost|No usage recorded yet/);
    assert.equal(requests.filter((url) => url.pathname === '/api/inspector/providers').length, 1);
    assert.equal(requests.find((url) => url.pathname === '/api/inspector/providers')!.search, '');
    await act(async () => tabs[0]!.click());
    assert.doesNotMatch(element.textContent!, /From this message|Selected task|This turn/);
    assert.match(element.textContent!, /Take control/);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = previous;
  }
});

test('recent calls and catalog descriptions are visible directly while models have a separate scoped view', async () => {
  const previous = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost:4310');
    requests.push(url);
    const common = commonResponse(url);
    if (common) return common;
    assert.equal(url.pathname, '/api/inspector/observations');
    assert.equal(url.searchParams.get('turnId'), 'turn-a');
    return response({
      ...observations('turn-a', [
        call('recent', 'turn-a'),
        { ...call('failure', 'turn-a'), status: 'failed', error: 'Fixture failure' },
      ]),
      summary: { ...observations('turn-a').summary, modelRequests: 1, totalTokens: 15 },
      usage: [
        {
          id: 'model-request',
          turnId: 'turn-a',
          provider: 'fixture',
          model: 'Fixture model',
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 15,
          costUsd: null,
          costSource: 'unavailable',
          createdAt: timestamp,
        },
      ],
    });
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const button = (name: string) =>
    [...element.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === name,
    )!;
  try {
    await act(async () => root.render(createElement(InspectorTools, { turnId: 'turn-a' })));
    assert.equal(button('Recent calls').getAttribute('aria-pressed'), 'true');
    assert.equal(element.querySelectorAll('.inspector-record').length, 2);
    assert.equal(
      element.querySelector('.inspector-record')!.parentElement!.closest('details'),
      null,
    );
    assert.equal(element.querySelectorAll('.inspector-record[open]').length, 0);
    assert.doesNotMatch(element.textContent!, /Fixture model|Assistant model requests/);
    await act(async () => button('Failed').click());
    assert.equal(element.querySelectorAll('.inspector-record').length, 1);
    assert.match(element.textContent!, /Fixture failure/);
    await act(async () => button('Available tools').click());
    assert.match(
      element.querySelector('.inspector-catalog-tool')!.textContent!,
      /Operate the browser/,
    );
    assert.equal(element.querySelector('.inspector-catalog-tool')!.closest('details'), null);
    assert.equal(element.querySelectorAll('.inspector-schema[open]').length, 0);
    await act(async () => root.render(createElement(InspectorModels, { turnId: 'turn-a' })));
    assert.match(element.textContent!, /Fixture model|15 tokens/);
    assert.equal(element.querySelectorAll('.inspector-record').length, 1);
    assert.equal(
      element.querySelector('.inspector-record')!.parentElement!.closest('details'),
      null,
    );
    assert.equal(
      requests.some((url) => url.pathname === '/api/inspector/providers'),
      false,
    );
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = previous;
  }
});
