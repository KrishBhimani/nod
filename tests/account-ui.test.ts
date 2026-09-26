import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { AccountControls } from '../src/web/components/account-menu.tsx';
import type { Connection } from '../src/shared/contracts.ts';
import { integrationServiceIds, integrationServices } from '../src/shared/integrations.ts';
import { pageDataCache } from '../src/web/lib/page-data-cache.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310/onboarding',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'NodeFilter',
  'MutationObserver',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const { AccountSettings } = await import('../src/web/components/account-settings.tsx');
const { Onboarding } = await import('../src/web/pages/onboarding.tsx');
const { AccountAvatar } = await import('../src/web/components/account-avatar.tsx');
const user = {
  id: 'alex',
  name: 'Alex Example',
  email: 'alex@example.test',
  avatarUrl: '/api/account/avatar',
};

test('settings uses vertical keyboard tabs and theme previews without checkbox indicators', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const themes: string[] = [];
  const account: AccountControls = {
    user,
    theme: 'system',
    saving: false,
    canLogout: true,
    onSettings() {},
    onTheme: async (theme) => {
      themes.push(theme);
    },
    onLogout() {},
  };
  try {
    await act(async () =>
      root.render(
        createElement(AccountSettings, {
          account,
          open: true,
          initialTab: 'Profile',
          onOpenChange() {},
          onName: async () => {},
          returnFocus: () => null,
        }),
      ),
    );
    const tabs = document.querySelector('[role="tablist"]')!;
    assert.equal(tabs.getAttribute('aria-orientation'), 'vertical');
    assert.equal(document.querySelectorAll('.account-profile-email').length, 1);
    assert.equal(document.querySelectorAll('.account-profile-email input').length, 0);
    const profile = tabs.querySelector<HTMLButtonElement>('[aria-label="Profile"]')!;
    profile.focus();
    await act(async () =>
      profile.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    );
    assert.equal(
      tabs.querySelector('[aria-selected="true"]')?.getAttribute('aria-label'),
      'Appearance',
    );
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Appearance');
    assert.equal(document.querySelectorAll('.account-theme-previews button').length, 3);
    assert.equal(
      document.querySelector(
        '.account-theme-previews input,.account-theme-previews [role="checkbox"],.account-theme-previews .lucide-check',
      ),
      null,
    );
    assert.equal(
      document.querySelector('[aria-label="System theme"]')?.getAttribute('aria-pressed'),
      'true',
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Dark theme"]')!.click(),
    );
    assert.deepEqual(themes, ['dark']);
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      ),
    );
    assert.equal(
      tabs.querySelector('[aria-selected="true"]')?.getAttribute('aria-label'),
      'Profile',
    );
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test('avatars only load server-owned sources and fall back when a Google image fails', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(AccountAvatar, { user })));
    const image = element.querySelector('img')!;
    assert.equal(image.getAttribute('src'), '/api/account/avatar');
    await act(async () => image.dispatchEvent(new Event('error')));
    assert.equal(element.querySelector('img'), null);
    assert.equal(element.textContent, 'AE');
    await act(async () =>
      root.render(
        createElement(AccountAvatar, {
          user: {
            ...user,
            id: 'sam',
            name: 'Sam Example',
            avatarUrl: 'https://untrusted.example/picture',
          },
        }),
      ),
    );
    assert.equal(element.querySelector('img'), null);
    assert.equal(element.textContent, 'SE');
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test('onboarding shows seven concise states and starts consent directly with a fixed return destination', async () => {
  const previous = globalThis.fetch;
  const connections: Connection[] = integrationServiceIds.map((slug) => ({
    slug,
    name: integrationServices[slug].name,
    status: slug === 'gmail' ? 'connected' : 'disconnected',
    triggersEnabled: false,
    ...(slug === 'gmail'
      ? { connectionId: 'fixture-gmail', accountEmail: 'private-mailbox@example.test' }
      : {}),
  }));
  const posts: { path: string; body: unknown }[] = [];
  let resolve!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (path, options) => {
    if (options?.method === 'POST') {
      posts.push({ path: String(path), body: JSON.parse(String(options.body)) });
      signal = options.signal;
      return new Promise((accept) => {
        resolve = accept;
      });
    }
    return Response.json(connections);
  };
  pageDataCache.clear();
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        createElement(Onboarding, {
          user,
          onComplete: async () => {},
          onLogout() {},
          canLogout: true,
        }),
      ),
    );
    assert.equal(element.querySelectorAll('.onboarding-integration').length, 7);
    assert.equal(element.querySelectorAll('.onboarding-integration.connected').length, 1);
    assert.equal(element.textContent?.includes('private-mailbox@example.test'), false);
    assert.equal(element.querySelector('[aria-label*="Add"]'), null);
    await act(async () =>
      element.querySelector<HTMLButtonElement>('[aria-label="Connect Google Calendar"]')!.click(),
    );
    assert.deepEqual(posts, [
      { path: '/api/apps/googlecalendar/connect', body: { returnTo: 'onboarding' } },
    ]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.ok(element.textContent?.includes('Opening…'));
    await act(async () => root.render(null));
    assert.equal(signal?.aborted, true);
    await act(async () => resolve(Response.json({ url: 'https://accounts.example.test/consent' })));
  } finally {
    await act(async () => root.unmount());
    element.remove();
    pageDataCache.clear();
    globalThis.fetch = previous;
  }
});

test('local account settings omit Google email and sign-out controls', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const account: AccountControls = {
    user: { ...user, email: null, avatarUrl: null },
    theme: 'system',
    saving: false,
    canLogout: false,
    onSettings() {},
    onTheme: async () => {},
    onLogout() {},
  };
  try {
    await act(async () =>
      root.render(
        createElement(AccountSettings, {
          account,
          open: true,
          initialTab: 'Profile',
          onOpenChange() {},
          onName: async () => {},
          returnFocus: () => null,
        }),
      ),
    );
    assert.equal(document.querySelector('.account-profile-email'), null);
    assert.equal(document.querySelector('.account-settings [aria-label="Sign out"]'), null);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test('preference drafts survive refresh, save only edited fields and remain retryable after failure', async () => {
  const previous = globalThis.fetch;
  let saved = {
    notificationRule: 'Synthetic preferences',
    timeZone: 'Europe/Lisbon',
    quietHoursEnabled: true,
    quietStart: '22:00',
    quietEnd: '08:00',
  };
  const writes: unknown[] = [];
  globalThis.fetch = async (_path, options) => {
    if (options?.method !== 'PATCH') return Response.json(saved);
    const patch = JSON.parse(String(options.body));
    writes.push(patch);
    if (writes.length === 1)
      return Response.json({ error: 'Preferences could not be saved.' }, { status: 503 });
    saved = { ...saved, ...patch };
    return Response.json(saved);
  };
  pageDataCache.clear();
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const account: AccountControls = {
    user,
    theme: 'system',
    saving: false,
    canLogout: true,
    onSettings() {},
    onTheme: async () => {},
    onLogout() {},
  };
  try {
    await act(async () =>
      root.render(
        createElement(AccountSettings, {
          account,
          open: true,
          initialTab: 'Preferences',
          onOpenChange() {},
          onName: async () => {},
          returnFocus: () => null,
        }),
      ),
    );
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    assert.equal(document.querySelector('input[type="time"]'), null);
    saved = { ...saved, timeZone: 'UTC' };
    await act(async () => pageDataCache.update('/api/preferences', () => saved));
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    assert.equal(document.querySelector('select')?.value, 'UTC');
    const submit = () =>
      document
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await act(async () => {
      submit();
    });
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /could not be saved/);
    assert.equal(toggle.disabled, false);
    await act(async () => {
      submit();
    });
    assert.deepEqual(writes, [{ quietHoursEnabled: false }, { quietHoursEnabled: false }]);
    assert.equal(document.querySelector('.account-settings-actions'), null);
    assert.equal(document.querySelector('[role="alert"]'), null);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    pageDataCache.clear();
    globalThis.fetch = previous;
  }
});
