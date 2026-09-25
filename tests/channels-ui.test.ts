import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';

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
  'NodeFilter',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const { Channels, ChannelAccount } = await import('../src/web/pages/channels.tsx');
const click = (element: Element) =>
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

test('ready Channels show identity and one next action, without repeating setup instructions', async () => {
  const priorFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(options?.method, undefined);
    calls.push(String(url));
    return new Response(
      JSON.stringify(
        String(url) === '/api/channels'
          ? {
              channels: [
                { provider: 'telegram', status: 'configured', missing: [] },
                { provider: 'whatsapp', status: 'disabled', missing: [] },
              ],
              error: null,
            }
          : {
              ready: true,
              channels: [
                {
                  provider: 'telegram',
                  enabled: true,
                  mode: 'polling',
                  accountName: 'FixtureBot',
                  accountHandle: '@FixtureBot',
                },
              ],
            },
      ),
    );
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Channels)));
    assert.deepEqual(calls.sort(), ['/api/channel-settings', '/api/channels']);
    const [whatsapp, telegram] = Array.from(container.querySelectorAll('.channel-option'));
    assert.equal(whatsapp.querySelector('h2')?.textContent, 'WhatsApp');
    assert.equal(telegram.querySelector('.channel-option-benefit'), null);
    assert.equal(telegram.querySelector('.channel-option-heading span'), null);
    assert.equal(telegram.querySelector('.channel-account-label')?.textContent, 'FixtureBot');
    assert.equal(telegram.querySelector('.channel-account-status'), null);
    assert.doesNotMatch(telegram.textContent ?? '', /Ready for messages/);
    assert.doesNotMatch(
      telegram.textContent ?? '',
      /press Start|send a message|Simple local|Connect your own bot/,
    );
    assert.equal(telegram.querySelector('a')?.getAttribute('href'), 'https://t.me/FixtureBot');
    assert.equal(telegram.querySelector('[role="menu"]'), null);
    assert.match(
      whatsapp.querySelector('.channel-option-benefit')?.textContent ?? '',
      /WhatsApp Business number/,
    );
    assert.ok(whatsapp.querySelector('[aria-label="Connect WhatsApp"]'));
    assert.equal(container.querySelector('.button-primary'), null);
    assert.equal(container.querySelector('select'), null);
    const manage = telegram.querySelector('[aria-label="Manage channel"]')!;
    assert.equal(manage.getAttribute('aria-expanded'), 'false');
    await act(async () => click(manage));
    assert.equal(manage.getAttribute('aria-expanded'), 'true');
    const menu = telegram.querySelector('[role="menu"]')!;
    assert.match(menu.textContent ?? '', /Replace setup.*Disconnect/);
    await act(async () =>
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    assert.equal(manage.getAttribute('aria-expanded'), 'false');
    assert.equal(telegram.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, manage);
    assert.equal(calls.length, 2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = priorFetch;
  }
});

test('incomplete webhook setup reveals saved instructions without reconnecting or sending', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let configured = 0;
  let disconnected = 0;
  try {
    await act(async () =>
      root.render(
        createElement(ChannelAccount, {
          setup: {
            provider: 'whatsapp',
            enabled: true,
            mode: 'webhook',
            webhookStatus: 'manual_setup',
            accountName: 'Fixture business',
            accountHandle: '@not-a-telegram-bot',
            webhookUrl: 'https://example.com/api/webhooks/whatsapp',
          },
          configured: true,
          busy: false,
          onConfigure: () => {
            configured++;
          },
          onDisconnect: () => {
            disconnected++;
          },
        }),
      ),
    );
    const manage = container.querySelector('[aria-label="Manage channel"]')!;
    assert.equal(manage.getAttribute('aria-expanded'), 'false');
    assert.equal(container.querySelector('[role="menu"]'), null);
    assert.equal(container.querySelector('a'), null);
    assert.match(
      container.querySelector('.channel-account-status')?.textContent ?? '',
      /Finish delivery setup/,
    );
    const finish = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Finish setup'),
    )!;
    await act(async () => click(finish));
    assert.equal(manage.getAttribute('aria-expanded'), 'true');
    const menu = container.querySelector('[role="menu"]')!;
    assert.equal(document.activeElement, menu.querySelector('[role="menuitem"]'));
    assert.equal(
      menu.querySelector('code')?.textContent,
      'https://example.com/api/webhooks/whatsapp',
    );
    assert.equal(configured, 0);
    assert.equal(disconnected, 0);
    await act(async () => click(menu.querySelector('[role="menuitem"]')!));
    assert.equal(configured, 1);
    assert.equal(disconnected, 0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('pending Telegram registration offers saved recovery instructions without Meta guidance', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(ChannelAccount, {
          setup: {
            provider: 'telegram',
            enabled: true,
            mode: 'webhook',
            webhookStatus: 'registration_pending',
            accountHandle: '@fixture_bot',
          },
          configured: true,
          busy: false,
          onConfigure: () => assert.fail('No settings should change'),
          onDisconnect: () => assert.fail('No settings should change'),
        }),
      ),
    );
    assert.match(container.textContent ?? '', /Setup needs a retry/);
    assert.equal(container.querySelector('a'), null);
    const finish = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Finish setup'),
    )!;
    await act(async () => click(finish));
    const menu = container.querySelector('[role="menu"]')!;
    assert.match(menu.textContent ?? '', /Restart Sidekick to retry the saved setup/);
    assert.doesNotMatch(menu.textContent ?? '', /Meta|verification token/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
