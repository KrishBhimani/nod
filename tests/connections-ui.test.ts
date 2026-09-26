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

test('leaving Apps prevents a late account connection from redirecting the current page', async () => {
  const priorFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  const navigationErrors: Error[] = [];
  const recordError = (error: Error) => navigationErrors.push(error);
  dom.virtualConsole.on('jsdomError', recordError);
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return Response.json(accounts);
  };
  pageDataCache.update('/api/apps', () => accounts);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Apps)));
    await act(async () => click(container.querySelector('[aria-label="Add Gmail account"]')!));
    await act(async () => root.render(null));
    await act(async () => finish(Response.json({ url: 'https://accounts.example.test/connect' })));
    assert.equal(navigationErrors.length, 0);
    assert.equal(signal?.aborted, true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/apps', () => null);
    globalThis.fetch = priorFetch;
    dom.virtualConsole.off('jsdomError', recordError);
  }
});

test('Apps retains cached accounts and exposes a direct named disconnect beside each identity', async () => {
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
    assert.equal(first.querySelector('.compact-account-name')?.textContent, 'one@example.com');
    const disconnect = first.querySelector<HTMLButtonElement>('[data-disconnect-account="one"]')!;
    assert.equal(disconnect.textContent, 'Disconnect');
    assert.equal(disconnect.getAttribute('aria-label'), 'Disconnect one@example.com from Gmail');
    assert.equal(disconnect.disabled, false);
    assert.equal(
      disconnect.previousElementSibling,
      first.querySelector('.compact-account-details'),
    );
    assert.equal(container.querySelector('[aria-label="Connected"]'), null);
    assert.equal(container.querySelector('[aria-haspopup="menu"]'), null);
    assert.equal(container.querySelector('[role="menu"]'), null);
    assert.equal(container.querySelectorAll('[data-disconnect-account]').length, 2);
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
    await act(async () => {
      const button = container.querySelector<HTMLButtonElement>('[data-disconnect-account="one"]')!;
      button.focus();
      click(button);
    });
    assert.deepEqual(writes, ['/api/apps/gmail/accounts/one/disconnect']);
    assert.equal(container.querySelector('[data-disconnect-account="one"]'), null);
    assert.ok(container.querySelector('[data-disconnect-account="two"]'));
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
    await act(async () => {
      const button = container.querySelector<HTMLButtonElement>('[data-disconnect-account="one"]')!;
      button.focus();
      click(button);
    });
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
    const disconnect = container.querySelector<HTMLButtonElement>(
      '[data-disconnect-account="one"]',
    )!;
    assert.equal(disconnect.textContent, 'Disconnect');
    assert.equal(disconnect.disabled, false);
    assert.equal(container.querySelector('[role="menu"]'), null);
    assert.doesNotMatch(container.textContent ?? '', /Sign in again|restore access|Reconnect/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/apps', () => null);
    globalThis.fetch = priorFetch;
  }
});

test('direct disconnect keeps the selected account visible and disables account actions while pending', async () => {
  const priorFetch = globalThis.fetch;
  const priorConfirm = window.confirm;
  let finish!: (response: Response) => void;
  let removed = false;
  const writes: string[] = [];
  window.confirm = () => assert.fail('Disconnect must not add a confirmation step');
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'POST') {
      writes.push(String(url));
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return Response.json(removed ? accounts.slice(1) : accounts);
  };
  pageDataCache.update('/api/apps', () => accounts);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Apps)));
    const disconnect = container.querySelector<HTMLButtonElement>(
      '[data-disconnect-account="one"]',
    )!;
    await act(async () => {
      disconnect.focus();
      disconnect.click();
    });
    assert.deepEqual(writes, ['/api/apps/gmail/accounts/one/disconnect']);
    assert.equal(container.querySelectorAll('.compact-account').length, 2);
    assert.ok(
      [...container.querySelectorAll<HTMLButtonElement>('button')].every(
        (button) => button.disabled,
      ),
    );
    await act(async () => disconnect.click());
    assert.equal(writes.length, 1);
    await act(async () => {
      removed = true;
      finish(Response.json({}));
    });
    assert.equal(container.querySelectorAll('.compact-account').length, 1);
    assert.equal(
      container.querySelector<HTMLButtonElement>('[data-disconnect-account="two"]')?.disabled,
      false,
    );
    assert.equal(
      document.activeElement,
      container.querySelector('[aria-label="Add Gmail account"]'),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/apps', () => null);
    globalThis.fetch = priorFetch;
    window.confirm = priorConfirm;
  }
});
