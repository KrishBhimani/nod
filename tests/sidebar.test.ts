import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { Sidebar } from '../src/web/components/sidebar.tsx';

const dom = new JSDOM(
  '<!doctype html><html><body><main id="workspace" tabindex="-1"></main></body></html>',
  { url: 'http://localhost:4310', pretendToBeVisual: true },
);
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'requestAnimationFrame',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(dom.window.navigator, 'platform', { value: 'MacIntel' });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');

test('sidebar exposes navigation shortcuts, keyboard focus and modifier hints without consuming normal typing', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const navigations: string[] = [];
  let toggles = 0;
  let inspections = 0;
  let restarts = 0;
  try {
    await act(async () =>
      root.render(
        createElement(Sidebar, {
          path: '/goals',
          development: true,
          collapsed: false,
          onToggle() {
            toggles++;
          },
          onNavigate(path) {
            navigations.push(path);
          },
          onRestart() {
            restarts++;
          },
          inspectorEnabled: true,
          inspectorOpen: false,
          onToggleInspector() {
            inspections++;
          },
        }),
      ),
    );
    const links = Array.from(element.querySelectorAll<HTMLAnchorElement>('nav a'));
    assert.equal(links.length, 6);
    assert.equal(links[1]?.getAttribute('aria-current'), 'page');
    assert.ok(
      links.every(
        (link) =>
          link.getAttribute('aria-label') &&
          link.getAttribute('aria-keyshortcuts') &&
          link.getAttribute('title'),
      ),
    );
    assert.equal(links[5]?.getAttribute('aria-keyshortcuts'), 'Meta+K Control+K');
    assert.equal(links[5]?.getAttribute('title'), 'Vault (⌘K)');
    assert.equal(links[5]?.querySelector('kbd')?.textContent, 'K');
    links[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(document.activeElement, links[0]);
    links[0]!.focus();
    links[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.equal(document.activeElement, links[5]);
    links[5]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(document.activeElement, links[0]);
    const more = element.querySelector<HTMLButtonElement>('[aria-label="Navigation menu"]')!;
    await act(async () => more.click());
    const menu = element.querySelector('[role="menu"]')!;
    assert.equal(menu.querySelectorAll('[role="menuitem"]').length, 8);
    await act(async () =>
      [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
        .find((button) => button.textContent?.includes('Inspector'))!
        .click(),
    );
    assert.equal(inspections, 1);
    assert.equal(element.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, more);
    await act(async () => more.click());
    await act(async () =>
      [...element.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
        .find((button) => button.textContent?.includes('Restart setup'))!
        .click(),
    );
    assert.equal(restarts, 1);
    const darkTheme = element.querySelector<HTMLButtonElement>(
      '.sidebar-bottom [aria-label="Switch to dark theme"]',
    )!;
    assert.ok(darkTheme);
    await act(async () => darkTheme.click());
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal(window.localStorage.getItem('sidekick.theme'), 'dark');
    assert.ok(element.querySelector('.sidebar-bottom [aria-label="Switch to light theme"]'));
    await act(async () => more.click());
    const lightTheme = [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent?.includes('Switch to light theme'),
    )!;
    assert.ok(lightTheme);
    await act(async () => lightTheme.click());
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.equal(window.localStorage.getItem('sidekick.theme'), 'light');
    assert.equal(element.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, more);
    inspections = 0;
    const press = async (key: string, extra: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...extra,
      });
      await act(async () => window.dispatchEvent(event));
      return event;
    };
    await press('Meta', { metaKey: true });
    assert.equal(element.querySelector('.sidebar')?.classList.contains('show-shortcuts'), false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    assert.equal(element.querySelector('.sidebar')?.classList.contains('show-shortcuts'), true);
    assert.equal(element.querySelector('.nav-shortcut')?.textContent, 'J');
    await press('j', { metaKey: true });
    assert.equal(element.querySelector('.sidebar')?.classList.contains('show-shortcuts'), false);
    await press('g', { metaKey: true });
    for (const key of ['s', 'e', 'd', 'k']) await press(key, { metaKey: true });
    for (const key of ['b', 'i']) {
      assert.equal((await press(key, { metaKey: true })).defaultPrevented, false);
      assert.equal((await press(key, { ctrlKey: true })).defaultPrevented, false);
    }
    assert.deepEqual(navigations, ['/', '/goals', '/schedule', '/apps', '/channels', '/vault']);
    assert.equal(toggles, 0);
    assert.equal(inspections, 0);
    const inspector = element.querySelector<HTMLButtonElement>('[aria-label="Inspector"]')!;
    const collapse = element.querySelector<HTMLButtonElement>('[aria-label="Collapse sidebar"]')!;
    for (const button of [inspector, collapse]) {
      assert.equal(button.getAttribute('aria-keyshortcuts'), null);
      assert.equal(button.querySelector('kbd'), null);
    }
    await act(async () => {
      inspector.click();
      collapse.click();
    });
    assert.equal(toggles, 1);
    assert.equal(inspections, 1);
    assert.equal(
      element.querySelector('[aria-label="Inspector"]')?.getAttribute('aria-expanded'),
      'false',
    );
    assert.equal((await press('b')).defaultPrevented, false);
    assert.equal((await press('b', { metaKey: true, repeat: true })).defaultPrevented, false);
    await press('Meta', { metaKey: true });
    await act(async () => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' })));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    assert.equal(element.querySelector('.sidebar')?.classList.contains('show-shortcuts'), false);
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(element.querySelector('.sidebar')?.classList.contains('show-shortcuts'), false);
    await act(async () =>
      root.render(
        createElement(Sidebar, {
          path: '/',
          collapsed: true,
          onToggle() {},
          onNavigate() {},
          onRestart() {},
        }),
      ),
    );
    assert.equal(
      element.querySelector('[aria-label="Expand sidebar"]')?.getAttribute('aria-expanded'),
      'false',
    );
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test('sidebar preserves all shortcuts inside editable fields, including nested and shadow inputs', async () => {
  const element = document.createElement('div');
  const fields = document.createElement('div');
  fields.innerHTML =
    '<input><textarea></textarea><select><option>One</option></select><div contenteditable="true" tabindex="0"><span>Draft</span></div><div role="textbox" tabindex="0">Text</div>';
  const shadowHost = document.createElement('div');
  const shadow = shadowHost.attachShadow({ mode: 'open' });
  const shadowInput = document.createElement('input');
  shadow.append(shadowInput);
  fields.append(shadowHost);
  document.body.append(element, fields);
  const root = createRoot(element);
  const actions: string[] = [];
  const press = (target: EventTarget, key: string, modifier: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      composed: true,
      ...modifier,
    });
    target.dispatchEvent(event);
    return event;
  };
  try {
    await act(async () =>
      root.render(
        createElement(Sidebar, {
          path: '/',
          collapsed: false,
          onToggle: () => actions.push('toggle'),
          onNavigate: (path) => actions.push(path),
          onRestart() {},
          inspectorEnabled: true,
          onToggleInspector: () => actions.push('inspect'),
        }),
      ),
    );
    const targets = [
      ...fields.querySelectorAll<HTMLElement>(
        'input, textarea, select, [contenteditable], span, [role="textbox"]',
      ),
      shadowInput,
    ];
    await act(async () => {
      for (const target of targets) {
        target.focus();
        for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
          for (const key of ['j', 'g', 's', 'e', 'd', 'k', 'b', 'i', 'a', 'c', 'v', 'z']) {
            assert.equal(press(target, key, modifier).defaultPrevented, false);
          }
        }
      }
      assert.equal(press(window, 'g', { metaKey: true }).defaultPrevented, false);
      targets[0]!.focus();
      assert.equal(press(window, 'g', { metaKey: true }).defaultPrevented, false);
      press(targets[0]!, 'Meta', { metaKey: true });
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    assert.equal(element.querySelector('.sidebar')?.classList.contains('show-shortcuts'), false);
    assert.deepEqual(actions, []);
    await act(async () => {
      document.getElementById('workspace')!.focus();
      press(window, 'Meta', { metaKey: true });
      shadowInput.focus();
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    assert.equal(element.querySelector('.sidebar')?.classList.contains('show-shortcuts'), false);
    const handled = new KeyboardEvent('keydown', { key: 'g', metaKey: true, cancelable: true });
    handled.preventDefault();
    await act(async () => {
      document.getElementById('workspace')!.focus();
      window.dispatchEvent(handled);
    });
    assert.deepEqual(actions, []);
    await act(async () => {
      assert.equal(press(window, 'g', { ctrlKey: true }).defaultPrevented, true);
    });
    assert.deepEqual(actions, ['/goals']);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    fields.remove();
  }
});

test('mobile navigation keeps secondary pages in a dismissible menu and preserves native link actions', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const navigations: string[] = [];
  try {
    await act(async () =>
      root.render(
        createElement(Sidebar, {
          path: '/vault',
          collapsed: true,
          onToggle() {},
          onRestart() {},
          onNavigate(path) {
            navigations.push(path);
          },
        }),
      ),
    );
    const trigger = element.querySelector<HTMLButtonElement>('[aria-label="Navigation menu"]')!;
    assert.ok(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(element.querySelector('[role="menu"]'), null);
    const open = async () => {
      await act(async () => trigger.click());
    };
    await open();
    const links = [
      ...element.querySelectorAll<HTMLAnchorElement>('[role="menu"] a[role="menuitem"]'),
    ];
    assert.deepEqual(
      links.map((link) => link.getAttribute('href')),
      ['/goals', '/schedule', '/apps', '/channels', '/vault'],
    );
    assert.equal(links[4]!.getAttribute('aria-current'), 'page');
    assert.equal(document.activeElement, links[0]);
    assert.deepEqual(
      [...element.querySelectorAll<HTMLButtonElement>('[role="menu"] button[role="menuitem"]')].map(
        (button) => button.textContent?.trim(),
      ),
      ['Switch to dark theme', 'Restart setupStarts a new chat. Keeps your saved data.'],
    );
    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, [modifier]: true });
      await act(async () => links[0]!.dispatchEvent(event));
      assert.equal(event.defaultPrevented, false);
      assert.deepEqual(navigations, []);
    }
    await act(async () =>
      links[0]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    );
    assert.equal(element.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);
    await open();
    await act(async () =>
      document
        .getElementById('workspace')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    assert.equal(element.querySelector('[role="menu"]'), null);
    await open();
    await act(async () =>
      element.querySelector<HTMLAnchorElement>('[role="menu"] a[href="/goals"]')!.click(),
    );
    assert.deepEqual(navigations, ['/goals']);
    assert.equal(element.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);
    await open();
    await act(async () => window.dispatchEvent(new Event('resize')));
    assert.equal(element.querySelector('[role="menu"]'), null);
    const chat = element.querySelector<HTMLAnchorElement>('.mobile-chat-link')!;
    assert.ok(chat);
    assert.equal(chat.getAttribute('href'), '/');
    await act(async () => chat.click());
    assert.deepEqual(navigations, ['/goals', '/']);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test('shortcut focus uses only the latest navigation and never runs after sidebar unmount', async () => {
  const requestFrame = window.requestAnimationFrame;
  const cancelFrame = window.cancelAnimationFrame;
  const pending = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  window.requestAnimationFrame = (callback) => {
    pending.set(++nextFrame, callback);
    return nextFrame;
  };
  window.cancelAnimationFrame = (id) => {
    pending.delete(id);
  };
  const element = document.createElement('div');
  const composer = document.createElement('div');
  composer.className = 'composer-editor';
  composer.setAttribute('contenteditable', 'true');
  composer.tabIndex = 0;
  document.body.append(element, composer);
  const root = createRoot(element);
  let mounted = true;
  const navigations: string[] = [];
  const press = async (key: string) => {
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );
  };
  try {
    await act(async () =>
      root.render(
        createElement(Sidebar, {
          path: '/',
          collapsed: false,
          onToggle() {},
          onRestart() {},
          onNavigate(path) {
            navigations.push(path);
          },
        }),
      ),
    );
    document.getElementById('workspace')!.focus();
    await press('g');
    assert.equal(pending.size, 1);
    await press('j');
    assert.equal(pending.size, 1);
    assert.deepEqual(navigations, ['/goals', '/']);
    await act(async () => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(0);
    });
    assert.equal(document.activeElement, composer);
    document.getElementById('workspace')!.focus();
    await press('e');
    assert.equal(pending.size, 1);
    await act(async () => root.unmount());
    mounted = false;
    assert.equal(pending.size, 0);
  } finally {
    if (mounted) await act(async () => root.unmount());
    window.requestAnimationFrame = requestFrame;
    window.cancelAnimationFrame = cancelFrame;
    element.remove();
    composer.remove();
  }
});

test('production keeps developer controls in the app menu with setup context and keyboard dismissal', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  let inspections = 0;
  let restarts = 0;
  const render = async (enabled: boolean) =>
    act(async () =>
      root.render(
        createElement(Sidebar, {
          path: '/',
          collapsed: true,
          development: false,
          inspectorEnabled: enabled,
          onNavigate() {},
          onToggle() {},
          onRestart() {
            restarts++;
          },
          onToggleInspector() {
            inspections++;
          },
        }),
      ),
    );
  try {
    await render(true);
    assert.equal(element.querySelector('.sidebar-bottom [aria-label="Inspector"]'), null);
    assert.equal(element.querySelector('.sidebar-bottom [aria-label="Get started"]'), null);
    const trigger = element.querySelector<HTMLButtonElement>('[aria-label="App menu"]')!;
    assert.ok(trigger);
    await act(async () => trigger.click());
    const menu = element.querySelector<HTMLElement>('[role="menu"]')!;
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0]!.textContent?.trim(), 'Inspector');
    assert.ok(buttons[1]!.textContent?.includes('Keeps your saved data.'));
    await act(async () => buttons[0]!.click());
    assert.equal(inspections, 1);
    assert.equal(element.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);
    await act(async () => trigger.click());
    await act(async () =>
      element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!.click(),
    );
    assert.equal(restarts, 1);
    await act(async () => trigger.click());
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    );
    assert.equal(element.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);
    await render(false);
    await act(async () => trigger.click());
    assert.equal(element.querySelectorAll('[role="menuitem"]').length, 1);
    assert.ok(element.querySelector('[role="menuitem"]')?.textContent?.includes('Restart setup'));
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
