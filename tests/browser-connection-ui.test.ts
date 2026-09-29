import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310/browser-connect/' + 'a'.repeat(43),
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLInputElement',
  'HTMLFormElement',
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
const { BrowserConnection } = await import('../src/web/pages/browser-connection.tsx');
const { ConnectedAccount } = await import('../src/web/pages/apps.tsx');

test('the LinkedIn sign-in page shows the checked login origin and private fields', async () => {
  const priorFetch = globalThis.fetch;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  globalThis.fetch = async (url) =>
    String(url).endsWith('/control')
      ? Response.json({
          paused: false,
          active: false,
          revision: null,
          mode: null,
          signInAvailable: true,
        })
      : Response.json({
          name: 'linkedin.com',
          label: 'My LinkedIn',
          origin: 'https://www.linkedin.com',
          state: 'pending',
          fromChat: true,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          inspection: {
            origin: 'https://api.linkedin.com',
            canSubmit: true,
            fields: [
              { kind: 'identifier', label: 'Email or phone' },
              { kind: 'password', label: 'Password' },
            ],
            methods: [{ kind: 'credentials', label: 'Email', supported: true }],
            issue: null,
          },
        });
  try {
    await act(async () => root.render(createElement(BrowserConnection, { token: 'a'.repeat(43) })));
    assert.match(container.textContent ?? '', /Connect linkedin\.com/);
    assert.equal(
      container.querySelector('.browser-connection-back[href="/"]')?.textContent,
      'Back to chat',
    );
    assert.match(container.textContent ?? '', /Enter your sign-in details/);
    assert.match(container.textContent ?? '', /https:\/\/api\.linkedin\.com/);
    assert.match(container.textContent ?? '', /Open private browser/);
    assert.ok(container.querySelector('input[type="password"]'));
    assert.ok(container.querySelector('input[autocomplete="username"]'));
    assert.equal(container.querySelector('a[href^="https://api.linkedin.com"]'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = priorFetch;
  }
});

test('the sign-in page reports checks and a later verification step', async () => {
  const priorFetch = globalThis.fetch;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const passwordInspection = {
    origin: 'https://www.linkedin.com',
    canSubmit: true,
    fields: [
      { kind: 'identifier', label: 'Email' },
      { kind: 'password', label: 'Password' },
    ],
    methods: [],
    issue: null,
  };
  const codeInspection = {
    ...passwordInspection,
    fields: [{ kind: 'otp', label: 'Verification code' }],
  };
  let inspection: typeof passwordInspection | typeof codeInspection | null = passwordInspection;
  let submit: ((response: Response) => void) | undefined;
  let finish: ((response: Response) => void) | undefined;
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path.endsWith('/control'))
      return Response.json({
        paused: false,
        active: false,
        revision: null,
        mode: null,
        signInAvailable: true,
      });
    if (path.endsWith('/credentials') && options?.method === 'POST')
      return new Promise<Response>((resolve) => {
        submit = resolve;
      });
    if (path.endsWith('/finish') && options?.method === 'POST')
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    return Response.json({
      name: 'linkedin.com',
      label: 'My LinkedIn',
      origin: 'https://www.linkedin.com',
      state: 'pending',
      fromChat: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      inspection,
    });
  };
  try {
    await act(async () => root.render(createElement(BrowserConnection, { token: 'b'.repeat(43) })));
    await act(async () => {
      const fields = container.querySelectorAll('input');
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
        fields[0],
        'person@example.com',
      );
      fields[0].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
        fields[1],
        'synthetic-password',
      );
      fields[1].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      container
        .querySelector('form')
        ?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.match(container.textContent ?? '', /Checking your details/);
    assert.match(container.textContent ?? '', /verification code or another sign-in step/);
    assert.ok(submit);
    inspection = null;
    await act(async () => submit?.(Response.json({ status: 'submitted', inspection: null })));
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('I finished signing in'))
        ?.click();
    });
    assert.match(container.textContent ?? '', /Checking your sign-in/);
    assert.ok(finish);
    inspection = codeInspection;
    await act(async () =>
      finish?.(Response.json({ error: 'Sign-in is still needed.' }, { status: 409 })),
    );
    assert.match(container.textContent ?? '', /Enter your verification code/);
    assert.ok(container.querySelector('input[autocomplete="one-time-code"]'));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = priorFetch;
  }
});

test('Apps offers a new secure link for a pending website connection', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(ConnectedAccount, {
          account: {
            slug: 'browser-linkedin-com',
            name: 'linkedin.com',
            status: 'disconnected',
            connectionId: 'synthetic-id',
            accountName: 'My LinkedIn',
            triggersEnabled: false,
            browserState: 'pending',
          },
          busy: false,
          onDisconnect: () => {},
          onReconnect: () => {},
        }),
      ),
    );
    assert.match(container.textContent ?? '', /Finish sign-in/);
    assert.ok(
      [...container.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('Continue sign-in'),
      ),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
