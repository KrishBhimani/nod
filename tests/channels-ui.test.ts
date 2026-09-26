import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
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
  'HTMLButtonElement',
  'HTMLInputElement',
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

test('ready Channels offer a bot conversation and direct removal without setup menus', async () => {
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
    assert.equal(container.querySelector('.button-primary'), telegram.querySelector('a'));
    assert.equal(container.querySelector('select'), null);
    assert.equal(telegram.querySelector('a')?.textContent, 'Start conversation');
    assert.doesNotMatch(
      container.textContent ?? '',
      /Requires a Meta business app|Manage|Replace setup/,
    );
    const remove = telegram.querySelector<HTMLButtonElement>('[data-channel-remove="telegram"]')!;
    assert.equal(remove.textContent, 'Remove channel');
    assert.equal(remove.disabled, false);
    assert.equal(telegram.querySelector('[aria-haspopup="menu"]'), null);
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
  let disconnected = 0;
  try {
    await act(async () =>
      root.render(
        createElement(ChannelAccount, {
          provider: 'whatsapp',
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
          onDisconnect: () => {
            disconnected++;
          },
        }),
      ),
    );
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
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.equal(dialog.querySelector('h2')?.textContent, 'Finish WhatsApp setup');
    assert.equal(
      dialog.querySelector('code')?.textContent,
      'https://example.com/api/webhooks/whatsapp',
    );
    assert.match(dialog.textContent ?? '', /verification token you saved/);
    assert.doesNotMatch(dialog.textContent ?? '', /Replace setup/);
    assert.equal(disconnected, 0);
    await act(async () => click(dialog.querySelector('[aria-label="Close"]')!));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => delay(0));
    assert.equal(document.activeElement, finish);
    await act(async () => click(container.querySelector('[data-channel-remove="whatsapp"]')!));
    assert.equal(disconnected, 1);
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
          provider: 'telegram',
          setup: {
            provider: 'telegram',
            enabled: true,
            mode: 'webhook',
            webhookStatus: 'registration_pending',
            accountHandle: '@fixture_bot',
          },
          configured: true,
          busy: false,
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
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent ?? '', /Restart Sidekick to retry the saved setup/);
    assert.doesNotMatch(dialog.textContent ?? '', /Meta|verification token|replace/i);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
