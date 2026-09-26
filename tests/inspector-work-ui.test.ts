import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { InspectorWork, workStatus } from '../src/web/components/inspector-work.tsx';
import type { InspectorWorkItem, InspectorWorkResponse } from '../src/shared/inspector-work.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Event',
  'MouseEvent',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const item: InspectorWorkItem = {
  taskId: 'owned-task',
  title: 'Plan the trip <script>private</script>',
  status: 'waiting_credentials',
  source: 'conversation',
  waitingReason: 'credentials',
  queuedInputs: 2,
  executions: 1,
  updatedAt: new Date().toISOString(),
};
const work: InspectorWorkResponse = {
  scope: 'owner',
  active: [item],
  activeTotal: 1,
  upcoming: [
    {
      id: 'scheduled',
      title: 'Morning check-in',
      runAt: '2035-10-29T09:00:00.000Z',
      timeZone: 'Europe/Lisbon',
      queued: true,
    },
  ],
  upcomingTotal: 1,
  review: { configured: true, scheduled: true, cron: '0 * * * *', timeZone: 'UTC' },
  decisions: [
    {
      id: 'decision',
      kind: 'review',
      decision: 'digest',
      reason: 'Keep this for the next useful review.',
      createdAt: new Date().toISOString(),
      taskId: null,
    },
  ],
  decisionsTotal: 1,
  decisionWindowHours: 24,
};

test('work states describe waits without exposing internal reason names', () => {
  assert.equal(workStatus(item), 'Needs sign-in');
  assert.equal(workStatus({ ...item, status: 'running' }), 'Working');
  assert.equal(workStatus({ ...item, status: 'queued' }), 'Queued');
  assert.equal(
    workStatus({ ...item, status: 'waiting_user', waitingReason: 'approval' }),
    'Needs approval',
  );
  assert.equal(
    workStatus({ ...item, status: 'waiting_user', waitingReason: 'manual_control' }),
    'Under your control',
  );
  assert.equal(
    workStatus({ ...item, status: 'waiting_user', waitingReason: 'recovery' }),
    'Needs review',
  );
});

test('work view shows owned outcomes, queued follow-ups and persisted timing while retaining data on a failed refresh', async (t) => {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  let fail = false;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    if (fail)
      return new Response(JSON.stringify({ error: 'Fixture refresh unavailable.' }), {
        status: 503,
      });
    return response(work);
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const inspected: string[] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await act(async () =>
      root.render(createElement(InspectorWork, { onInspect: (taskId) => inspected.push(taskId) })),
    );
    assert.deepEqual(calls, ['/api/inspector/work']);
    assert.equal(element.querySelectorAll('.inspector-work-row').length, 1);
    assert.match(element.textContent!, /Needs sign-in/);
    assert.match(element.textContent!, /2 follow-ups queued/);
    assert.match(element.textContent!, /Europe\/Lisbon/);
    assert.equal(
      element.querySelector('time')!.getAttribute('datetime'),
      '2035-10-29T09:00:00.000Z',
    );
    assert.match(element.textContent!, /Every hour · UTC/);
    assert.match(element.textContent!, /Last 24 hours|Saved for later/);
    assert.equal(element.querySelectorAll('script,select').length, 0);
    await act(async () =>
      element.querySelector<HTMLButtonElement>('.inspector-work-row button')!.click(),
    );
    assert.deepEqual(inspected, ['owned-task']);
    fail = true;
    await act(async () => t.mock.timers.tick(5000));
    assert.match(element.textContent!, /Fixture refresh unavailable/);
    assert.equal(element.querySelectorAll('.inspector-work-row').length, 1);
    assert.match(element.textContent!, /Morning check-in/);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => t.mock.timers.tick(5000));
    assert.equal(calls.length, 2);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    fail = false;
    await act(async () => t.mock.timers.tick(5000));
    assert.equal(calls.length, 3);
    assert.doesNotMatch(element.textContent!, /Fixture refresh unavailable/);
  } finally {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    await act(async () => root.unmount());
    t.mock.timers.reset();
    element.remove();
    globalThis.fetch = previous;
  }
});

test('leaving the work view aborts its request and ignores a late response', async (t) => {
  const previous = globalThis.fetch;
  let finish!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  let count = 0;
  globalThis.fetch = async (_input, init) => {
    signal = init?.signal;
    count++;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  };
  const element = document.createElement('div');
  const root = createRoot(element);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await act(async () => root.render(createElement(InspectorWork, { onInspect() {} })));
    await act(async () => root.unmount());
    assert.equal(signal?.aborted, true);
    await act(async () => finish(response(work)));
    await act(async () => t.mock.timers.tick(5000));
    assert.equal(count, 1);
    assert.equal(element.textContent, '');
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = previous;
  }
});
