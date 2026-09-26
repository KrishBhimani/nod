import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';

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
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
Object.defineProperty(globalThis, 'EventSource', {
  configurable: true,
  value: class {
    close() {}
  },
});
after(() => {
  css.deregister();
  dom.window.close();
});
const { createRoot } = await import('react-dom/client');
const { App } = await import('../src/web/app.tsx');
const { Inspector } = await import('../src/web/pages/inspector.tsx');

for (const mode of ['read', 'write'] as const)
  test(`navigation and inspector remain usable when browser storage ${mode}s fail`, async () => {
    const previousFetch = globalThis.fetch;
    const storage = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    const saved = new Map([
      ['sidekick.sidebar', 'collapsed'],
      ['sidekick.inspector.width', '550'],
    ]);
    const access = () => {
      if (mode === 'read') throw new DOMException('Storage is blocked', 'SecurityError');
      return {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: () => {
          throw new DOMException('Storage is full', 'QuotaExceededError');
        },
      };
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, get: access });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: access });
    globalThis.fetch = async (path) =>
      path === '/api/state'
        ? new Response(JSON.stringify({ error: 'Fixture is offline.' }), { status: 503 })
        : new Response(
            JSON.stringify({
              tasks: [],
              events: [],
              currentBrowser: null,
              runtime: { browser: 'Ready', workspace: 'Ready', database: 'Ready' },
            }),
          );
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => root.render(createElement(App)));
      assert.match(element.textContent!, /Fixture is offline/);
      const collapsed = mode === 'write';
      assert.equal(
        element.querySelector('.app-shell')!.classList.contains('sidebar-collapsed'),
        collapsed,
      );
      await act(async () =>
        element
          .querySelector<HTMLButtonElement>(
            `[aria-label="${collapsed ? 'Expand' : 'Collapse'} sidebar"]`,
          )!
          .click(),
      );
      assert.equal(
        element.querySelector('.app-shell')!.classList.contains('sidebar-collapsed'),
        !collapsed,
      );
      await act(async () => root.render(createElement(Inspector, { onClose() {} })));
      const resizer = element.querySelector<HTMLElement>('[aria-label="Resize inspector"]')!;
      assert.equal(resizer.getAttribute('aria-valuenow'), mode === 'write' ? '550' : '480');
      await act(async () =>
        resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
      );
      assert.equal(resizer.getAttribute('aria-valuenow'), mode === 'write' ? '590' : '520');
    } finally {
      await act(async () => root.unmount());
      element.remove();
      globalThis.fetch = previousFetch;
      Object.defineProperty(window, 'localStorage', storage);
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
