import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { InspectorPrompts } from '../src/web/components/inspector-prompts.tsx';

test('prompt polling waits for the current request and discards results from the previous scope', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost:4310',
    pretendToBeVisual: true,
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'Event',
  ] as const) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  originals.set(
    'IS_REACT_ACT_ENVIRONMENT',
    Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  );
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  const priorFetch = globalThis.fetch;
  const priorInterval = globalThis.setInterval;
  const priorClear = globalThis.clearInterval;
  const polls: Array<() => void> = [];
  const requests: Array<{ url: string; resolve(value: Response): void }> = [];
  globalThis.setInterval = ((callback: () => void) => {
    polls.push(callback);
    return polls.length;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  globalThis.fetch = async (url) =>
    new Promise<Response>((resolve) => requests.push({ url: String(url), resolve }));
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const response = (title: string) =>
    Response.json({
      prompts: [
        {
          id: title,
          turnId: title,
          title,
          revision: 1,
          system: 'Fixture system',
          instruction: 'Fixture instruction',
          resumed: false,
          imageCount: 0,
          reason: 'user',
          provider: 'fixture',
          model: 'fixture',
          createdAt: '2026-09-25T12:00:00Z',
        },
      ],
      captureEnabled: true,
      retentionDays: 7,
      dropped: 0,
      hasOlder: false,
    });
  try {
    await act(async () => root.render(createElement(InspectorPrompts, { turnId: 'old' })));
    await act(async () => {
      polls[0]();
      polls[0]();
    });
    assert.equal(requests.length, 1);
    await act(async () => root.render(createElement(InspectorPrompts, { turnId: 'new' })));
    assert.equal(requests.length, 2);
    await act(async () => requests[1].resolve(response('New turn')));
    await act(async () => requests[0].resolve(response('Old turn')));
    assert.match(container.textContent!, /New turn/);
    assert.equal(container.querySelector('.inspector-prompt')?.tagName, 'SECTION');
    assert.equal(
      container.querySelector('.inspector-prompt-text')?.parentElement?.closest('details'),
      null,
    );
    assert.equal(container.querySelectorAll('.inspector-prompt-text').length, 2);
    assert.equal(container.querySelectorAll('.inspector-prompt-text[open]').length, 0);
    assert.doesNotMatch(container.textContent!, /Old turn/);
    await act(async () => polls[1]());
    assert.equal(requests.length, 3);
    await act(async () => requests[2].resolve(response('Latest turn')));
    assert.match(container.textContent!, /Latest turn/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = priorFetch;
    globalThis.setInterval = priorInterval;
    globalThis.clearInterval = priorClear;
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
