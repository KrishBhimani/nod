import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { Goal } from '../src/shared/contracts.ts';
import { pageDataCache } from '../src/web/lib/page-data-cache.ts';
import { Goals } from '../src/web/pages/goals.tsx';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
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
  'KeyboardEvent',
  'CustomEvent',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');

const goal: Goal = {
  id: '148fba96-abfc-48ee-b9d0-59b6564c60f4',
  title: 'Complete Northstar review',
  description: 'Review the synthetic invoices.',
  progress: 25,
  status: 'active',
  nextAction: 'Prepare the summary.',
  targetDate: '2026-10-02',
  updatedAt: '2026-09-25T12:00:00.000Z',
};
const click = (element: Element) =>
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

test('Goals exposes a loading status and recovers from first-load failure with an error-only retry', async () => {
  const previousFetch = globalThis.fetch;
  const reads: Array<(response: Response) => void> = [];
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/goals');
    assert.equal(options?.method ?? 'GET', 'GET');
    return new Promise((resolve) => reads.push(resolve));
  };
  pageDataCache.update('/api/goals', () => null);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Goals)));
    assert.match(container.querySelector('[role="status"]')?.textContent ?? '', /Loading goals/);
    assert.equal(container.querySelector('.secondary-empty'), null);
    await act(async () =>
      reads[0](Response.json({ error: 'Goals are unavailable.' }, { status: 503 })),
    );
    assert.match(
      container.querySelector('[role="alert"]')?.textContent ?? '',
      /Could not load goals\./,
    );
    const retry = container.querySelector<HTMLButtonElement>('[aria-label="Retry loading goals"]')!;
    assert.ok(retry);
    retry.focus();
    assert.equal(document.activeElement, retry);
    await act(async () => click(retry));
    assert.equal(retry.disabled, true);
    assert.equal(reads.length, 2);
    await act(async () => reads[1](Response.json([goal])));
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.equal(container.querySelector('.loading'), null);
    assert.match(container.textContent ?? '', /Complete Northstar review/);
    assert.equal(container.querySelector('[aria-label="Retry loading goals"]'), null);
    assert.equal(container.querySelector('header [aria-label^="Refresh"]'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/goals', () => null);
    globalThis.fetch = previousFetch;
  }
});

test('cached goals remain usable through failed refreshes and navigation', async () => {
  const previousFetch = globalThis.fetch;
  const reads: Array<(response: Response) => void> = [];
  globalThis.fetch = async () => new Promise((resolve) => reads.push(resolve));
  pageDataCache.update('/api/goals', () => [goal]);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Goals)));
    assert.equal(container.querySelector('.loading'), null);
    assert.match(container.textContent ?? '', /Prepare the summary/);
    await act(async () =>
      reads[0](Response.json({ error: 'Refresh is unavailable.' }, { status: 503 })),
    );
    assert.match(container.textContent ?? '', /Could not load goals\./);
    assert.match(container.textContent ?? '', /25%/);
    const pause = container.querySelector<HTMLButtonElement>(
      '[aria-label="Pause goal Complete Northstar review"]',
    )!;
    assert.ok(pause);
    assert.equal(pause.disabled, false);
    await act(async () => click(container.querySelector('[aria-label="Retry loading goals"]')!));
    assert.equal(container.querySelector('.loading'), null);
    assert.match(container.textContent ?? '', /Complete Northstar review/);
    await act(async () => reads[1](Response.json([{ ...goal, status: 'paused' }])));
    assert.ok(container.querySelector('[aria-label="Resume goal Complete Northstar review"]'));
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(Goals)));
    assert.equal(container.querySelector('.loading'), null);
    assert.ok(container.querySelector('[aria-label="Resume goal Complete Northstar review"]'));
    await act(async () => reads[2](Response.json([{ ...goal, status: 'paused' }])));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/goals', () => null);
    globalThis.fetch = previousFetch;
  }
});

test('goal actions have distinct accessible names and open unsent drafts for the named goal', async () => {
  const previousFetch = globalThis.fetch;
  const goals: Goal[] = [
    goal,
    { ...goal, id: 'paused-goal', title: 'Read a book', status: 'paused' },
    { ...goal, id: 'done-goal', title: 'Finished review', status: 'completed', progress: 100 },
  ];
  globalThis.fetch = async (_path, options) => {
    assert.equal(options?.method ?? 'GET', 'GET');
    return Response.json(goals);
  };
  pageDataCache.update('/api/goals', () => goals);
  const drafts: Array<{ text: string; send: boolean }> = [];
  const onDraft = (event: Event) => drafts.push((event as CustomEvent).detail);
  window.addEventListener('otto:compose', onDraft);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Goals)));
    for (const article of container.querySelectorAll('article')) {
      const label = article.getAttribute('aria-labelledby');
      assert.ok(label);
      assert.equal(document.getElementById(label), article.querySelector('h2'));
    }
    assert.doesNotMatch(container.textContent ?? '', /Finished review/);
    const paused = container.querySelector<HTMLDetailsElement>('.goals-paused')!;
    assert.equal(paused.open, false);
    await act(async () => click(paused.querySelector('summary')!));
    assert.equal(paused.open, true);
    for (const label of [
      'Pause goal Complete Northstar review',
      'Resume goal Read a book',
      'Update goal Complete Northstar review',
    ]) {
      const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
      assert.ok(button);
      assert.equal(button.tagName, 'BUTTON');
      assert.equal(button.tabIndex, 0);
      button.focus();
      assert.equal(document.activeElement, button);
      await act(async () => click(button));
    }
    assert.deepEqual(drafts, [
      {
        text: `Pause the goal "Complete Northstar review".`,
        send: false,
      },
      { text: 'Resume the goal "Read a book".', send: false },
      {
        text: `Let's review the goal "Complete Northstar review" and decide what to do next.`,
        send: false,
      },
    ]);
    await act(async () => click(container.querySelector('[role="tab"][data-view="completed"]')!));
    const completed = container.querySelector('article')!;
    assert.equal(completed.querySelector('.saved-plan-next'), null);
    assert.equal(completed.querySelectorAll('button').length, 2);
    assert.ok(completed.querySelector('[aria-label="Update goal Finished review"]'));
    assert.ok(completed.querySelector('[aria-label="Delete goal Finished review"]'));
  } finally {
    window.removeEventListener('otto:compose', onDraft);
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/goals', () => null);
    globalThis.fetch = previousFetch;
  }
});

async function show(goals: Goal[]) {
  const previousFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async (_path, options) => {
    assert.equal(options?.method ?? 'GET', 'GET');
    reads++;
    return Response.json(goals);
  };
  pageDataCache.update('/api/goals', () => goals);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(createElement(Goals)));
  return {
    element,
    reads: () => reads,
    tab: (view: string) =>
      element.querySelector<HTMLButtonElement>(`[role=tab][data-view=${view}]`)!,
    async close() {
      await act(async () => root.unmount());
      element.remove();
      pageDataCache.update('/api/goals', () => null);
      globalThis.fetch = previousFetch;
    },
  };
}

test('goal views use roving keyboard tabs and switch cached content without fetching', async () => {
  const f = await show([
    goal,
    { ...goal, id: 'completed', title: 'Finished goal', status: 'completed' },
  ]);
  try {
    const active = f.tab('active');
    const completed = f.tab('completed');
    assert.equal(active.getAttribute('aria-selected'), 'true');
    assert.equal(completed.tabIndex, -1);
    for (const tab of [active, completed])
      assert.ok(document.getElementById(tab.getAttribute('aria-controls')!));
    assert.match(active.textContent!, /Active1/);
    assert.match(completed.textContent!, /Completed1/);
    for (const [key, target] of [
      ['ArrowRight', completed],
      ['ArrowRight', active],
      ['End', completed],
      ['Home', active],
      ['ArrowLeft', completed],
    ] as const) {
      await act(async () =>
        f.element
          .querySelector('[aria-selected=true]')!
          .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })),
      );
      assert.equal(document.activeElement, target);
      assert.equal(target.getAttribute('aria-selected'), 'true');
      assert.equal(f.element.querySelectorAll('[role=tab][tabindex="0"]').length, 1);
      const panel = f.element.querySelector('[role=tabpanel]:not([hidden])')!;
      assert.equal(panel.id, target.getAttribute('aria-controls'));
      assert.equal(panel.getAttribute('aria-labelledby'), target.id);
      assert.equal(panel.getAttribute('tabindex'), '0');
    }
    assert.equal(f.element.querySelectorAll('article').length, 1);
    assert.match(f.element.querySelector('article')!.textContent!, /Finished goal/);
    assert.equal(f.reads(), 1);
    assert.equal(f.element.querySelector('.loading'), null);
  } finally {
    await f.close();
  }
});

test('paused-only goals stay visible and resumable outside the completed view', async () => {
  const f = await show([{ ...goal, status: 'paused' }]);
  try {
    assert.match(f.element.textContent!, /No active goals/);
    assert.match(f.element.textContent!, /Resume a paused goal/);
    assert.equal(f.element.querySelector<HTMLDetailsElement>('.goals-paused')!.open, true);
    assert.ok(f.element.querySelector('[aria-label="Resume goal Complete Northstar review"]'));
    await act(async () => click(f.tab('completed')));
    assert.match(f.element.textContent!, /No completed goals yet/);
    assert.equal(f.element.querySelector('article'), null);
    assert.equal(f.element.querySelector('.goals-paused'), null);
    await act(async () => click(f.tab('active')));
    assert.equal(f.element.querySelector<HTMLDetailsElement>('.goals-paused')!.open, true);
  } finally {
    await f.close();
  }
});

test('each view has a specific empty state and accepted cache changes preserve the selected view', async () => {
  const f = await show([]);
  try {
    assert.match(f.element.textContent!, /No goals yet/);
    await act(async () => click(f.tab('completed')));
    assert.match(f.element.textContent!, /No completed goals yet/);
    await act(async () =>
      pageDataCache.update('/api/goals', () => [{ ...goal, status: 'completed' }]),
    );
    assert.equal(f.tab('completed').getAttribute('aria-selected'), 'true');
    assert.match(f.element.querySelector('article')!.textContent!, /Complete Northstar review/);
    await act(async () => pageDataCache.update('/api/goals', () => [goal]));
    assert.match(f.element.textContent!, /No completed goals yet/);
    await act(async () => click(f.tab('active')));
    assert.match(f.element.querySelector('article')!.textContent!, /Complete Northstar review/);
    assert.equal(f.element.querySelector('header [aria-label^="Refresh"]'), null);
    assert.equal(f.reads(), 1);
  } finally {
    await f.close();
  }
});
