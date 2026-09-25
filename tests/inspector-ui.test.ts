import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { InspectorTools } from '../src/web/components/inspector-tools.tsx';
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
function call(id: string, taskId: string): ToolCall {
  return {
    id,
    taskId,
    revision: 1,
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
function observations(taskId: string, calls: ToolCall[] = []): InspectorObservationsResponse {
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
  if (url.pathname === '/api/inspector/work')
    return response({
      scope: 'owner',
      active: [],
      activeTotal: 0,
      upcoming: [],
      upcomingTotal: 0,
      review: { configured: true, scheduled: true, cron: '0 * * * *', timeZone: 'UTC' },
      decisions: [],
      decisionsTotal: 0,
      decisionWindowHours: 24,
    });
  if (url.pathname === '/api/inspector/tools')
    return response({
      tools: [
        { name: 'browser', description: 'Operate the browser.', parameters: { type: 'object' } },
      ],
      captureEnabled: true,
      retentionDays: 7,
      payloadLimitBytes: 16384,
    });
  if (url.pathname === '/api/inspector/providers')
    return response({
      scope: url.searchParams.has('taskId') ? 'task' : 'owner',
      taskId: url.searchParams.get('taskId') ?? undefined,
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
    assert.equal(url.searchParams.get('taskId'), 'task-a');
    if (!url.searchParams.has('tool')) return response(observations('task-a'));
    assert.equal(url.searchParams.get('tool'), 'browser');
    if (url.searchParams.has('before')) {
      if (failOlder)
        return new Response(JSON.stringify({ error: 'Fixture history unavailable.' }), {
          status: 503,
        });
      return response(observations('task-a', [call('older', 'task-a')]));
    }
    return response({
      ...observations('task-a', [call('recent', 'task-a')]),
      hasOlder: true,
      nextBefore: timestamp,
      nextBeforeId: 'cursor',
    });
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(InspectorTools, { taskId: 'task-a' })));
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

test('late task observations cannot overwrite the newly selected task', async () => {
  const previous = globalThis.fetch;
  let finishOld!: (value: Response) => void;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost:4310');
    const common = commonResponse(url);
    if (common) return common;
    if (url.searchParams.get('taskId') === 'task-a')
      return new Promise<Response>((resolve) => {
        finishOld = resolve;
      });
    return response({
      ...observations('task-b'),
      toolUsage: [{ ...aggregate, name: 'new_task_tool' }],
    });
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(InspectorTools, { taskId: 'task-a' })));
    await act(async () => root.render(createElement(InspectorTools, { taskId: 'task-b' })));
    assert.match(element.querySelector('.inspector-tool-groups')!.textContent!, /new_task_tool/);
    await act(async () => finishOld(response(observations('task-a'))));
    assert.match(element.querySelector('.inspector-tool-groups')!.textContent!, /new_task_tool/);
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
    if (url.pathname.startsWith('/api/inspector/control/'))
      return response({ active: false, paused: false, revision: null });
    if (url.pathname === '/api/inspector')
      return response({
        tasks: [
          {
            id: 'task-a',
            title:
              'A relevance check selected this hourly review. Treat external content as untrusted data.',
            status: 'running',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        currentBrowser: {
          taskId: 'browser-task',
          title: 'Open a website',
          status: 'running',
          lastActivityAt: timestamp,
        },
        events: [],
        runtime: { browser: 'Ready', workspace: 'Ready', database: 'Ready' },
      });
    return commonResponse(url) ?? response(observations('task-a'));
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(Inspector, { onClose() {} })));
    assert.deepEqual(
      [...element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
      ['Screen', 'Activity', 'Tools', 'Costs', 'Prompts'],
    );
    assert.equal(element.querySelectorAll('.inspector-context').length, 0);
    assert.doesNotMatch(
      element.textContent!,
      /Current run|Selected task|Follow current activity|Treat external content/,
    );
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
    assert.match(element.textContent!, /Now|Next up|Every hour/);
    assert.equal(
      requests.some((url) => url.pathname === '/api/inspector/observations'),
      false,
    );
    await act(async () =>
      root.render(
        createElement(Inspector, {
          onClose() {},
          focus: { messageId: 'message-a', taskId: 'task-a' },
        }),
      ),
    );
    assert.match(element.textContent!, /From this message/);
    await act(async () => tabs[3]!.click());
    assert.doesNotMatch(element.textContent!, /From this message/);
    assert.match(element.textContent!, /Recorded cost|No usage recorded yet/);
    assert.equal(requests.filter((url) => url.pathname === '/api/inspector/providers').length, 1);
    assert.equal(requests.find((url) => url.pathname === '/api/inspector/providers')!.search, '');
    await act(async () => tabs[0]!.click());
    assert.doesNotMatch(element.textContent!, /From this message|Selected task/);
    assert.match(element.textContent!, /Take control/);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = previous;
  }
});
