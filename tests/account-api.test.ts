import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { JSDOM } from 'jsdom';
import { api, apiResponse, setRequestAccount } from '../src/web/lib/api.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
});
for (const key of ['window', 'Event'] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
after(() => dom.window.close());

test('authenticated API requests carry an expected account without changing auth bootstrap', async () => {
  const previous = globalThis.fetch;
  const requests: { path: string; owner: string | null }[] = [];
  globalThis.fetch = async (path, options) => {
    requests.push({
      path: String(path),
      owner: new Headers(options?.headers).get('X-Sidekick-Account'),
    });
    return Response.json({ ok: true });
  };
  try {
    setRequestAccount('alex');
    await api('/api/preferences', { method: 'PATCH', body: '{}' });
    await api('/api/session');
    await api('/api/login', { method: 'POST', body: '{}' });
    await apiResponse('/api/browser/screen?taskId=synthetic');
    assert.deepEqual(
      requests.map((value) => value.owner),
      ['alex', null, null, 'alex'],
    );
  } finally {
    setRequestAccount(null);
    globalThis.fetch = previous;
  }
});

test('an account switch aborts and discards old responses, including a stale unauthorized reply', async () => {
  const previous = globalThis.fetch;
  let resolve!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  let unauthorized = 0;
  const listener = () => unauthorized++;
  window.addEventListener('sidekick:unauthorized', listener);
  globalThis.fetch = async (_path, options) => {
    signal = options?.signal;
    return new Promise((accept) => {
      resolve = accept;
    });
  };
  try {
    setRequestAccount('alex');
    const pending = api('/api/vault');
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    setRequestAccount('sam');
    assert.equal(signal?.aborted, true);
    resolve(Response.json({ error: 'Expired' }, { status: 401 }));
    await rejected;
    assert.equal(unauthorized, 0);
  } finally {
    window.removeEventListener('sidekick:unauthorized', listener);
    setRequestAccount(null);
    globalThis.fetch = previous;
  }
});

test('a current unauthorized reply invalidates the active session once', async () => {
  const previous = globalThis.fetch;
  let unauthorized = 0;
  const listener = () => unauthorized++;
  window.addEventListener('sidekick:unauthorized', listener);
  globalThis.fetch = async () => Response.json({ error: 'Sign in again.' }, { status: 401 });
  try {
    setRequestAccount('alex');
    await assert.rejects(api('/api/apps'), { status: 401 });
    assert.equal(unauthorized, 1);
  } finally {
    window.removeEventListener('sidekick:unauthorized', listener);
    setRequestAccount(null);
    globalThis.fetch = previous;
  }
});
