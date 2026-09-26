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
    assert.equal(takeControl(element).disabled, false);
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
    assert.equal(takeControl(element).disabled, false);
    assert.equal(element.querySelector('.screen-empty'), null);
    assert.doesNotMatch(element.textContent!, /Screen hidden while sign-in details are entered/);
    assert.doesNotMatch(element.textContent!, /Retry view/);
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
    const controls = element.querySelector('[role="group"][aria-label="Browser controls"]')!;
    const link = controls.querySelector<HTMLAnchorElement>('[aria-label="Open browser window"]')!;
    assert.ok(controls.contains(takeControl(element)));
    assert.ok(controls.querySelector('[aria-label="Enlarge browser screen"]'));
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => link.dispatchEvent(event));
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(opened, [['/browser', 'sidekick-browser', 'popup,width=1200,height=800']]);
    assert.equal(popup.opener, null);
    const detachedLink = element.querySelector<HTMLAnchorElement>(
      '[aria-label="Open browser window"]',
    )!;
    await act(async () =>
      detachedLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    );
    assert.equal(opened.length, 1);
    assert.equal(element.querySelector('.screen-preview img'), null);
    assert.match(element.textContent!, /open in a separate window/);
    await act(async () => t.mock.timers.tick(3000));
    assert.equal(captures, 1);
    popup.closed = true;
    await act(async () => t.mock.timers.tick(500));
    assert.equal(element.querySelector('.screen-preview img'), null);
    assert.equal(takeControl(element).disabled, false);
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(captures, 2);
    assert.equal(takeControl(element).disabled, false);
    window.open = () => null;
    const restoredLink = element.querySelector<HTMLAnchorElement>(
      '[aria-label="Open browser window"]',
    )!;
    const blocked = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => restoredLink.dispatchEvent(blocked));
    assert.equal(blocked.defaultPrevented, false);
    assert.equal(restoredLink.getAttribute('href'), '/browser');
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

test('Take control stays available for idle and finished browsers without resuming work', async () => {
  const previousFetch = globalThis.fetch;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const previousFocus = document.hasFocus;
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
  URL.createObjectURL = () => 'blob:private-workspace';
  URL.revokeObjectURL = () => {};
  try {
    for (const finished of [false, true]) {
      const writes: string[] = [];
      let active = false;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input), 'http://localhost:4310');
        if (url.pathname === '/api/inspector/screen') return frame();
        assert.ok(
          url.pathname.startsWith(
            `/api/browser/control/${finished ? 'finished-task' : 'workspace'}`,
          ),
        );
        if (init?.method === 'POST') {
          writes.push(url.pathname);
          if (url.pathname.endsWith('/start')) {
            active = true;
            return json({ revision: 1, mode: 'sign_in', resumable: false });
          }
          active = false;
          return json({ ok: true });
        }
        if (url.pathname.endsWith('/sign-in-screen')) return frame();
        return json({
          paused: active,
          active,
          revision: active ? 1 : null,
          mode: active ? 'sign_in' : null,
          signInAvailable: true,
          resumable: false,
        });
      };
      const element = document.createElement('div');
      document.body.append(element);
      const root = createRoot(element);
      try {
        const data = finished ? detail('finished-task') : null;
        if (data?.currentBrowser) data.currentBrowser.status = 'succeeded';
        await act(async () =>
          root.render(
            createElement(InspectorScreen, {
              data,
              active: true,
              onStopped() {},
              showDetails: false,
            }),
          ),
        );
        assert.equal(takeControl(element).disabled, false);
        assert.doesNotMatch(element.textContent!, /Sign in in browser|Last view/);
        await act(async () =>
          takeControl(element).dispatchEvent(new MouseEvent('click', { bubbles: true })),
        );
        assert.equal(
          element.querySelector<HTMLImageElement>('.screen-preview img')?.src,
          'blob:private-workspace',
        );
        const done = [...element.querySelectorAll('button')].find(
          (button) => button.textContent === 'Done',
        );
        assert.ok(done);
        assert.equal(element.textContent?.includes('Resume agent'), false);
        await act(async () => done.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        assert.deepEqual(writes, [
          `/api/browser/control/${finished ? 'finished-task' : 'workspace'}/start`,
          `/api/browser/control/${finished ? 'finished-task' : 'workspace'}/resume`,
        ]);
        assert.equal(takeControl(element).disabled, false);
      } finally {
        await act(async () => root.unmount());
        element.remove();
      }
    }
  } finally {
    globalThis.fetch = previousFetch;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: previousFocus });
  }
});

test('browser metadata changes cannot replace an idle takeover while acquisition or control is active', async () => {
  const previousFetch = globalThis.fetch;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const previousFocus = document.hasFocus;
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
  URL.createObjectURL = () => 'blob:private-workspace';
  URL.revokeObjectURL = () => {};
  const requests: string[] = [];
  let finishStart!: (response: Response) => void;
  let active = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost:4310');
    requests.push(url.pathname);
    if (url.pathname.endsWith('/start'))
      return new Promise<Response>((resolve) => {
        finishStart = resolve;
      });
    if (url.pathname.endsWith('/resume')) {
      active = false;
      return json({ ok: true });
    }
    if (url.pathname.endsWith('/sign-in-screen') || url.pathname === '/api/inspector/screen')
      return frame();
    return json({
      paused: active,
      active,
      revision: active ? 10 : null,
      mode: active ? 'sign_in' : null,
      signInAvailable: true,
      resumable: false,
    });
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        createElement(InspectorScreen, {
          data: null,
          active: true,
          onStopped() {},
          showDetails: false,
        }),
      ),
    );
    await act(async () =>
      takeControl(element).dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    await act(async () =>
      root.render(
        createElement(InspectorScreen, {
          data: detail('another-task'),
          active: true,
          onStopped() {},
          showDetails: false,
        }),
      ),
    );
    assert.ok(requests.every((request) => request.startsWith('/api/browser/control/workspace')));
    active = true;
    await act(async () => finishStart(json({ revision: 10, mode: 'sign_in', resumable: false })));
    assert.ok(requests.every((request) => request.startsWith('/api/browser/control/workspace')));
    const done = [...element.querySelectorAll('button')].find(
      (button) => button.textContent === 'Done',
    );
    assert.ok(done);
    await act(async () => done.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.ok(requests.includes('/api/browser/control/another-task'));
    assert.ok(requests.includes('/api/browser/control/workspace/resume'));
    assert.equal(requests.includes('/api/browser/control/another-task/resume'), false);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = previousFetch;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: previousFocus });
  }
});

test('finishing private control resets a blocked capture and requests a fresh frame for the same task', async (context) => {
  const previousFetch = globalThis.fetch;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const previousFocus = document.hasFocus;
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
  let image = 0;
  const revoked: string[] = [];
  URL.createObjectURL = () => `blob:handoff-${++image}`;
  URL.revokeObjectURL = (value) => {
    revoked.push(value);
  };
  let active = false;
  let resumed = false;
  let ordinaryCaptures = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost:4310');
    if (url.pathname === '/api/inspector/screen') {
      ordinaryCaptures++;
      return resumed ? frame() : new Response(null, { status: 423 });
    }
    if (url.pathname.endsWith('/sign-in-screen')) return frame();
    if (init?.method === 'POST') {
      if (url.pathname.endsWith('/start')) {
        active = true;
        return json({ revision: 11, mode: 'sign_in', resumable: false });
      }
      assert.ok(url.pathname.endsWith('/resume'));
      active = false;
      resumed = true;
      return json({ ok: true });
    }
    return json({
      paused: active,
      active,
      revision: active ? 11 : null,
      mode: active ? 'sign_in' : null,
      signInAvailable: true,
      resumable: false,
    });
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const data = detail('completed-browser');
    data.currentBrowser!.status = 'succeeded';
    await act(async () =>
      root.render(
        createElement(InspectorScreen, { data, active: true, onStopped() {}, showDetails: false }),
      ),
    );
    assert.equal(ordinaryCaptures, 1);
    assert.equal(element.querySelector('.screen-empty'), null);
    assert.doesNotMatch(element.textContent!, /Screen hidden while sign-in details are entered/);
    assert.doesNotMatch(element.textContent!, /Retry view/);
    await act(async () =>
      takeControl(element).dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    assert.equal(element.querySelector('img')?.getAttribute('alt'), 'Private workspace browser');
    assert.doesNotMatch(element.textContent!, /Retry view/);
    await act(async () => context.mock.timers.tick(1100));
    assert.equal(ordinaryCaptures, 1);
    const privateSource = element.querySelector<HTMLImageElement>('img')!.src;
    const done = [...element.querySelectorAll('button')].find(
      (button) => button.textContent === 'Done',
    )!;
    await act(async () => done.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(ordinaryCaptures, 2);
    assert.equal(element.querySelector('img')?.getAttribute('alt'), 'Browser screen');
    assert.notEqual(element.querySelector<HTMLImageElement>('img')?.src, privateSource);
    assert.ok(revoked.includes(privateSource));
    assert.doesNotMatch(element.textContent!, /Screen hidden|Retry view/);
    assert.equal(takeControl(element).disabled, false);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    context.mock.timers.reset();
    globalThis.fetch = previousFetch;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: previousFocus });
  }
});

test('task adapters without a private desktop keep their live masked frame during manual control', async () => {
  const previousFetch = globalThis.fetch;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:masked-frame';
  URL.revokeObjectURL = () => {};
  let active = false;
  let captures = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost:4310');
    assert.equal(url.pathname.endsWith('/sign-in-screen'), false);
    if (url.pathname === '/api/inspector/screen') {
      captures++;
      return frame();
    }
    if (init?.method === 'POST') {
      active = url.pathname.endsWith('/start');
      return json(active ? { revision: 1, mode: 'manual', resumable: true } : { ok: true });
    }
    return json({
      paused: active,
      active,
      revision: active ? 1 : null,
      mode: active ? 'manual' : null,
      signInAvailable: false,
      resumable: true,
    });
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        createElement(InspectorScreen, {
          data: detail('manual-task'),
          active: true,
          onStopped() {},
          showDetails: false,
        }),
      ),
    );
    await act(async () =>
      takeControl(element).dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    assert.equal(element.querySelector('img')?.getAttribute('alt'), 'Browser screen');
    assert.equal(element.querySelector('textarea')?.disabled, false);
    const resume = [...element.querySelectorAll('button')].find(
      (button) => button.textContent === 'Resume agent',
    )!;
    assert.ok(resume);
    const before = captures;
    await act(async () => resume.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.ok(captures > before);
    assert.equal(element.querySelector('textarea'), null);
    assert.equal(takeControl(element).disabled, false);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = previousFetch;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
  }
});
