import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import type { AppState, Message } from '../src/shared/contracts.ts';

const css = registerHooks({
  load(url, context, next) {
    return url.endsWith('.css')
      ? { format: 'module', source: 'export default undefined', shortCircuit: true }
      : next(url, context);
  },
});
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
  'NodeFilter',
  'Text',
  'ShadowRoot',
  'DOMParser',
  'MutationObserver',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'CustomEvent',
  'File',
  'FormData',
  'Blob',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const scrolls: Array<ScrollIntoViewOptions | boolean | undefined> = [];
dom.window.HTMLElement.prototype.scrollIntoView = (options) => {
  scrolls.push(options);
};
dom.window.matchMedia = ((query: string) => ({
  matches: query === '(prefers-reduced-motion: reduce)',
})) as typeof window.matchMedia;
const rect = {
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
  toJSON: () => ({}),
};
dom.window.Range.prototype.getBoundingClientRect = () => rect;
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
after(() => {
  dom.window.close();
  css.deregister();
});
const { createRoot } = await import('react-dom/client');
const { Chat } = await import('../src/web/pages/chat.tsx');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
const message = (id: string, role: Message['role'], createdAt: string): Message => ({
  id,
  role,
  text: `Synthetic ${id}`,
  taskId: 'fixture-task',
  attachments: [],
  createdAt,
});
const base: AppState = {
  conversationRevision: 0,
  hasEarlierMessages: false,
  messages: [message('latest', 'assistant', '2026-09-25T12:00:00Z')],
  tasks: [],
  configuration: {
    provider: 'fixture',
    model: 'fixture',
    llmReady: true,
    speechReady: false,
    integrationsReady: true,
    browserAssistReady: false,
    inspectorEnabled: false,
    localOnly: true,
  },
};

async function mount(state: AppState) {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const render = (next: AppState) =>
    act(async () => {
      root.render(
        createElement(Chat, {
          state: next,
          streams: {},
          refresh: async () => {},
          resetConversation: async () => 0,
        }),
      );
      await tick();
    });
  await render(state);
  return {
    element,
    render,
    button: (label: RegExp) =>
      [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        label.test(button.getAttribute('aria-label') ?? button.textContent ?? ''),
      ),
    dispose: async () => {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

test('Load earlier messages follows the server flags and shows a skeleton while it loads', async () => {
  const previousFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  globalThis.fetch = async (path) => {
    if (String(path).startsWith('/api/messages?'))
      return new Promise((resolve) => {
        finish = resolve;
      });
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount(base);
  try {
    assert.equal(fixture.button(/Load earlier messages/), undefined);
    await fixture.render({ ...base, hasEarlierMessages: true });
    await act(async () => fixture.button(/Load earlier messages/)!.click());
    assert.equal(fixture.button(/Load earlier messages/), undefined);
    assert.ok(
      fixture.element.querySelector('[role="status"][aria-label="Loading earlier messages"]'),
    );
    await act(async () => {
      finish(
        Response.json({
          messages: [message('older', 'user', '2026-09-25T11:00:00Z')],
          hasMore: false,
        }),
      );
      await tick();
    });
    assert.match(fixture.element.textContent ?? '', /Synthetic older/);
    assert.equal(fixture.element.querySelector('.history-skeleton'), null);
    assert.equal(fixture.button(/Load earlier messages/), undefined);
  } finally {
    await fixture.dispose();
    globalThis.fetch = previousFetch;
  }
});

test('Back to latest uses hysteresis, counts new replies and keeps a history load running', async () => {
  const previousFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  globalThis.fetch = async (path) => {
    if (String(path).startsWith('/api/messages?'))
      return new Promise((resolve) => {
        finish = resolve;
      });
    throw new Error('Unexpected fixture request');
  };
  const state = { ...base, hasEarlierMessages: true };
  const fixture = await mount(state);
  const area = fixture.element.querySelector<HTMLElement>('.conversation-scroll')!;
  Object.defineProperty(area, 'scrollHeight', { configurable: true, value: 5000 });
  Object.defineProperty(area, 'clientHeight', { configurable: true, value: 500 });
  Object.defineProperty(area, 'scrollTop', { configurable: true, writable: true, value: 0 });
  const scrollTo = (top: number) =>
    act(async () => {
      area.scrollTop = top;
      area.dispatchEvent(new Event('scroll'));
    });
  try {
    await scrollTo(4000);
    assert.equal(fixture.button(/Back to latest/), undefined);
    await scrollTo(1000);
    assert.equal(fixture.button(/Back to latest/)?.getAttribute('aria-label'), 'Back to latest');
    await scrollTo(4300);
    assert.ok(fixture.button(/Back to latest/));
    await fixture.render({
      ...state,
      messages: [
        ...state.messages,
        message('question', 'user', '2026-09-25T12:01:00Z'),
        message('answer', 'assistant', '2026-09-25T12:02:00Z'),
      ],
    });
    const jump = fixture.button(/Back to latest/)!;
    assert.equal(jump.getAttribute('aria-label'), 'Back to latest, 1 new reply');
    assert.equal(jump.querySelector('.jump-latest-count')?.textContent, '1');
    await act(async () => fixture.button(/Load earlier messages/)!.click());
    scrolls.length = 0;
    await act(async () => jump.click());
    assert.deepEqual(scrolls, [{ block: 'end', behavior: 'instant' }]);
    assert.equal(fixture.button(/Back to latest/), undefined);
    await act(async () => {
      finish(
        Response.json({
          messages: [message('older', 'user', '2026-09-25T11:00:00Z')],
          hasMore: true,
        }),
      );
      await tick();
    });
    assert.match(fixture.element.textContent ?? '', /Synthetic older/);
    assert.ok(fixture.button(/Load earlier messages/));
  } finally {
    await fixture.dispose();
    globalThis.fetch = previousFetch;
  }
});
