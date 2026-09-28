import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import type { Connection } from '../src/shared/contracts.ts';
import { pageDataCache } from '../src/web/lib/page-data-cache.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLInputElement',
  'NodeFilter',
  'MutationObserver',
  'getComputedStyle',
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
const { Apps } = await import('../src/web/pages/apps.tsx');
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
const dialogButton = (label: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (candidate) => candidate.textContent === label,
  );
  assert.ok(button, `Expected dialog button: ${label}`);
  return button;
};

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

test('Apps retains cached account cards with one add action and named icon disconnects', async () => {
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
    assert.equal(container.querySelector('[aria-label="Add Gmail account"]')?.textContent, '');
    assert.equal(
      container.querySelector('[aria-label="Connect Calendar"]')?.textContent,
      'Connect',
    );
    assert.equal(container.querySelector('select'), null);
    assert.equal(container.querySelectorAll('.compact-account').length, 2);
    const first = container.querySelector('.compact-account')!;
    assert.equal(first.querySelector('.compact-account-name')?.textContent, 'one@example.com');
    const disconnect = first.querySelector<HTMLButtonElement>('[data-disconnect-account="one"]')!;
    assert.equal(disconnect.textContent, '');
    assert.equal(disconnect.title, 'Disconnect account');
    assert.equal(disconnect.getAttribute('aria-label'), 'Disconnect one@example.com from Gmail');
    assert.equal(disconnect.disabled, false);
    assert.equal(container.querySelectorAll('[aria-label="Add Gmail account"]').length, 1);
    assert.equal(container.querySelectorAll('.app-card').length, 2);
    assert.match(container.textContent ?? '', /Connected apps/);
    assert.match(container.textContent ?? '', /More apps/);
    assert.match(
      container.querySelector('[data-disconnect-account="two"]')?.parentElement?.textContent ?? '',
      /two@example.com/,
    );
    assert.doesNotMatch(container.textContent ?? '', /Second Person/);
    assert.equal(
      container.querySelector('[data-disconnect-account="two"]')?.getAttribute('aria-label'),
      'Disconnect two@example.com from Gmail',
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
    assert.deepEqual(writes, []);
    await act(async () => dialogButton('Disconnect').click());
    await act(async () => delay(0));
    assert.deepEqual(writes, ['/api/apps/gmail/accounts/one/disconnect']);
    assert.equal(container.querySelector('[data-disconnect-account="one"]'), null);
    assert.ok(container.querySelector('[data-disconnect-account="two"]'));
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Add Gmail account');
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

test('a partial disconnect failure keeps the account and dialog available for retry after stale refreshes', async () => {
  const priorFetch = globalThis.fetch;
  const reads: Array<(response: Response) => void> = [];
  let writes = 0;
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      writes++;
      return writes === 1
        ? Response.json({ error: 'Remote disconnect could not finish.' }, { status: 502 })
        : Response.json({});
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
    await act(async () => dialogButton('Disconnect').click());
    assert.equal(writes, 1);
    assert.match(
      document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? '',
      /Remote disconnect could not finish/,
    );
    assert.equal(dialogButton('Disconnect').disabled, false);
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
    assert.ok(document.querySelector('[role="dialog"]'));
    await act(async () => dialogButton('Disconnect').click());
    assert.equal(writes, 2);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(container.querySelector('[data-disconnect-account="one"]'), null);
    assert.ok(container.querySelector('[data-disconnect-account="two"]'));
    await act(async () => reads[2](Response.json(accounts.slice(1))));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/apps', () => null);
    globalThis.fetch = priorFetch;
  }
});

test('Apps offers Slack, Notion and Linear with local icons and disables unavailable services', async () => {
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
    {
      slug: 'linear',
      name: 'Linear',
      description: 'Read projects and issues.',
      status: 'disconnected',
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
    assert.ok(container.querySelector('img[src="/logos/linear.svg"]'));
    assert.doesNotMatch(container.textContent ?? '', /Google sign-in|Connections/);
    const slack = container.querySelector<HTMLButtonElement>('[aria-label="Connect Slack"]')!;
    const notion = container.querySelector<HTMLButtonElement>('[aria-label="Connect Notion"]')!;
    const linear = container.querySelector<HTMLButtonElement>('[aria-label="Connect Linear"]')!;
    assert.equal(slack.textContent, 'Connect');
    assert.equal(slack.disabled, false);
    assert.equal(notion.disabled, true);
    assert.equal(linear.disabled, false);
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
    assert.equal(disconnect.textContent, '');
    assert.equal(disconnect.title, 'Disconnect account');
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

test('confirmed disconnect keeps the account visible and prevents duplicate requests while pending', async () => {
  const priorFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  let removed = false;
  const writes: string[] = [];
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
    assert.deepEqual(writes, []);
    await act(async () => dialogButton('Disconnect').click());
    assert.deepEqual(writes, ['/api/apps/gmail/accounts/one/disconnect']);
    assert.equal(dialogButton('Disconnecting…').disabled, true);
    assert.equal(container.querySelectorAll('.compact-account').length, 2);
    assert.ok(
      [...container.querySelectorAll<HTMLButtonElement>('button')].every(
        (button) => button.disabled,
      ),
    );
    await act(async () => {
      disconnect.click();
      dialogButton('Disconnecting…').click();
    });
    assert.equal(writes.length, 1);
    await act(async () => {
      removed = true;
      finish(Response.json({}));
    });
    await act(async () => delay(0));
    assert.equal(container.querySelectorAll('.compact-account').length, 1);
    assert.equal(
      container.querySelector<HTMLButtonElement>('[data-disconnect-account="two"]')?.disabled,
      false,
    );
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Add Gmail account');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/apps', () => null);
    globalThis.fetch = priorFetch;
  }
});

test('disconnect asks about the selected account and cancellation sends no request', async () => {
  const priorFetch = globalThis.fetch;
  const writes: string[] = [];
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'POST') writes.push(String(url));
    return Response.json(accounts);
  };
  pageDataCache.update('/api/apps', () => accounts);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Apps)));
    const disconnect = container.querySelector<HTMLButtonElement>(
      '[data-disconnect-account="two"]',
    )!;
    await act(async () => {
      disconnect.focus();
      disconnect.click();
    });
    assert.deepEqual(writes, []);
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent ?? '', /Disconnect from Gmail\?/);
    assert.match(dialog.textContent ?? '', /two@example.com/);
    assert.doesNotMatch(dialog.textContent ?? '', /one@example.com/);
    assert.equal(document.activeElement?.textContent, 'Keep account');
    await act(async () => dialogButton('Keep account').click());
    await act(async () => delay(0));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(
      document.activeElement?.getAttribute('aria-label'),
      disconnect.getAttribute('aria-label'),
    );
    assert.deepEqual(writes, []);
    assert.equal(container.querySelectorAll('.compact-account').length, 2);
    await act(async () => disconnect.click());
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    await act(async () => delay(0));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(
      document.activeElement?.getAttribute('aria-label'),
      disconnect.getAttribute('aria-label'),
    );
    assert.deepEqual(writes, []);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/apps', () => null);
    globalThis.fetch = priorFetch;
  }
});

test('removing the final account returns focus to Connect on the available app card', async () => {
  const priorFetch = globalThis.fetch;
  let removed = false;
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      removed = true;
      return Response.json({});
    }
    return Response.json(
      removed
        ? [{ slug: 'gmail', name: 'Gmail', status: 'disconnected', triggersEnabled: false }]
        : [accounts[0]],
    );
  };
  pageDataCache.update('/api/apps', () => [accounts[0]]);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Apps)));
    await act(async () => {
      const disconnect = container.querySelector<HTMLButtonElement>(
        '[data-disconnect-account="one"]',
      )!;
      disconnect.focus();
      disconnect.click();
    });
    await act(async () => dialogButton('Disconnect').click());
    await act(async () => delay(0));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(container.querySelectorAll('.compact-account').length, 0);
    const connect = container.querySelector<HTMLButtonElement>('[aria-label="Connect Gmail"]')!;
    assert.equal(connect.disabled, false);
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Connect Gmail');
    assert.equal(container.querySelectorAll('.app-card').length, 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/apps', () => null);
    globalThis.fetch = priorFetch;
  }
});

test('leaving Apps aborts disconnect and ignores a late response for the previous page', async () => {
  const priorFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  let reads = 0;
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    reads++;
    return Response.json(accounts);
  };
  pageDataCache.update('/api/apps', () => accounts);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Apps)));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-disconnect-account="one"]')!.click(),
    );
    await act(async () => dialogButton('Disconnect').click());
    await act(async () => root.render(null));
    assert.equal(signal?.aborted, true);
    const readsBeforeResponse = reads;
    await act(async () => finish(Response.json({})));
    assert.equal(reads, readsBeforeResponse);
    assert.deepEqual(pageDataCache.getSnapshot<Connection[]>('/api/apps').data, accounts);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/apps', () => null);
    globalThis.fetch = priorFetch;
  }
});

test('Notion workspaces with the same owner email remain distinct in account rows and disconnect confirmation', async () => {
  const priorFetch = globalThis.fetch;
  const workspaces: Connection[] = [
    {
      slug: 'notion',
      name: 'Notion',
      status: 'connected',
      connectionId: 'workspace-team',
      accountName: 'Team workspace',
      accountEmail: 'owner@example.com',
      triggersEnabled: false,
    },
    {
      slug: 'notion',
      name: 'Notion',
      status: 'connected',
      connectionId: 'workspace-personal',
      accountName: 'Personal workspace',
      accountEmail: 'owner@example.com',
      triggersEnabled: false,
    },
  ];
  const writes: string[] = [];
  let removed = false;
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'POST') {
      writes.push(String(url));
      removed = true;
      return Response.json({});
    }
    return Response.json(removed ? [workspaces[0]] : workspaces);
  };
  pageDataCache.update('/api/apps', () => workspaces);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Apps)));
    assert.deepEqual(
      [...container.querySelectorAll('.compact-account-name')].map((label) => label.textContent),
      ['Team workspace · owner@example.com', 'Personal workspace · owner@example.com'],
    );
    const selected = container.querySelector<HTMLButtonElement>(
      '[aria-label="Disconnect Personal workspace · owner@example.com from Notion"]',
    )!;
    assert.ok(selected);
    assert.ok(
      container.querySelector(
        '[aria-label="Disconnect Team workspace · owner@example.com from Notion"]',
      ),
    );
    await act(async () => {
      selected.focus();
      selected.click();
    });
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent ?? '', /Disconnect from Notion\?/);
    assert.match(dialog.textContent ?? '', /Personal workspace · owner@example.com/);
    assert.doesNotMatch(dialog.textContent ?? '', /Team workspace/);
    assert.deepEqual(writes, []);
    await act(async () => dialogButton('Disconnect').click());
    assert.deepEqual(writes, ['/api/apps/notion/accounts/workspace-personal/disconnect']);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(container.querySelector('[data-disconnect-account="workspace-personal"]'), null);
    assert.ok(container.querySelector('[data-disconnect-account="workspace-team"]'));
    assert.equal(
      container.querySelector('.compact-account-name')?.textContent,
      'Team workspace · owner@example.com',
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/apps', () => null);
    globalThis.fetch = priorFetch;
  }
});
