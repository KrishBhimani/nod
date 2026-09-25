import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';

test('secure invitations keep their links without fetching cards while ordinary articles retain previews', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
    url: 'http://localhost:4310',
  });
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
  ] as const) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  globals.set(
    'IS_REACT_ACT_ENVIRONMENT',
    Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  );
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  const requests: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const url = (JSON.parse(String(init?.body)) as { url: string }).url;
    requests.push(url);
    return new Response(JSON.stringify({ preview: { url, title: 'Public article' } }));
  };
  const { createRoot } = await import('react-dom/client');
  const { MessageText } = await import('../src/web/components/message.tsx');
  const element = document.querySelector('main')!;
  const root = createRoot(element);
  const render = async (text: string) => {
    await act(async () => root.render(createElement(MessageText, { text, previews: true })));
  };
  try {
    for (const credential of [
      '/vault/sign-in-token',
      '/credentials/verification-token',
      'http://localhost:4310/vault/absolute-token',
      'http://localhost:4310/credentials/absolute-otp-token',
    ]) {
      await render(`Sign in to https://www.example.com using [Vault](${credential}).`);
      assert.deepEqual(requests, []);
      assert.equal(element.querySelector('.message-link-preview'), null);
      const links = [...element.querySelectorAll('.message-text a')];
      assert.equal(links.length, 2);
      assert.equal(links[0].getAttribute('href'), 'https://www.example.com/');
      assert.equal(
        links[1].getAttribute('href'),
        new URL(credential, dom.window.location.origin).pathname,
      );
      assert.equal(links[1].textContent, 'Vault');
    }

    await render(
      '[Read this article](https://www.example.com/secure-preview-regression) [Vault page](https://external.example.com/vault/instructions)',
    );
    assert.deepEqual(requests, ['https://www.example.com/secure-preview-regression']);
    assert.equal(element.querySelectorAll('.message-link-preview').length, 1);
    assert.equal(element.querySelectorAll('.message-text a').length, 2);

    await render('Use https://www.example.com and [Vault](/vault/new-token) to finish signing in.');
    assert.deepEqual(requests, ['https://www.example.com/secure-preview-regression']);
    assert.equal(element.querySelector('.message-link-preview'), null);
    assert.equal(element.querySelectorAll('.message-text a').length, 2);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
