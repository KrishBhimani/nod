import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { VaultCardEntry, VaultLoginDetails } from '../src/shared/contracts.ts';
import { pageDataCache } from '../src/web/lib/page-data-cache.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310/vault',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'NodeFilter',
  'MutationObserver',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'FormData',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const { Vault } = await import('../src/web/pages/vault.tsx');

const savedLogins: VaultLoginDetails[] = [
  {
    kind: 'login',
    username: 'personal-fixture@example.test',
    id: 'personal/login',
    label: 'Personal account',
    origin: 'https://accounts.example.test:8443',
    usernameHint: 'pe…',
    updatedAt: '2026-09-25T12:00:00.000Z',
  },
  {
    kind: 'login',
    username: 'work-fixture@example.test',
    id: 'work login',
    label: 'Work account',
    origin: 'https://accounts.example.test:8443',
    usernameHint: 'wo…',
    updatedAt: '2026-09-25T12:00:00.000Z',
  },
];
const usernames = ['personal-fixture@example.test', 'work-fixture@example.test'];
const syntheticPassword = 'synthetic-vault-password-only';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function click(label: string, scope: ParentNode = document) {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (value) => value.getAttribute('aria-label') === label || value.textContent?.trim() === label,
  );
  assert.ok(button, `Missing button: ${label}`);
  assert.equal(button.disabled, false);
  await act(async () => button.click());
  return button;
}

async function mountVault() {
  pageDataCache.update('/api/vault', () => null);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Vault)));
  return {
    root,
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
      pageDataCache.update('/api/vault', () => null);
    },
  };
}

function mockVaultRequests(
  respond?: (path: string, options: RequestInit) => Promise<Response> | undefined,
) {
  const requests: Array<{ path: string; options: RequestInit }> = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    if (path === '/api/vault') return respond?.(path, options) ?? Response.json(savedLogins);
    assert.ok(options.method === 'POST' || options.method === 'PATCH');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal);
    const result = respond?.(path, options);
    if (result) return result;
    const index = savedLogins.findIndex((entry) => path.includes(encodeURIComponent(entry.id)));
    assert.notEqual(index, -1);
    if (path.endsWith('/details'))
      return Response.json({ ...savedLogins[index], username: usernames[index] });
    assert.equal(path, `/api/vault/${encodeURIComponent(savedLogins[index].id)}/password`);
    return Response.json({ password: syntheticPassword });
  };
  return requests;
}

function setClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

test('Vault accepts named bare-domain logins and retains separate accounts for the same website', async () => {
  const previousFetch = globalThis.fetch;
  const entries: VaultLoginDetails[] = [];
  const writes: Array<{ label: string; origin: string; username: string; password: string }> = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), '/api/vault');
    if (options?.method !== 'POST') return Response.json(entries);
    const input = JSON.parse(String(options.body));
    writes.push(input);
    const entry: VaultLoginDetails = {
      kind: 'login',
      username: input.username,
      id: `saved-${writes.length}`,
      label: input.label,
      origin: 'https://example.com',
      usernameHint: 'fi…',
      updatedAt: new Date().toISOString(),
    };
    entries.unshift(entry);
    return Response.json(entry);
  };
  pageDataCache.update('/api/vault', () => null);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Vault)));
    for (const label of ['Personal account', 'Work account']) {
      const trigger = [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Add item'),
      )!;
      await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await click('Login');
      const dialog = document.querySelector('[role="dialog"]')!;
      const form = dialog.querySelector('form')!;
      const name = form.querySelector<HTMLInputElement>('input[name="label"]')!;
      const website = form.querySelector<HTMLInputElement>('input[name="origin"]')!;
      const username = form.querySelector<HTMLInputElement>('input[name="username"]')!;
      const password = form.querySelector<HTMLInputElement>('input[name="password"]')!;
      assert.equal(name.maxLength, 100);
      assert.equal(name.required, true);
      assert.match(name.labels![0].textContent ?? '', /Item name/);
      assert.match(website.labels![0].textContent ?? '', /Website domain/);
      name.value = label;
      website.value = 'example.com';
      username.value = `fixture-${writes.length}@example.test`;
      password.value = 'synthetic-only-password';
      assert.equal(form.checkValidity(), true);
      await act(async () =>
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      assert.equal(document.querySelector('[role="dialog"]'), null);
    }
    assert.deepEqual(
      writes.map(({ label, origin }) => ({ label, origin })),
      [
        { label: 'Personal account', origin: 'example.com' },
        { label: 'Work account', origin: 'example.com' },
      ],
    );
    await act(async () => root.render(null));
    pageDataCache.update('/api/vault', () => null);
    await act(async () => root.render(createElement(Vault)));
    const rows = [...container.querySelectorAll('.resource-row')];
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.querySelector('h2')?.textContent),
      ['Work account', 'Personal account'],
    );
    for (const row of rows) assert.match(row.textContent ?? '', /example\.com/);
    assert.equal(container.querySelector('[aria-label^="Delete"]'), null);
    assert.match(container.textContent ?? '', /fixture-0@example/);
    assert.match(container.textContent ?? '', /fixture-1@example/);
    assert.doesNotMatch(container.textContent ?? '', /synthetic-only-password/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/vault', () => null);
    globalThis.fetch = previousFetch;
  }
});

test('Vault details preserve exact values and only read passwords after explicit reveal or copy', async () => {
  const previousFetch = globalThis.fetch;
  const requests = mockVaultRequests();
  const clipboard: string[] = [];
  setClipboard(async (value) => {
    clipboard.push(value);
  });
  const mounted = await mountVault();
  try {
    assert.equal(requests.length, 1);
    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="View Personal account"]',
    )!;
    assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
    assert.ok(trigger.closest('h2'));
    assert.equal(trigger.querySelector('button'), null);
    assert.equal(
      trigger.contains(mounted.container.querySelector('[aria-label="Delete Personal account"]')),
      false,
    );
    trigger.focus();
    await click('View Personal account');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!)!;
    assert.equal(title.textContent, savedLogins[0].label);
    assert.equal(document.activeElement, title);
    assert.ok(document.getElementById(dialog.getAttribute('aria-describedby')!));
    assert.match(dialog.textContent ?? '', /https:\/\/accounts\.example\.test:8443/);
    assert.equal(dialog.querySelector<HTMLInputElement>('[name="username"]')?.value, usernames[0]);
    assert.equal(requests.filter(({ path }) => path.endsWith('/password')).length, 0);
    assert.equal(requests[1].path, '/api/vault/personal%2Flogin/details');
    assert.ok(dialog.querySelector('[aria-label="Password hidden"]'));
    await click('Copy username');
    assert.deepEqual(clipboard, [usernames[0]]);
    assert.match(dialog.textContent ?? '', /Username copied/);
    await click('Show password');
    assert.equal(dialog.querySelector('.vault-password-visible')?.textContent, syntheticPassword);
    assert.equal(requests.at(-1)?.path, '/api/vault/personal%2Flogin/password');
    assert.equal(
      dialog.querySelector('[aria-label="Hide password"]')?.getAttribute('aria-pressed'),
      'true',
    );
    await click('Hide password');
    assert.equal(dialog.textContent?.includes(syntheticPassword), false);
    await click('Show password');
    assert.equal(requests.filter(({ path }) => path.endsWith('/password')).length, 2);
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, trigger);
    await click('View Personal account');
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    assert.equal(requests.filter(({ path }) => path.endsWith('/details')).length, 2);
    assert.equal(requests.filter(({ path }) => path.endsWith('/password')).length, 2);
    await act(async () => mounted.root.render(null));
    await act(async () => mounted.root.render(createElement(Vault)));
    await click('View Work account');
    assert.ok(document.body.textContent?.includes(usernames[1]));
    assert.equal(
      document.querySelector('[role="dialog"]')?.textContent?.includes(usernames[0]),
      false,
    );
    assert.equal(requests.at(-1)?.path, '/api/vault/work%20login/details');
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    const cached = JSON.stringify(pageDataCache.getSnapshot('/api/vault'));
    assert.equal(cached.includes(usernames[0]), true);
    assert.equal(cached.includes(syntheticPassword), false);
    assert.equal(dom.window.localStorage.length, 0);
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Copy password stays masked and clipboard errors clear revealed values without exposing errors', async () => {
  const previousFetch = globalThis.fetch;
  const requests = mockVaultRequests();
  const clipboard: string[] = [];
  setClipboard(async (value) => {
    clipboard.push(value);
  });
  const mounted = await mountVault();
  try {
    await click('View Work account');
    await click('Copy password');
    assert.deepEqual(clipboard, [syntheticPassword]);
    assert.equal(requests.at(-1)?.path, '/api/vault/work%20login/password');
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    assert.match(document.body.textContent ?? '', /Password copied/);
    await click('Show password');
    assert.equal(requests.filter(({ path }) => path.endsWith('/password')).length, 2);
    setClipboard(async () => {
      throw new Error(`private clipboard failure ${syntheticPassword}`);
    });
    await click('Copy password');
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    assert.equal(document.body.textContent?.includes('private clipboard failure'), false);
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      'Could not copy to the clipboard. Try again.',
    );
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
    assert.equal(document.body.textContent?.includes('Password copied.'), false);
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Closing or replacing Vault details aborts reads and ignores late details and password responses', async () => {
  const previousFetch = globalThis.fetch;
  const details = deferred<Response>();
  const password = deferred<Response>();
  const requests = mockVaultRequests((path) => {
    if (path === '/api/vault/personal%2Flogin/details') return details.promise;
    if (path.endsWith('/password')) return password.promise;
  });
  const clipboard: string[] = [];
  setClipboard(async (value) => {
    clipboard.push(value);
  });
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    const first = requests.at(-1)!;
    await click('Close');
    assert.equal(first.options.signal?.aborted, true);
    await click('View Work account');
    await act(async () =>
      details.resolve(Response.json({ ...savedLogins[0], username: usernames[0] })),
    );
    assert.ok(document.body.textContent?.includes(usernames[1]));
    assert.equal(
      document.querySelector('[role="dialog"]')?.textContent?.includes(usernames[0]),
      false,
    );
    await click('Copy password');
    const copying = requests.at(-1)!;
    await click('Close');
    assert.equal(copying.options.signal?.aborted, true);
    await click('View Work account');
    await act(async () => password.resolve(Response.json({ password: syntheticPassword })));
    assert.deepEqual(clipboard, []);
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    assert.equal(document.body.textContent?.includes('Password copied.'), false);
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault clears revealed passwords and fences pending reads when the window or tab is hidden', async () => {
  const previousFetch = globalThis.fetch;
  const latePassword = deferred<Response>();
  let holdPassword = false;
  const requests = mockVaultRequests((path) =>
    holdPassword && path.endsWith('/password') ? latePassword.promise : undefined,
  );
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    await click('Show password');
    assert.ok(document.body.textContent?.includes(syntheticPassword));
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    holdPassword = true;
    await click('Show password');
    const pending = requests.at(-1)!;
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(pending.options.signal?.aborted, true);
    await act(async () => latePassword.resolve(Response.json({ password: syntheticPassword })));
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    holdPassword = false;
    await click('Show password');
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
  } finally {
    Reflect.deleteProperty(document, 'hidden');
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault navigation aborts pending secrets and late clipboard completion does not update a new dialog', async () => {
  const previousFetch = globalThis.fetch;
  const latePassword = deferred<Response>();
  let holdPassword = true;
  const requests = mockVaultRequests((path) =>
    holdPassword && path.endsWith('/password') ? latePassword.promise : undefined,
  );
  const copied = deferred<void>();
  setClipboard(() => copied.promise);
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    await click('Show password');
    const pending = requests.at(-1)!;
    await act(async () => mounted.root.render(null));
    assert.equal(pending.options.signal?.aborted, true);
    await act(async () => mounted.root.render(createElement(Vault)));
    await click('View Work account');
    await act(async () => latePassword.resolve(Response.json({ password: syntheticPassword })));
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    holdPassword = false;
    await click('Copy password');
    await click('Close');
    await click('View Personal account');
    await act(async () => copied.resolve());
    assert.equal(document.body.textContent?.includes('Password copied.'), false);
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    assert.equal(
      document.querySelector<HTMLButtonElement>('[aria-label="Show password"]')?.disabled,
      false,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault detail failures use fixed errors, support retry, and do not read passwords eagerly', async () => {
  const previousFetch = globalThis.fetch;
  let failDetails = true;
  const requests = mockVaultRequests((path) => {
    if ((failDetails && path.endsWith('/details')) || path.endsWith('/password'))
      return Promise.resolve(
        Response.json({ error: `private server error ${syntheticPassword}` }, { status: 500 }),
      );
  });
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      'This login could not be opened. Try again.',
    );
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    assert.equal(document.querySelector('[aria-label="Show password"]'), null);
    assert.equal(
      requests.some(({ path }) => path.endsWith('/password')),
      false,
    );
    failDetails = false;
    await click('Try again');
    assert.ok(document.body.textContent?.includes(usernames[0]));
    await click('Show password');
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      'The password could not be shown. Try again.',
    );
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault edits a named account and updates the private list without reading its password', async () => {
  const previousFetch = globalThis.fetch;
  const entries = savedLogins.map((entry) => ({ ...entry }));
  const writes: Record<string, unknown>[] = [];
  const requests = mockVaultRequests((path, options) => {
    if (path === '/api/vault') return Promise.resolve(Response.json(entries));
    if (options.method === 'PATCH') {
      assert.equal(path, '/api/vault/personal%2Flogin');
      const input = JSON.parse(String(options.body));
      writes.push(input);
      entries[0] = {
        ...entries[0],
        label: input.label,
        username: input.username,
        usernameHint: 'ne…',
        updatedAt: '2026-09-25T13:00:00.000Z',
      };
      return Promise.resolve(Response.json(entries[0]));
    }
  });
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    const form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    const name = form.querySelector<HTMLInputElement>('[name="label"]')!;
    const username = form.querySelector<HTMLInputElement>('[name="username"]')!;
    assert.equal(document.activeElement?.textContent, savedLogins[0].label);
    assert.equal(name.value, 'Personal account');
    assert.equal(username.value, usernames[0]);
    assert.equal(form.querySelector('[name="password"]'), null);
    assert.ok(form.querySelector('[aria-label="Password hidden"]'));
    await click('Change password', form);
    const password = form.querySelector<HTMLInputElement>('[name="password"]')!;
    assert.equal(password.required, true);
    assert.equal(password.value, '');
    assert.equal(document.activeElement, password);
    assert.equal(form.checkValidity(), false);
    password.value = 'cancelled-replacement';
    await click('Cancel change', form);
    assert.equal(password.value, '');
    assert.equal(form.querySelector('[name="password"]'), null);
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Change password');
    assert.equal(form.querySelector('[name="origin"]'), null);
    assert.match(
      document.querySelector('[role="dialog"]')?.textContent ?? '',
      /https:\/\/accounts\.example\.test:8443/,
    );
    name.value = 'Everyday account';
    username.value = 'new-private-username@example.test';
    await act(async () =>
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    assert.deepEqual(writes, [
      { label: 'Everyday account', username: 'new-private-username@example.test' },
    ]);
    assert.equal(
      requests.some((request) => request.path.endsWith('/password')),
      false,
    );
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /Login updated/);
    assert.equal(document.activeElement?.textContent?.trim(), 'Everyday account');
    assert.ok(mounted.container.querySelector('[aria-label="View Everyday account"]'));
    assert.ok(mounted.container.querySelector('[aria-label="View Work account"]'));
    assert.match(
      mounted.container.querySelector('.vault-entry-meta')?.textContent ?? '',
      /accounts\.example\.test:8443/,
    );
    const cached = JSON.stringify(pageDataCache.getSnapshot('/api/vault'));
    assert.match(cached, /Everyday account/);
    assert.match(cached, /new-private-username/);
    assert.doesNotMatch(cached, /synthetic-vault-password/);
    assert.equal(dom.window.localStorage.length, 0);
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault uses the saved website identifier label in details and edits without reading secrets', async () => {
  const previousFetch = globalThis.fetch;
  const label = 'Member number';
  const requests = mockVaultRequests((path) =>
    path.endsWith('/details')
      ? Promise.resolve(Response.json({ ...savedLogins[0], identifierLabel: label }))
      : undefined,
  );
  const copied: string[] = [];
  setClipboard(async (value) => {
    copied.push(value);
  });
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.deepEqual(
      [...dialog.querySelectorAll('dt')].map((value) => value.textContent),
      ['Website'],
    );
    const status = dialog.querySelector('[role="status"]')!;
    assert.equal(status.className, 'sr-only');
    await click('Copy member number');
    assert.deepEqual(copied, [usernames[0]]);
    assert.equal(status.textContent, 'Member number copied.');
    assert.equal(status.className, 'vault-detail-status');
    assert.equal(status.nextElementSibling?.className, 'vault-detail-footer');
    const input = dialog.querySelector<HTMLInputElement>('[name="username"]')!;
    assert.equal(input.labels![0].textContent, label);
    assert.equal(input.value, usernames[0]);
    await click('Done');
    assert.equal(
      requests.some(({ path }) => path.endsWith('/password')),
      false,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault edit cancel, blur and failed submission discard replacement passwords', async () => {
  const previousFetch = globalThis.fetch;
  const writes: Record<string, unknown>[] = [];
  const requests = mockVaultRequests((_path, options) => {
    if (options.method === 'PATCH') {
      writes.push(JSON.parse(String(options.body)));
      return Promise.resolve(
        Response.json({ error: 'private-new-password-error' }, { status: 500 }),
      );
    }
  });
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    await click('Show password');
    let form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    await click('Change password', form);
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    form.querySelector<HTMLInputElement>('[name="password"]')!.value = 'cancelled-secret';
    await click('Cancel changes');
    assert.equal(writes.length, 0);
    assert.ok(document.querySelector('.vault-edit-form'));
    form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    assert.equal(form.querySelector('[name="password"]'), null);
    await click('Change password', form);
    const password = form.querySelector<HTMLInputElement>('[name="password"]')!;
    assert.equal(password.value, '');
    password.value = 'blurred-secret';
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(password.value, '');
    password.value = 'replacement-secret';
    await act(async () =>
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    assert.equal(writes[0].password, 'replacement-secret');
    assert.equal(password.value, '');
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      'This login could not be updated. Try again.',
    );
    assert.doesNotMatch(
      document.body.textContent ?? '',
      /replacement-secret|private-new-password-error/,
    );
    assert.equal(requests.filter((request) => request.path.endsWith('/password')).length, 1);
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /replacement-secret|private-new-password-error/,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Closing a pending Vault edit aborts its request and fences a late save from the next account', async () => {
  const previousFetch = globalThis.fetch;
  const pending = deferred<Response>();
  const requests = mockVaultRequests((_path, options) =>
    options.method === 'PATCH' ? pending.promise : undefined,
  );
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    const form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    form.querySelector<HTMLInputElement>('[name="label"]')!.value = 'Late account';
    await click('Change password', form);
    const password = form.querySelector<HTMLInputElement>('[name="password"]')!;
    password.value = 'pending-secret';
    await act(async () =>
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    const request = requests.at(-1)!;
    assert.equal(password.value, '');
    await click('Close');
    assert.equal(request.options.signal?.aborted, true);
    await click('View Work account');
    await act(async () =>
      pending.resolve(Response.json({ ...savedLogins[0], label: 'Late account' })),
    );
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /Work account/);
    assert.doesNotMatch(
      document.body.textContent ?? '',
      /Late account|pending-secret|Login updated/,
    );
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /Late account|pending-secret/,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

const savedCard: VaultCardEntry = {
  kind: 'card',
  id: 'card/private',
  label: 'Everyday card',
  brand: 'Visa',
  last4: '4242',
  expiryMonth: 4,
  expiryYear: 2032,
  updatedAt: '2026-09-25T12:00:00.000Z',
};
const syntheticCardNumber = '4242424242424242';
const syntheticCardholder = 'Synthetic Cardholder';

function mockCardRequests(
  respond?: (path: string, options: RequestInit) => Promise<Response> | undefined,
) {
  const requests: Array<{ path: string; options: RequestInit }> = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    const response = respond?.(path, options);
    if (response) return response;
    if (path === '/api/vault') return Response.json([savedCard, ...savedLogins]);
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal);
    if (path === '/api/vault/card%2Fprivate/details')
      return Response.json({
        ...savedCard,
        cardholder: syntheticCardholder,
        hasSecurityCode: false,
      });
    if (path === '/api/vault/card%2Fprivate/card-number') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(String(options.body)), {});
      return Response.json({ cardNumber: syntheticCardNumber });
    }
    const login = savedLogins.find((entry) => path.includes(encodeURIComponent(entry.id)));
    if (login && path.endsWith('/details')) return Response.json(login);
    assert.fail(`Unexpected fixture request: ${path}`);
  };
  return requests;
}

async function submit(form: HTMLFormElement) {
  await act(async () =>
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}

async function inputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test('Vault opens editable and only offers Save changes for an actual edit', async () => {
  const previousFetch = globalThis.fetch;
  const requests = mockVaultRequests();
  const copied: string[] = [];
  setClipboard(async (value) => {
    copied.push(value);
  });
  const mounted = await mountVault();
  const saveButton = () =>
    [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save changes',
    );
  try {
    await click('View Personal account');
    let form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    const name = form.querySelector<HTMLInputElement>('[name="label"]')!;
    const username = form.querySelector<HTMLInputElement>('[name="username"]')!;
    assert.equal(name.disabled, false);
    assert.equal(username.disabled, false);
    assert.doesNotMatch(document.querySelector('[role="dialog"]')?.textContent ?? '', /Edit login/);
    assert.equal(saveButton(), undefined);
    await inputValue(name, 'Changed account');
    assert.ok(saveButton());
    await inputValue(name, savedLogins[0].label);
    assert.equal(saveButton(), undefined);
    await inputValue(username, 'edited-identifier@example.test');
    await click('Copy username');
    assert.deepEqual(copied, ['edited-identifier@example.test']);
    await click('Change password');
    const password = form.querySelector<HTMLInputElement>('[name="password"]')!;
    await inputValue(password, 'cancelled-secret');
    await click('Cancel changes');
    form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    assert.equal(password.value, '');
    assert.equal(form.querySelector<HTMLInputElement>('[name="username"]')?.value, usernames[0]);
    assert.equal(form.querySelector('[name="password"]'), null);
    assert.equal(saveButton(), undefined);
    assert.equal(document.activeElement?.textContent, savedLogins[0].label);
    assert.equal(requests.filter(({ options }) => options.method === 'PATCH').length, 0);
    assert.equal(requests.filter(({ path }) => path.endsWith('/password')).length, 0);
    await click('Done');
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Card security code can be added, revealed, replaced or removed without entering list metadata', async () => {
  const previousFetch = globalThis.fetch;
  let code = '';
  const writes: Record<string, unknown>[] = [];
  const requests = mockCardRequests((path, options) => {
    if (path.endsWith('/details'))
      return Promise.resolve(
        Response.json({ ...savedCard, cardholder: syntheticCardholder, hasSecurityCode: !!code }),
      );
    if (path.endsWith('/security-code'))
      return Promise.resolve(Response.json({ securityCode: code }));
    if (options.method === 'PATCH') {
      const input = JSON.parse(String(options.body));
      writes.push(input);
      if ('securityCode' in input) code = input.securityCode ?? '';
      return Promise.resolve(Response.json({ ...savedCard, label: input.label }));
    }
  });
  const copied: string[] = [];
  setClipboard(async (value) => {
    copied.push(value);
  });
  const mounted = await mountVault();
  try {
    await click('View Everyday card');
    assert.equal(document.querySelector('[aria-label="Show security code"]'), null);
    assert.equal(requests.filter(({ path }) => path.endsWith('/security-code')).length, 0);
    await click('Add security code');
    let form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    let field = form.querySelector<HTMLInputElement>('[name="securityCode"]')!;
    assert.equal(field.type, 'password');
    assert.equal(field.required, true);
    assert.equal(document.activeElement, field);
    for (const invalid of ['', '12', 'ab3', '12345']) {
      await inputValue(field, invalid);
      assert.equal(form.checkValidity(), false);
      await submit(form);
      assert.equal(writes.length, 0);
    }
    await inputValue(field, '734');
    await submit(form);
    assert.equal(writes[0].securityCode, '734');
    assert.equal(field.value, '');
    assert.ok(document.querySelector('[aria-label="Security code hidden"]'));
    assert.equal(requests.filter(({ path }) => path.endsWith('/security-code')).length, 0);
    await click('Copy security code');
    assert.deepEqual(copied, ['734']);
    assert.ok(document.querySelector('[aria-label="Security code hidden"]'));
    assert.equal(document.querySelector('.vault-password-visible'), null);
    const request = requests.at(-1)!;
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.cache, 'no-store');
    assert.ok(request.options.signal);
    assert.deepEqual(JSON.parse(String(request.options.body)), {});
    await click('Show security code');
    assert.equal(document.querySelector('.vault-password-visible')?.textContent, '734');
    await click('Change security code');
    assert.equal(document.querySelector('.vault-password-visible'), null);
    form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    field = form.querySelector<HTMLInputElement>('[name="securityCode"]')!;
    await inputValue(field, '9876');
    await click('Cancel change', field.closest('.vault-secret-field')!);
    assert.equal(field.value, '');
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Change security code');
    assert.equal(writes.length, 1);
    await inputValue(form.querySelector<HTMLInputElement>('[name="label"]')!, 'Updated card');
    await submit(form);
    assert.equal('securityCode' in writes[1], false);
    assert.equal(code, '734');
    await click('Change security code');
    form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    field = form.querySelector<HTMLInputElement>('[name="securityCode"]')!;
    await inputValue(field, '9876');
    await submit(form);
    assert.equal(writes[2].securityCode, '9876');
    assert.equal(field.value, '');
    await click('Remove security code');
    assert.equal(document.activeElement?.textContent, 'Cancel removal');
    await click('Cancel removal');
    assert.ok(document.querySelector('[aria-label="Security code hidden"]'));
    assert.equal(writes.length, 3);
    await click('Remove security code');
    form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    await submit(form);
    assert.equal(writes[3].securityCode, null);
    assert.equal(document.querySelector('[aria-label="Show security code"]'), null);
    assert.ok(document.querySelector('[aria-label="Add security code"]'));
    assert.equal(requests.filter(({ path }) => path.endsWith('/card-number')).length, 0);
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /734|9876|securityCode|hasSecurityCode/,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Card security code reads and replacement inputs are cleared and fenced across hiding and closing', async () => {
  const previousFetch = globalThis.fetch;
  const lateShow = deferred<Response>();
  const lateCopy = deferred<Response>();
  let held: Promise<Response> | undefined;
  const requests = mockCardRequests((path, options) => {
    if (path === '/api/vault/card%2Fprivate/details')
      return Promise.resolve(
        Response.json({ ...savedCard, cardholder: syntheticCardholder, hasSecurityCode: true }),
      );
    if (path.endsWith('/security-code'))
      return held ?? Promise.resolve(Response.json({ securityCode: '681' }));
    if (options.method === 'PATCH')
      return Promise.resolve(Response.json({ error: 'private-code-681' }, { status: 500 }));
  });
  const copied: string[] = [];
  setClipboard(async (value) => {
    copied.push(value);
  });
  const mounted = await mountVault();
  try {
    await click('View Everyday card');
    await click('Show security code');
    assert.equal(document.querySelector('.vault-password-visible')?.textContent, '681');
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(document.querySelector('.vault-password-visible'), null);
    held = lateShow.promise;
    await click('Show security code');
    const showing = requests.at(-1)!;
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(showing.options.signal?.aborted, true);
    await act(async () => lateShow.resolve(Response.json({ securityCode: '681' })));
    assert.equal(document.querySelector('.vault-password-visible'), null);
    held = undefined;
    await click('Change security code');
    const form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    const input = form.querySelector<HTMLInputElement>('[name="securityCode"]')!;
    await inputValue(input, '732');
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(input.value, '');
    await inputValue(input, '732');
    await submit(form);
    assert.equal(input.value, '');
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      'This card could not be updated. Try again.',
    );
    assert.doesNotMatch(document.body.textContent ?? '', /private-code-681/);
    await click('Cancel changes');
    held = lateCopy.promise;
    await click('Copy security code');
    const copying = requests.at(-1)!;
    await click('Close');
    assert.equal(copying.options.signal?.aborted, true);
    await click('View Personal account');
    await act(async () => lateCopy.resolve(Response.json({ securityCode: '681' })));
    assert.deepEqual(copied, []);
    assert.equal(document.querySelector('.vault-password-visible'), null);
    assert.doesNotMatch(document.body.textContent ?? '', /681|732|Security code copied/);
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /681|732|securityCode|hasSecurityCode/,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Add item supports an optional security code and returns only card metadata to the list', async () => {
  const previousFetch = globalThis.fetch;
  let added = false;
  const writes: Record<string, unknown>[] = [];
  mockCardRequests((path, options) => {
    if (path !== '/api/vault') return;
    if (options.method === 'POST') {
      writes.push(JSON.parse(String(options.body)));
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal);
      added = true;
      return Promise.resolve(Response.json(savedCard));
    }
    return Promise.resolve(Response.json(added ? [savedCard] : []));
  });
  const mounted = await mountVault();
  try {
    const trigger = await click('Add item');
    assert.equal(document.querySelector('form'), null);
    await click('Payment card');
    const form = document.querySelector<HTMLFormElement>('.vault-add-form')!;
    const code = form.querySelector<HTMLInputElement>('[name="securityCode"]')!;
    assert.equal(code.required, false);
    assert.equal(code.type, 'password');
    assert.equal(code.maxLength, 4);
    assert.equal(form.querySelector('[name="password"]'), null);
    assert.equal(form.querySelector('[name="origin"]'), null);
    assert.equal(document.activeElement, form.elements.namedItem('label'));
    (form.elements.namedItem('label') as HTMLInputElement).value = savedCard.label;
    (form.elements.namedItem('cardholder') as HTMLInputElement).value = syntheticCardholder;
    const number = form.elements.namedItem('cardNumber') as HTMLInputElement;
    number.value = syntheticCardNumber;
    const expiry = form.elements.namedItem('expiry') as HTMLInputElement;
    expiry.value = '13/2032';
    await submit(form);
    assert.equal(writes.length, 0);
    assert.equal(document.activeElement, expiry);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /MM \/ YYYY/);
    expiry.value = '04 / 32';
    code.value = '734';
    await submit(form);
    assert.deepEqual(writes, [
      {
        kind: 'card',
        label: savedCard.label,
        cardholder: syntheticCardholder,
        cardNumber: syntheticCardNumber,
        securityCode: '734',
        expiryMonth: 4,
        expiryYear: 2032,
      },
    ]);
    assert.equal(number.value, '');
    assert.equal(code.value, '');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(document.activeElement, trigger);
    const row = mounted.container.querySelector('.vault-row')!;
    assert.match(row.textContent ?? '', /Everyday card/);
    assert.match(row.textContent ?? '', /Visa · •••• 4242/);
    assert.match(row.textContent ?? '', /04 \/ 2032/);
    assert.doesNotMatch(row.textContent ?? '', /Synthetic Cardholder|4242424242424242/);
    assert.equal(row.querySelectorAll('button').length, 1);
    assert.equal(row.querySelector('[aria-label^="Delete"]'), null);
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /4242424242424242|Synthetic Cardholder/,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Card details reveal and copy only on demand and clear a late number after window hiding', async () => {
  const previousFetch = globalThis.fetch;
  const late = deferred<Response>();
  let delay = false;
  const requests = mockCardRequests((path) =>
    delay && path.endsWith('/card-number') ? late.promise : undefined,
  );
  const copied: string[] = [];
  setClipboard(async (value) => {
    copied.push(value);
  });
  const mounted = await mountVault();
  try {
    await click('View Everyday card');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(
      dialog.querySelector<HTMLInputElement>('[name="cardholder"]')?.value,
      syntheticCardholder,
    );
    assert.equal(dialog.querySelector<HTMLInputElement>('[name="expiry"]')?.value, '04 / 2032');
    assert.equal(
      requests.some(({ path }) => path.endsWith('/card-number')),
      false,
    );
    assert.equal(dialog.querySelector('[aria-label="Password hidden"]'), null);
    assert.ok(dialog.querySelector('[aria-label="Card number hidden"]'));
    const description = document.getElementById(dialog.getAttribute('aria-describedby')!)!;
    assert.equal(description.className, 'sr-only');
    assert.doesNotMatch(dialog.textContent ?? '', /Saved login details/);
    await click('Copy cardholder name');
    await click('Copy card number');
    assert.deepEqual(copied, [syntheticCardholder, syntheticCardNumber]);
    assert.ok(dialog.querySelector('[aria-label="Card number hidden"]'));
    assert.equal(dialog.textContent?.includes(syntheticCardNumber), false);
    await click('Show card number');
    assert.equal(dialog.querySelector('.vault-password-visible')?.textContent, syntheticCardNumber);
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(dialog.textContent?.includes(syntheticCardNumber), false);
    delay = true;
    await click('Show card number');
    const request = requests.at(-1)!;
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(request.options.signal?.aborted, true);
    await act(async () => late.resolve(Response.json({ cardNumber: syntheticCardNumber })));
    assert.equal(dialog.textContent?.includes(syntheticCardNumber), false);
    await click('Close');
    await click('View Personal account');
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
    assert.doesNotMatch(
      document.querySelector('[role="dialog"]')?.textContent ?? '',
      /4242424242424242|Synthetic Cardholder/,
    );
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /4242424242424242|Synthetic Cardholder/,
    );
    assert.equal(dom.window.localStorage.length, 0);
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Card edits preserve an omitted number and clear replacement input on cancellation and failure', async () => {
  const previousFetch = globalThis.fetch;
  let card = { ...savedCard };
  const writes: Record<string, unknown>[] = [];
  const requests = mockCardRequests((path, options) => {
    if (path === '/api/vault') return Promise.resolve(Response.json([card, ...savedLogins]));
    if (options.method !== 'PATCH') return;
    const input = JSON.parse(String(options.body));
    writes.push(input);
    if (writes.length > 1)
      return Promise.resolve(
        Response.json({ error: `private ${syntheticCardNumber}` }, { status: 500 }),
      );
    card = {
      ...card,
      label: input.label,
      expiryMonth: input.expiryMonth,
      expiryYear: input.expiryYear,
    };
    return Promise.resolve(Response.json(card));
  });
  const mounted = await mountVault();
  try {
    await click('View Everyday card');
    let form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    assert.equal(form.elements.namedItem('cardNumber'), null);
    assert.match(
      form.querySelector('[aria-label="Card number hidden"]')?.textContent ?? '',
      /4242/,
    );
    await click('Change card number', form);
    const cancelledNumber = form.elements.namedItem('cardNumber') as HTMLInputElement;
    assert.equal(cancelledNumber.required, true);
    assert.equal(cancelledNumber.value, '');
    assert.equal(document.activeElement, cancelledNumber);
    assert.equal(form.checkValidity(), false);
    cancelledNumber.value = '                ';
    await submit(form);
    assert.equal(writes.length, 0);
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? '',
      /Enter the new card number/,
    );
    cancelledNumber.value = syntheticCardNumber;
    await click('Cancel change', form);
    assert.equal(cancelledNumber.value, '');
    assert.equal(form.elements.namedItem('cardNumber'), null);
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Change card number');
    assert.equal(
      (form.elements.namedItem('cardholder') as HTMLInputElement).value,
      syntheticCardholder,
    );
    (form.elements.namedItem('label') as HTMLInputElement).value = 'Travel card';
    (form.elements.namedItem('cardholder') as HTMLInputElement).value = 'Updated Holder';
    (form.elements.namedItem('expiry') as HTMLInputElement).value = '05 / 2033';
    await submit(form);
    assert.deepEqual(writes[0], {
      kind: 'card',
      label: 'Travel card',
      cardholder: 'Updated Holder',
      expiryMonth: 5,
      expiryYear: 2033,
    });
    assert.equal(
      requests.some(({ path }) => path.endsWith('/card-number')),
      false,
    );
    assert.ok(mounted.container.querySelector('[aria-label="View Travel card"]'));
    assert.equal(
      document.querySelector<HTMLInputElement>('[name="cardholder"]')?.value,
      'Updated Holder',
    );
    form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    await click('Change card number', form);
    (form.elements.namedItem('cardNumber') as HTMLInputElement).value = syntheticCardNumber;
    await click('Cancel changes');
    form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    assert.equal(form.elements.namedItem('cardNumber'), null);
    await click('Change card number', form);
    const number = form.elements.namedItem('cardNumber') as HTMLInputElement;
    assert.equal(number.value, '');
    number.value = syntheticCardNumber;
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(number.value, '');
    number.value = syntheticCardNumber;
    await submit(form);
    assert.equal(writes[1].cardNumber, syntheticCardNumber);
    assert.equal(number.value, '');
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      'This card could not be updated. Try again.',
    );
    assert.doesNotMatch(document.body.textContent ?? '', /4242424242424242|private /);
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /4242424242424242|Updated Holder/,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault deletion is only available in details and requires an explicit confirmation there', async () => {
  const previousFetch = globalThis.fetch;
  let removed = false;
  let fail = true;
  const requests = mockCardRequests((path, options) => {
    if (path === '/api/vault')
      return Promise.resolve(Response.json(removed ? savedLogins : [savedCard, ...savedLogins]));
    if (options.method !== 'DELETE') return;
    assert.equal(path, '/api/vault/card%2Fprivate');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal);
    if (fail)
      return Promise.resolve(Response.json({ error: 'private deletion error' }, { status: 500 }));
    removed = true;
    return Promise.resolve(Response.json({ ok: true }));
  });
  const mounted = await mountVault();
  try {
    assert.equal(mounted.container.querySelector('[aria-label^="Delete"]'), null);
    assert.equal(
      [...mounted.container.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('Delete'),
      ),
      false,
    );
    await click('View Everyday card');
    await click('Delete card');
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    assert.match(
      document.querySelector('[role="dialog"]')?.textContent ?? '',
      /Delete this card\?/,
    );
    assert.match(
      document.querySelector('[role="dialog"]')?.textContent ?? '',
      /Everyday card will be removed/,
    );
    assert.equal(document.activeElement?.textContent?.trim(), 'Keep card');
    assert.equal(
      requests.some(({ options }) => options.method === 'DELETE'),
      false,
    );
    await click('Keep card');
    assert.ok(document.querySelector('[aria-label="Card number hidden"]'));
    await click('Delete card');
    await click('Delete card');
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      'This card could not be deleted. Try again.',
    );
    assert.equal(document.body.textContent?.includes('private deletion error'), false);
    fail = false;
    await click('Delete card');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(mounted.container.querySelector('[aria-label="View Everyday card"]'), null);
    assert.ok(mounted.container.querySelector('[aria-label="View Personal account"]'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(document.activeElement?.textContent?.trim(), 'Add item');
    await click('View Personal account');
    await click('Delete login');
    assert.match(
      document.querySelector('[role="dialog"]')?.textContent ?? '',
      /Delete this login\?/,
    );
    await click('Keep login');
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Closing Add item aborts a pending card save and fences it from a new login form', async () => {
  const previousFetch = globalThis.fetch;
  const pending = deferred<Response>();
  const requests = mockCardRequests((path, options) =>
    path === '/api/vault' && options.method === 'POST' ? pending.promise : undefined,
  );
  const mounted = await mountVault();
  try {
    await click('Add item');
    await click('Payment card');
    let form = document.querySelector<HTMLFormElement>('.vault-add-form')!;
    (form.elements.namedItem('label') as HTMLInputElement).value = 'Pending card';
    (form.elements.namedItem('cardholder') as HTMLInputElement).value = syntheticCardholder;
    const number = form.elements.namedItem('cardNumber') as HTMLInputElement;
    number.value = syntheticCardNumber;
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(number.value, '');
    number.value = syntheticCardNumber;
    (form.elements.namedItem('expiry') as HTMLInputElement).value = '04/2032';
    await submit(form);
    const saving = requests.at(-1)!;
    assert.equal(number.value, '');
    await click('Close');
    assert.equal(saving.options.signal?.aborted, true);
    await click('Add item');
    await click('Login');
    form = document.querySelector<HTMLFormElement>('.vault-add-form')!;
    assert.equal((form.elements.namedItem('password') as HTMLInputElement).value, '');
    await act(async () => pending.resolve(Response.json({ ...savedCard, label: 'Pending card' })));
    assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes('Add a login'));
    assert.doesNotMatch(document.body.textContent ?? '', /Pending card|4242424242424242/);
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /Pending card|4242424242424242/,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});
