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
  globalThis.fetch = async (path) => {
    calls.push(String(path));
    if (path === '/api/state') throw new Error('Unrelated state is unavailable.');
    assert.equal(path, '/api/browser');
    return new Response(JSON.stringify({ currentBrowser: null }));
  };
  const { App } = await import('../src/web/app.tsx');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.deepEqual(calls, ['/api/browser']);
    assert.equal(document.querySelector('h1')?.textContent, 'Workspace browser');
    assert.equal(document.querySelector('.sidebar'), null);
    assert.doesNotMatch(document.body.textContent!, /Unrelated state is unavailable/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    css.deregister();
    dom.window.close();
  }
});
