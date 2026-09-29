import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';

test('the standalone browser mounts without waiting for unrelated application state', async () => {
  const css = registerHooks({
    load(url, context, next) {
      return url.endsWith('.css')
        ? { format: 'module', source: 'export default undefined', shortCircuit: true }
        : next(url, context);
    },
  });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost:4310/browser',
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
    'CustomEvent',
  ] as const)
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  const previousFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (path, init) => {
    calls.push(String(path));
    assert.equal(init?.method ?? 'GET', 'GET');
    if (path === '/api/session')
      return Response.json({
        auth: { mode: 'local', googleAvailable: false },
        user: {
          id: '89628f27-7ed2-4bd3-93d4-b9f83194fcce',
          name: 'Local developer',
          email: null,
          avatarUrl: null,
        },
        settings: { theme: 'system', onboardingCompleted: true },
        capabilities: { developer: true },
      });
    assert.equal(
      new Headers(init?.headers).get('X-Otto-Account'),
      '89628f27-7ed2-4bd3-93d4-b9f83194fcce',
    );
    if (path === '/api/state') throw new Error('Unrelated state is unavailable.');
    if (path === '/api/browser/control')
      return new Response(
        JSON.stringify({
          paused: false,
          active: false,
          mode: null,
          signInAvailable: true,
          resumable: false,
        }),
      );
    assert.equal(path, '/api/browser');
    return new Response(JSON.stringify({ currentBrowser: null }));
  };
  const { App } = await import('../src/web/app.tsx');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.deepEqual(calls.toSorted(), ['/api/browser', '/api/browser/control', '/api/session']);
    assert.equal(document.querySelector('h1')?.textContent, 'Workspace browser');
    const control = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Take control',
    );
    assert.ok(control);
    assert.equal(control.disabled, false);
    assert.equal(document.querySelector('.sidebar'), null);
    assert.doesNotMatch(document.body.textContent!, /Unrelated state is unavailable/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    css.deregister();
    dom.window.close();
  }
});
