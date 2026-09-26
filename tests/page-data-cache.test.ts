import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createPageDataCache } from '../src/web/lib/page-data-cache.ts';

function fixture() {
  const requests: Array<{
    path: string;
    signal: AbortSignal;
    resolve(value: unknown): void;
    reject(error: Error): void;
  }> = [];
  const cache = createPageDataCache(
    (path, signal) =>
      new Promise((resolve, reject) => requests.push({ path, signal, resolve, reject })),
    0,
  );
  return { cache, requests };
}

test('page cache retains last-good data across subscribers and deduplicates overlapping reads', async () => {
  const { cache, requests } = fixture();
  assert.equal(cache.getSnapshot('/goals').loading, true);
  const stop = cache.subscribe('/goals', () => {});
  const first = cache.refresh('/goals');
  const duplicate = cache.refresh('/goals');
  assert.equal(duplicate, first);
  await Promise.resolve();
  assert.equal(requests.length, 1);
  stop();
  requests[0].resolve([{ id: 'saved-goal' }]);
  await first;
  const nextStop = cache.subscribe('/goals', () => {});
  assert.deepEqual(cache.getSnapshot('/goals').data, [{ id: 'saved-goal' }]);
  const refresh = cache.refresh('/goals');
  assert.equal(cache.getSnapshot('/goals').loading, false);
  assert.equal(cache.getSnapshot('/goals').refreshing, true);
  assert.deepEqual(cache.getSnapshot('/goals').data, [{ id: 'saved-goal' }]);
  await Promise.resolve();
  requests[1].reject(new Error('Refresh unavailable'));
  await refresh;
  assert.deepEqual(cache.getSnapshot('/goals').data, [{ id: 'saved-goal' }]);
  assert.equal(cache.getSnapshot('/goals').error, 'Refresh unavailable');
  nextStop();
});

test('accepted mutation and forced refresh reject obsolete responses even when fetch ignores abort', async () => {
  const { cache, requests } = fixture();
  cache.update<string[]>('/accounts', () => ['removed', 'retained']);
  const old = cache.refresh('/accounts');
  await Promise.resolve();
  cache.update<string[]>('/accounts', (accounts) =>
    accounts!.filter((value) => value !== 'removed'),
  );
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(['removed', 'retained']);
  await old;
  assert.deepEqual(cache.getSnapshot('/accounts').data, ['retained']);
  const before = cache.refresh('/accounts');
  await Promise.resolve();
  const after = cache.refresh('/accounts', true);
  await Promise.resolve();
  requests[2].resolve(['new']);
  await after;
  requests[1].resolve(['retained']);
  await before;
  assert.deepEqual(cache.getSnapshot('/accounts').data, ['new']);
  assert.equal(cache.getSnapshot('/accounts').refreshing, false);
});

test('first-load failures remain explicit and active update bursts queue one silent follow-up', async () => {
  const { cache, requests } = fixture();
  const first = cache.refresh('/schedules');
  await Promise.resolve();
  requests[0].reject(new Error('First load failed'));
  await first;
  assert.deepEqual(cache.getSnapshot('/schedules'), {
    data: null,
    error: 'First load failed',
    loading: false,
    refreshing: false,
  });
  cache.update('/schedules', () => [{ id: 'cached' }]);
  const stop = cache.subscribe('/schedules', () => {});
  const active = cache.refresh('/schedules');
  await Promise.resolve();
  cache.revalidateActive();
  cache.revalidateActive();
  cache.revalidateActive();
  assert.equal(requests.length, 2);
  requests[1].resolve([{ id: 'first-refresh' }]);
  await active;
  await delay(5);
  assert.equal(requests.length, 3);
  assert.equal(cache.getSnapshot('/schedules').loading, false);
  requests[2].resolve([{ id: 'latest' }]);
  await cache.refresh('/schedules');
  assert.deepEqual(cache.getSnapshot('/schedules').data, [{ id: 'latest' }]);
  stop();
  cache.revalidateActive();
  await delay(5);
  assert.equal(requests.length, 3);
});
