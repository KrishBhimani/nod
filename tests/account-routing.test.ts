import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { SessionResponse } from '../src/shared/account.ts';

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
  'HTMLButtonElement',
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
Object.defineProperty(dom.window.navigator, 'platform', { value: 'MacIntel' });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
class Events {
  static all: Events[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    Events.all.push(this);
  }
  close() {
    this.closed = true;
  }
}
Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: Events });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const { App } = await import('../src/web/app.tsx');
const { sessionStore } = await import('../src/web/lib/session.ts');
const account: SessionResponse = {
  auth: { mode: 'google', googleAvailable: true },
  user: {
    id: 'd27a54b9-0f68-433d-96a2-8bd390a23be8',
    name: 'Alex Example',
    email: 'alex@example.test',
    avatarUrl: null,
  },
  settings: { theme: 'system', onboardingCompleted: true },
  capabilities: { developer: false },
};
const anonymous: SessionResponse = { ...account, user: null, settings: null };

test('private routes do not mount or fetch before authentication, including browser and credentials', async () => {
  const previous = globalThis.fetch;
  for (const path of ['/', '/browser', '/credentials/private-request']) {
    window.history.replaceState(null, '', path);
    const requests: string[] = [];
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return Response.json(anonymous);
    };
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => root.render(createElement(App)));
      assert.deepEqual(requests, ['/api/session']);
      assert.ok(element.textContent?.includes('Continue with Google'));
      assert.equal(Events.all.length, 0);
    } finally {
      await act(async () => root.unmount());
      element.remove();
    }
  }
  globalThis.fetch = previous;
});

test('ordinary accounts cannot mount developer routes or read computer data', async () => {
  const previous = globalThis.fetch;
  for (const path of ['/browser', '/dev']) {
    window.history.replaceState(null, '', path);
    const requests: string[] = [];
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return Response.json(account);
    };
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => root.render(createElement(App)));
      assert.deepEqual(requests, ['/api/session']);
      assert.ok(element.textContent?.includes('This page isn’t here.'));
      assert.equal(Events.all.length, 0);
    } finally {
      await act(async () => root.unmount());
      element.remove();
    }
  }
  globalThis.fetch = previous;
});

test('authenticated workspace binds SSE to its account, supports settings shortcut and closes private work on expiry', async () => {
  const previous = globalThis.fetch;
  window.history.replaceState(null, '', '/');
  let finishState!: (response: Response) => void;
  let stateSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (url, options) => {
    if (String(url) === '/api/session') return Response.json(account);
    if (String(url) === '/api/state') {
      stateSignal = options?.signal;
      assert.equal(new Headers(options?.headers).get('X-Sidekick-Account'), account.user!.id);
      return new Promise((resolve) => {
        finishState = resolve;
      });
    }
    throw new Error('Unexpected request');
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(App)));
    const stream = Events.all.at(-1)!;
    assert.equal(stream.url, `/api/events?account=${account.user!.id}`);
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true, cancelable: true }),
      ),
    );
    assert.ok(document.querySelector('.account-settings [role="tablist"]'));
    await act(async () => sessionStore.invalidate());
    assert.equal(stream.closed, true);
    assert.equal(stateSignal?.aborted, true);
    assert.equal(document.querySelector('.account-settings'), null);
    await act(async () =>
      finishState(
        Response.json({
          messages: [{ text: 'Old private conversation' }],
          tasks: [],
          configuration: {},
        }),
      ),
    );
    assert.equal(element.textContent?.includes('Old private conversation'), false);
    assert.ok(element.textContent?.includes('Continue with Google'));
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = previous;
  }
});
