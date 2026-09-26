import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';

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
  'Element',
  'NodeFilter',
  'MutationObserver',
  'CustomEvent',
  'getComputedStyle',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const { Channels } = await import('../src/web/pages/channels.tsx');
const status = {
  channels: [
    { provider: 'telegram', status: 'configured', missing: [] },
    { provider: 'whatsapp', status: 'configured', missing: [] },
  ],
  error: null,
};
const settings = {
  ready: true,
  channels: [
    {
      provider: 'telegram',
      enabled: true,
      mode: 'polling',
      accountName: 'Fixture Telegram',
      accountHandle: '@fixture_bot',
    },
    {
      provider: 'whatsapp',
      enabled: true,
      mode: 'webhook',
      webhookStatus: 'registered',
      accountName: 'Fixture WhatsApp',
    },
  ],
};
const snapshot = (path: string) => (path === '/api/channels' ? status : settings);

test('accepted channel disconnect survives a failed refresh and an older in-flight read', async () => {
  const priorFetch = globalThis.fetch;
  const priorConfirm = window.confirm;
  let mode: 'ready' | 'held' | 'failed' = 'ready';
  const pending: Array<{ path: string; finish: (response: Response) => void }> = [];
  const writes: string[] = [];
  window.confirm = () => true;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (init?.method === 'DELETE') {
      writes.push(path);
      mode = 'failed';
      return Response.json({ ok: true, channel: { provider: 'telegram', enabled: false } });
    }
    if (mode === 'held') return new Promise<Response>((finish) => pending.push({ path, finish }));
    if (mode === 'failed')
      return Response.json({ error: 'Fixture status refresh failed.' }, { status: 503 });
    return Response.json(snapshot(path));
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(Channels)));
    assert.match(element.textContent!, /Fixture Telegram|Ready for messages/);
    mode = 'held';
    await act(async () => window.dispatchEvent(new Event('focus')));
    assert.equal(pending.length, 2);
    const telegram = element.querySelector<HTMLElement>('.channel-option')!;
    await act(async () => {
      const remove = telegram.querySelector<HTMLButtonElement>('[data-channel-remove="telegram"]')!;
      remove.focus();
      remove.click();
    });
    assert.deepEqual(writes, ['/api/channel-settings/telegram']);
    assert.ok(element.querySelector('[aria-label="Connect Telegram"]'));
    assert.equal(document.activeElement, element.querySelector('[aria-label="Connect Telegram"]'));
    assert.doesNotMatch(
      telegram.textContent!,
      /Fixture Telegram|Ready for messages|Start conversation/,
    );
    assert.match(element.textContent!, /Fixture status refresh failed/);
    assert.match(element.textContent!, /Fixture WhatsApp|Webhook registered/);
    await act(async () => {
      for (const read of pending) read.finish(Response.json(snapshot(read.path)));
    });
    assert.ok(element.querySelector('[aria-label="Connect Telegram"]'));
    assert.doesNotMatch(telegram.textContent!, /Fixture Telegram|Ready for messages/);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
    window.confirm = priorConfirm;
  }
});

test('a rejected channel disconnect preserves the existing account and exposes the failure', async () => {
  const priorFetch = globalThis.fetch;
  const priorConfirm = window.confirm;
  window.confirm = () => true;
  globalThis.fetch = async (input, init) =>
    init?.method === 'DELETE'
      ? Response.json({ error: 'Fixture disconnect was rejected.' }, { status: 503 })
      : Response.json(snapshot(String(input)));
  const element = document.createElement('div');
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(Channels)));
    const telegram = element.querySelector<HTMLElement>('.channel-option')!;
    await act(async () => {
      const remove = telegram.querySelector<HTMLButtonElement>('[data-channel-remove="telegram"]')!;
      remove.focus();
      remove.click();
    });
    assert.equal(element.querySelector('[aria-label="Connect Telegram"]'), null);
    assert.match(telegram.textContent!, /Fixture Telegram|Ready for messages/);
    assert.match(element.textContent!, /Fixture disconnect was rejected/);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
    window.confirm = priorConfirm;
  }
});

test('successful explicit Telegram setup offers the verified bot and Start instruction without opening a popup', async () => {
  const priorFetch = globalThis.fetch;
  const priorOpen = window.open;
  let saved = false;
  let reject = true;
  let writes = 0;
  let opened = 0;
  window.open = () => {
    opened++;
    return null;
  };
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'PUT') {
      assert.equal(String(input), '/api/channel-settings/telegram');
      assert.deepEqual(JSON.parse(String(init.body)), {
        botToken: 'synthetic-fixture-token',
        allowedUserId: '123456789',
      });
      writes++;
      if (reject) return Response.json({ error: 'Verification failed.' }, { status: 503 });
      saved = true;
      return Response.json({ channel: settings.channels[0] });
    }
    return Response.json(
      saved
        ? snapshot(String(input))
        : String(input) === '/api/channels'
          ? { channels: [], error: null }
          : { ready: true, channels: [] },
    );
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const submit = async () =>
    act(async () => {
      document
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  const type = async (value: string) =>
    act(async () => {
      const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  try {
    await act(async () => root.render(createElement(Channels)));
    await act(async () =>
      element.querySelector<HTMLButtonElement>('[aria-label="Connect Telegram"]')!.click(),
    );
    await type('synthetic-fixture-token');
    await submit();
    await type('123456789');
    await submit();
    assert.equal(writes, 0);
    await submit();
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /Verification failed/);
    assert.doesNotMatch(
      document.querySelector('[role="dialog"]')!.textContent!,
      /Telegram is connected/,
    );
    assert.equal(opened, 0);
    reject = false;
    await submit();
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent!, /Telegram is connected/);
    assert.match(dialog.textContent!, /press Start/);
    assert.equal(dialog.querySelector('input'), null);
    const link = dialog.querySelector<HTMLAnchorElement>('a')!;
    assert.equal(link.href, 'https://t.me/fixture_bot');
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
    assert.equal(document.activeElement, link);
    assert.equal(opened, 0);
    assert.equal(writes, 2);
    await act(async () =>
      [...dialog.querySelectorAll('button')]
        .find((button) => button.textContent === 'Done')!
        .click(),
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(
      element.querySelector('a[href="https://t.me/fixture_bot"]')?.textContent,
      'Start conversation',
    );
    await act(async () => window.dispatchEvent(new Event('focus')));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(opened, 0);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
    window.open = priorOpen;
  }
});

test('delivery guidance closes with Escape and returns focus without changing channel setup', async () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (input) =>
    Response.json(
      String(input) === '/api/channels'
        ? status
        : {
            ...settings,
            channels: [
              settings.channels[0],
              {
                ...settings.channels[1],
                webhookStatus: 'manual_setup',
                webhookUrl: 'https://fixture.example.test/api/webhooks/whatsapp',
              },
            ],
          },
    );
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(Channels)));
    const [telegram, whatsapp] = [...element.querySelectorAll<HTMLElement>('.channel-option')];
    assert.equal(telegram.querySelector('.channel-account-status'), null);
    assert.equal(telegram.querySelector('[aria-haspopup="menu"]'), null);
    assert.match(whatsapp.textContent!, /Finish delivery setup/);
    await act(async () =>
      [...whatsapp.querySelectorAll('button')]
        .find((button) => button.textContent?.startsWith('Finish setup'))!
        .click(),
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.match(dialog.textContent!, /Finish the callback in Meta/);
    assert.match(dialog.textContent!, /fixture\.example\.test\/api\/webhooks\/whatsapp/);
    assert.equal(dialog.querySelectorAll('[role="menuitem"]').length, 0);
    await act(async () =>
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => delay(0));
    assert.equal(document.activeElement?.textContent, 'Finish setup');
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
  }
});

test('cancelling direct channel removal keeps the saved connection without a request', async () => {
  const priorFetch = globalThis.fetch;
  const priorConfirm = window.confirm;
  const writes: string[] = [];
  const confirmations: string[] = [];
  window.confirm = (message) => {
    confirmations.push(message ?? '');
    return false;
  };
  globalThis.fetch = async (input, init) => {
    if (init?.method) writes.push(String(input));
    return Response.json(snapshot(String(input)));
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(Channels)));
    const remove = element.querySelector<HTMLButtonElement>('[data-channel-remove="telegram"]')!;
    await act(async () => {
      remove.focus();
      remove.click();
    });
    assert.deepEqual(writes, []);
    assert.deepEqual(confirmations, [
      'Remove Telegram from Sidekick? You will need its credentials to connect again.',
    ]);
    assert.equal(document.activeElement, remove);
    assert.match(element.textContent!, /Fixture Telegram/);
    assert.equal(element.querySelector('[aria-label="Connect Telegram"]'), null);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
    window.confirm = priorConfirm;
  }
});
