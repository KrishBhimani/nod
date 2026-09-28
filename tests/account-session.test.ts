import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionResponse } from '../src/shared/account.ts';
import { createSessionStore } from '../src/web/lib/session.ts';

function session(id: string, theme: 'light' | 'dark' | 'system' = 'system'): SessionResponse {
  return {
    auth: { mode: 'google', googleAvailable: true },
    user: { id, name: id, email: `${id}@example.test`, avatarUrl: null },
    settings: { theme, onboardingCompleted: true },
    capabilities: { developer: false },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('session transitions clear owned data and apply only the accepted account theme', async () => {
  let next = session('alex', 'dark');
  let clears = 0;
  const themes: (string | undefined)[] = [];
  const store = createSessionStore(
    async <T>() => next as T,
    () => clears++,
    (value) => themes.push(value?.settings?.theme),
  );
  await store.refresh();
  const firstEpoch = store.getSnapshot().epoch;
  assert.equal(clears, 1);
  await store.refresh();
  assert.equal(clears, 1);
  next = session('sam', 'light');
  await store.refresh();
  assert.equal(clears, 2);
  assert.equal(store.getSnapshot().session?.user?.id, 'sam');
  assert.equal(store.getSnapshot().epoch, firstEpoch + 1);
  store.invalidate();
  assert.equal(clears, 3);
  assert.equal(store.getSnapshot().session?.user, null);
  assert.equal(themes.at(-1), undefined);
});

test('obsolete session and account responses cannot restore a signed-out or different account', async () => {
  const read = deferred<SessionResponse>();
  const mutation = deferred<SessionResponse>();
  let next = session('alex');
  let delayRead = false;
  const store = createSessionStore(
    async <T>(path: string) =>
      (path === '/api/account' ? mutation.promise : delayRead ? read.promise : next) as Promise<T>,
    () => {},
  );
  await store.refresh();
  const editing = store.update({ name: 'Changed' });
  delayRead = true;
  const refreshing = store.refresh();
  store.invalidate();
  delayRead = false;
  next = session('sam', 'light');
  await store.refresh();
  mutation.resolve({
    ...session('alex', 'dark'),
    user: { ...session('alex').user!, name: 'Changed' },
  });
  read.resolve(session('alex', 'dark'));
  await Promise.all([editing, refreshing]);
  assert.equal(store.getSnapshot().session?.user?.id, 'sam');
  assert.equal(store.getSnapshot().session?.settings?.theme, 'light');
});

test('account mutations remain serialized during background refresh and accepted writes fence old reads', async () => {
  const write = deferred<SessionResponse>();
  const stale = deferred<SessionResponse>();
  let delayed = false;
  let mutations = 0;
  const store = createSessionStore(
    async <T>(path: string) => {
      if (path === '/api/account') {
        mutations++;
        return (await write.promise) as T;
      }
      return (delayed ? await stale.promise : session('alex')) as T;
    },
    () => {},
  );
  await store.refresh();
  const saving = store.update({ theme: 'dark' });
  await store.refresh();
  assert.equal(store.getSnapshot().mutating, true);
  await assert.rejects(store.update({ theme: 'light' }), /finish saving/);
  assert.equal(mutations, 1);
  delayed = true;
  const reading = store.refresh();
  write.resolve(session('alex', 'dark'));
  await saving;
  stale.resolve(session('alex', 'light'));
  await reading;
  assert.equal(store.getSnapshot().session?.settings?.theme, 'dark');
  assert.equal(store.getSnapshot().mutating, false);
});

test('logout clears private state before the network completes and preserves a failed logout for retry', async () => {
  const first = deferred<unknown>();
  const headers: string[] = [];
  let tries = 0;
  const store = createSessionStore(
    async <T>(path: string, options?: RequestInit) => {
      if (path !== '/api/logout') return session('alex') as T;
      headers.push(new Headers(options?.headers).get('X-Otto-Account') ?? '');
      tries++;
      return (tries === 1 ? await first.promise : { ok: true }) as T;
    },
    () => {},
  );
  await store.refresh();
  const logout = store.logout();
  assert.equal(store.getSnapshot().session?.user, null);
  assert.equal(store.getSnapshot().signingOut, true);
  first.reject(new Error('Unavailable'));
  await logout;
  assert.equal(store.getSnapshot().signingOut, true);
  assert.ok(store.getSnapshot().error);
  await store.refresh();
  assert.equal(store.getSnapshot().session?.user, null);
  await store.logout();
  assert.equal(store.getSnapshot().signingOut, false);
  assert.deepEqual(headers, ['alex', 'alex']);
});

test('an account mutation returning another identity fails closed', async () => {
  const store = createSessionStore(
    async <T>(path: string) => session(path === '/api/account' ? 'sam' : 'alex') as T,
    () => {},
  );
  await store.refresh();
  await assert.rejects(store.update({ name: 'Changed' }), /Sign in again/);
  assert.equal(store.getSnapshot().session?.user, null);
});

test('malformed session data clears private state without rendering an incomplete account', async () => {
  let response: unknown = session('alex');
  const store = createSessionStore(
    async <T>() => response as T,
    () => {},
  );
  await store.refresh();
  response = { user: { id: 'sam' }, capabilities: { developer: true } };
  await store.refresh();
  assert.equal(store.getSnapshot().session?.user, null);
  assert.equal(store.getSnapshot().session?.capabilities.developer, false);
  assert.match(store.getSnapshot().error, /could not be opened/);
});
