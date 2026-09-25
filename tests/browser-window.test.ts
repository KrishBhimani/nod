import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { BrowserWindow } from '../src/web/pages/browser.tsx';
import { InspectorScreen } from '../src/web/components/inspector-screen.tsx';
import type { InspectorDetail } from '../src/web/hooks/use-inspector-state.ts';

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
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const frame = () =>
  new Response(new Uint8Array([1]), {
    headers: {
      'content-type': 'image/png',
      'X-Screen-State': 'live',
      'X-Screen-Captured-At': new Date().toISOString(),
    },
  });
function detail(id: string): InspectorDetail {
  return {
    tasks: [],
    events: [],
    runtime: { browser: 'Ready', workspace: 'Ready', database: 'Ready' },
    currentBrowser: {
      taskId: id,
      title: 'Private task title',
      status: 'running',
      lastActivityAt: new Date().toISOString(),
    },
  };
}
const takeControl = (element: HTMLElement) =>
  [...element.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Take control',
  )!;

test('standalone browser follows current sessions, clears mismatched and secure frames, without Inspector diagnostics', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const calls: URL[] = [];
  const revoked: string[] = [];
  let taskId = 'task-a';
  let imageId = 0;
  let secure = false;
  let finishNext: ((value: Response) => void) | undefined;
  URL.createObjectURL = () => `blob:window-${++imageId}`;
  URL.revokeObjectURL = (value) => {
    revoked.push(value);
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost:4310');
    calls.push(url);
    if (url.pathname === '/api/browser')
      return json({ currentBrowser: detail(taskId).currentBrowser });
    if (url.pathname.startsWith('/api/browser/control/'))
      return json({ active: false, paused: false, revision: 0 });
    assert.equal(url.pathname, '/api/browser/screen');
    if (secure) return new Response(null, { status: 423 });
    if (url.searchParams.get('taskId') === 'task-b' && !finishNext)
      return new Promise<Response>((resolve) => {
        finishNext = resolve;
      });
    return frame();
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await act(async () => root.render(createElement(BrowserWindow)));
    assert.equal(
      element.querySelector<HTMLImageElement>('.screen-preview img')!.src,
      'blob:window-1',
    );
    assert.equal(takeControl(element).disabled, false);
    assert.equal(element.querySelectorAll('[role="tab"],nav,.sidebar').length, 0);
    assert.doesNotMatch(
      element.textContent!,
      /Private task title|Computer details|Open browser window|Follows the current browser|Live browser/,
    );
    taskId = 'task-b';
    await act(async () => t.mock.timers.tick(2500));
    assert.ok(finishNext);
    assert.equal(element.querySelector('.screen-preview img'), null);
    assert.equal(takeControl(element).disabled, true);
    assert.ok(revoked.includes('blob:window-1'));
    await act(async () => finishNext!(frame()));
    assert.match(
      element.querySelector<HTMLImageElement>('.screen-preview img')!.src,
      /blob:window-/,
    );
    assert.equal(takeControl(element).disabled, false);
    secure = true;
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(element.querySelector('.screen-preview img'), null);
    assert.equal(takeControl(element).disabled, true);
    assert.match(element.textContent!, /Screen hidden while sign-in details are entered/);
    await act(async () => root.render(null));
    const count = calls.length;
    await act(async () => t.mock.timers.tick(5000));
    assert.equal(calls.length, count);
    assert.equal(element.querySelector('.browser-control'), null);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    t.mock.timers.reset();
    globalThis.fetch = previousFetch;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
  }
});

test('browser popout opens only the app route, pauses embedded captures and restores a fresh frame after closing', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousOpen = window.open;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const opened: Array<unknown[]> = [];
  let captures = 0;
  const popup = {
    closed: false,
    opener: {},
    focus() {},
    close() {
      this.closed = true;
    },
  };
  window.open = ((...args: unknown[]) => {
    opened.push(args);
    return popup as unknown as Window;
  }) as typeof window.open;
  URL.createObjectURL = () => `blob:popup-${captures}`;
  URL.revokeObjectURL = () => {};
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost:4310');
    if (url.pathname.startsWith('/api/browser/control/'))
      return json({ active: false, paused: false, revision: 0 });
    assert.equal(url.pathname, '/api/inspector/screen');
    captures++;
    return frame();
  };
  const element = document.createElement('div');
  const root = createRoot(element);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    await act(async () =>
      root.render(
        createElement(InspectorScreen, {
          data: detail('task-a'),
          active: true,
          allowDetach: true,
          onStopped() {},
        }),
      ),
    );
    const link = element.querySelector<HTMLAnchorElement>('.inspector-screen-toolbar a')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => link.dispatchEvent(event));
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(opened, [['/browser', 'sidekick-browser', 'popup,width=1200,height=800']]);
    assert.equal(popup.opener, null);
    await act(async () =>
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    );
    assert.equal(opened.length, 1);
    assert.equal(element.querySelector('.screen-preview img'), null);
    assert.match(element.textContent!, /open in a separate window/);
    await act(async () => t.mock.timers.tick(3000));
    assert.equal(captures, 1);
    popup.closed = true;
    await act(async () => t.mock.timers.tick(500));
    assert.equal(element.querySelector('.screen-preview img'), null);
    assert.equal(takeControl(element).disabled, true);
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(captures, 2);
    assert.equal(takeControl(element).disabled, false);
    window.open = () => null;
    const blocked = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => link.dispatchEvent(blocked));
    assert.equal(blocked.defaultPrevented, false);
    assert.equal(link.getAttribute('href'), '/browser');
    assert.equal(element.querySelector('.inspector-browser-detached'), null);
  } finally {
    await act(async () => root.unmount());
    t.mock.timers.reset();
    element.remove();
    globalThis.fetch = previousFetch;
    window.open = previousOpen;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
  }
});
