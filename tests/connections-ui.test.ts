import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { Connection } from '../src/shared/contracts.ts';
import { pageDataCache } from '../src/web/lib/page-data-cache.ts';
import { Apps } from '../src/web/pages/apps.tsx';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
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
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const accounts: Connection[] = [
  {
    slug: 'gmail',
    name: 'Gmail',
    status: 'connected',
    connectionId: 'one',
    accountName: 'one@example.com',
    accountEmail: 'one@example.com',
    triggersEnabled: true,
  },
  {
    slug: 'gmail',
    name: 'Gmail',
    status: 'connected',
    connectionId: 'two',
    accountName: 'Second Person',
    accountEmail: 'two@example.com',
    triggersEnabled: true,
  },
  { slug: 'googlecalendar', name: 'Calendar', status: 'disconnected', triggersEnabled: false },
];
const click = (element: Element) =>
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

test('Apps retains cached accounts and exposes per-service actions with accessible account menus', async () => {
  const priorFetch = globalThis.fetch;
  let complete: (response: Response) => void = () => {};
  globalThis.fetch = async () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  pageDataCache.update('/api/apps', () => accounts);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Apps)));
    assert.equal(container.querySelector('.loading'), null);
    assert.equal(container.querySelectorAll('.button-primary').length, 0);
    assert.equal(container.querySelectorAll('.button-outline').length, 2);
    assert.equal(
      container.querySelector('[aria-label="Add Gmail account"]')?.textContent,
      'Add account',
    );
    assert.equal(
      container.querySelector('[aria-label="Connect Calendar"]')?.textContent,
      'Connect',
    );
    assert.equal(container.querySelector('select'), null);
    assert.equal(container.querySelectorAll('.compact-account').length, 2);
    const first = container.querySelector('.compact-account')!;
    assert.equal(first.textContent, 'one@example.com');
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Actions for one@example.com"]',
    )!;
    await act(async () => click(trigger));
    const menu = container.querySelector('[role="menu"]')!;
    assert.equal(menu.querySelectorAll('[role="menuitem"]').length, 1);
    assert.equal(document.activeElement, menu.querySelector('[role="menuitem"]'));
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      ),
    );
    assert.equal(document.activeElement, menu.querySelector('[role="menuitem"]'));
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    assert.equal(container.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);
    await act(async () => click(trigger));
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    assert.equal(container.querySelector('[role="menu"]'), null);
    const outside = document.createElement('button');
    outside.addEventListener('click', (event) => event.stopPropagation());
    document.body.append(outside);
    await act(async () => click(trigger));
    await act(async () => click(outside));
    assert.equal(container.querySelector('[role="menu"]'), null);
    await act(async () => click(trigger));
    await act(async () => outside.focus());
    assert.equal(container.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, outside);
    outside.remove();
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(Apps)));
    assert.equal(container.querySelector('.loading'), null);
    assert.equal(container.querySelectorAll('.compact-account').length, 2);
    await act(async () => complete(new Response(JSON.stringify(accounts))));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/apps', () => null);
    globalThis.fetch = priorFetch;
  }
});

test('disconnect removes only the accepted account and a late cached refresh cannot restore it', async () => {
  const priorFetch = globalThis.fetch;
  const reads: Array<(response: Response) => void> = [];
  const writes: string[] = [];
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'POST') {
      writes.push(String(url));
      return new Response('{}');
    }
    return new Promise((resolve) => reads.push(resolve));
  };
  pageDataCache.update('/api/apps', () => accounts);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Apps)));
    await act(async () =>
      click(container.querySelector('[aria-label="Actions for one@example.com"]')!),
    );
    await act(async () => click(container.querySelector('[role="menuitem"]')!));
    assert.deepEqual(writes, ['/api/apps/gmail/accounts/one/disconnect']);
    assert.equal(container.querySelector('[aria-label="Actions for one@example.com"]'), null);
    assert.ok(container.querySelector('[aria-label="Actions for Second Person"]'));
    assert.equal(
      document.activeElement,
      container.querySelector('[aria-label="Add Gmail account"]'),
    );
    assert.equal(
      container.querySelector('[aria-label="Add Gmail account"]')?.hasAttribute('disabled'),
      false,
    );
    await act(async () => reads[0](new Response(JSON.stringify(accounts))));
    assert.equal(container.querySelectorAll('.compact-account').length, 1);
    await act(async () => reads[1](new Response(JSON.stringify(accounts.slice(1)))));
    assert.equal(container.querySelectorAll('.compact-account').length, 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/apps', () => null);
    globalThis.fetch = priorFetch;
  }
});

test('a partial disconnect failure refreshes revoked access without claiming the account was removed', async () => {
  const priorFetch = globalThis.fetch;
  const reads: Array<(response: Response) => void> = [];
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST')
      return Response.json({ error: 'Remote disconnect could not finish.' }, { status: 502 });
    return new Promise((resolve) => reads.push(resolve));
  };
  pageDataCache.update('/api/apps', () => accounts);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Apps)));
    await act(async () =>
      click(container.querySelector('[aria-label="Actions for one@example.com"]')!),
    );
    await act(async () => click(container.querySelector('[role="menuitem"]')!));
    assert.match(container.textContent ?? '', /Remote disconnect could not finish/);
    assert.equal(reads.length, 2);
    await act(async () =>
      reads[1](Response.json([{ ...accounts[0], status: 'disconnected' }, ...accounts.slice(1)])),
    );
    assert.equal(container.querySelectorAll('.compact-account').length, 2);
    assert.match(
      container.querySelector('.compact-account')?.textContent ?? '',
      /Sign-in required/,
    );
    await act(async () => reads[0](Response.json(accounts)));
    assert.match(
      container.querySelector('.compact-account')?.textContent ?? '',
      /Sign-in required/,
    );
    assert.equal(container.querySelector('.loading'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/apps', () => null);
    globalThis.fetch = priorFetch;
  }
});

test('Apps offers Slack and Notion with local icons and disables unavailable services', async () => {
  const priorFetch = globalThis.fetch;
  const catalog: Connection[] = [
    {
      slug: 'slack',
      name: 'Slack',
      description: 'Find team conversations.',
      status: 'disconnected',
      triggersEnabled: false,
    },
    {
      slug: 'notion',
      name: 'Notion',
      description: 'Read pages and databases.',
      status: 'not_configured',
      triggersEnabled: false,
    },
  ];
  globalThis.fetch = async () => Response.json(catalog);
  pageDataCache.update('/api/apps', () => catalog);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Apps)));
    assert.equal(container.querySelector('h1')?.textContent, 'Apps');
    assert.equal(container.querySelector('img[src="/logos/slack.svg"]')?.getAttribute('alt'), '');
    assert.ok(container.querySelector('img[src="/logos/notion.svg"]'));
    assert.doesNotMatch(container.textContent ?? '', /Google sign-in|Connections/);
    const slack = container.querySelector<HTMLButtonElement>('[aria-label="Connect Slack"]')!;
    const notion = container.querySelector<HTMLButtonElement>('[aria-label="Connect Notion"]')!;
    assert.equal(slack.textContent, 'Connect');
    assert.equal(slack.disabled, false);
    assert.equal(notion.disabled, true);
    assert.equal(container.querySelector('[role="menu"]'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/apps', () => null);
    globalThis.fetch = priorFetch;
  }
});

test('an unavailable account keeps explicit add and disconnect choices without claiming account repair', async () => {
  const priorFetch = globalThis.fetch;
  const values: Connection[] = [{ ...accounts[0], status: 'disconnected' }, accounts[1]];
  globalThis.fetch = async () => Response.json(values);
  pageDataCache.update('/api/apps', () => values);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Apps)));
    assert.match(
      container.querySelector('.compact-account')?.textContent ?? '',
      /Sign-in required/,
    );
    assert.equal(container.querySelectorAll('[aria-label="Add Gmail account"]').length, 1);
    assert.equal(container.querySelectorAll('.compact-account').length, 2);
    await act(async () =>
      click(container.querySelector('[aria-label="Actions for one@example.com"]')!),
    );
    const items = [...container.querySelectorAll('[role="menuitem"]')];
    assert.deepEqual(
      items.map((item) => item.textContent),
      ['Disconnect account'],
    );
    assert.doesNotMatch(container.textContent ?? '', /Sign in again|restore access|Reconnect/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/apps', () => null);
    globalThis.fetch = priorFetch;
  }
});
