import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { pageDataCache } from '../src/web/lib/page-data-cache.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310/goals',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'NodeFilter',
  'MutationObserver',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const { DeletePlan } = await import('../src/web/components/delete-plan.tsx');

async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent === label,
  );
  assert.ok(button, label);
  await act(async () => button.click());
}

for (const kind of ['goal', 'schedule'] as const)
  test(`deleting a ${kind} needs one local confirmation and fences stale list reads`, async () => {
    const priorFetch = globalThis.fetch;
    const path = `/api/${kind}s`;
    const entries = [
      { id: 'selected', title: 'Review invoices' },
      { id: 'other', title: 'Keep me' },
    ];
    const reads: Array<(response: Response) => void> = [];
    const writes: string[] = [];
    globalThis.fetch = async (url, options) => {
      if (options?.method === 'DELETE') {
        writes.push(String(url));
        return Response.json({ ok: true });
      }
      return new Promise((resolve) => reads.push(resolve));
    };
    pageDataCache.update(path, () => entries);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      const stale = pageDataCache.refresh(path, true);
      await act(async () =>
        root.render(createElement(DeletePlan, { kind, id: 'selected', title: 'Review invoices' })),
      );
      await click(`Delete ${kind} Review invoices`);
      assert.equal(document.activeElement?.textContent, `Keep ${kind}`);
      assert.deepEqual(writes, []);
      assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /Review invoices/);
      if (kind === 'schedule')
        assert.match(document.body.textContent ?? '', /Past runs stay in History/);
      await click(`Keep ${kind}`);
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.deepEqual(writes, []);
      await click(`Delete ${kind} Review invoices`);
      await click(`Delete ${kind}`);
      assert.deepEqual(writes, [`${path}/selected`]);
      assert.deepEqual(pageDataCache.getSnapshot(path).data, [entries[1]]);
      await act(async () => reads[0](Response.json(entries)));
      await stale;
      assert.deepEqual(pageDataCache.getSnapshot(path).data, [entries[1]]);
      await act(async () => reads[1](Response.json([entries[1]])));
    } finally {
      await act(async () => root.unmount());
      container.remove();
      pageDataCache.update(path, () => null);
      globalThis.fetch = priorFetch;
    }
  });

test('failed deletion keeps the entry and allows retry without creating a chat message', async () => {
  const priorFetch = globalThis.fetch;
  const entries = [{ id: 'selected', title: 'Review invoices' }];
  const calls: string[] = [];
  let failed = true;
  globalThis.fetch = async (url, options) => {
    calls.push(`${options?.method ?? 'GET'} ${url}`);
    return options?.method === 'DELETE'
      ? failed
        ? Response.json({ error: 'Private provider detail' }, { status: 503 })
        : Response.json({ ok: true })
      : Response.json(failed ? entries : []);
  };
  pageDataCache.update('/api/goals', () => entries);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(DeletePlan, { kind: 'goal', id: 'selected', title: 'Review invoices' }),
      ),
    );
    await click('Delete goal Review invoices');
    await click('Delete goal');
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? '',
      /Could not delete this goal/,
    );
    assert.doesNotMatch(document.body.textContent ?? '', /Private provider detail/);
    assert.deepEqual(pageDataCache.getSnapshot('/api/goals').data, entries);
    failed = false;
    await click('Delete goal');
    assert.deepEqual(pageDataCache.getSnapshot('/api/goals').data, []);
    assert.ok(calls.every((call) => !call.includes('/messages')));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/goals', () => null);
    globalThis.fetch = priorFetch;
  }
});
