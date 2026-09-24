import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { ModelUsageObservation, RuntimeObservation } from '../src/ports/agent.ts';
import { createObservationQueue } from '../src/runtime/observations.ts';

function usage(): ModelUsageObservation {
  return {
    type: 'model_usage',
    id: randomUUID(),
    provider: 'fixture',
    model: 'fixture',
    inputTokens: 3,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 4,
    costUsd: null,
    costSource: 'unavailable',
    createdAt: new Date().toISOString(),
  };
}

test('cancellation releases a stalled write and delivers queued and late usage without waiting', async () => {
  const controller = new AbortController();
  const observed: RuntimeObservation[] = [];
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let rejectObservation!: (error: Error) => void;
  const stalled = new Promise<void>((_resolve, reject) => {
    rejectObservation = reject;
  });
  const queue = createObservationQueue({
    signal: controller.signal,
    observe: async (event) => {
      observed.push(event);
      entered();
      return stalled;
    },
  });
  const first = queue.record({
    type: 'tool_start',
    id: randomUUID(),
    name: 'fixture',
    input: {},
    startedAt: new Date().toISOString(),
  });
  const queuedUsage = usage();
  const queued = queue.record(queuedUsage);
  await started;
  controller.abort();
  const lateUsage = usage();
  const late = queue.record(lateUsage);
  await Promise.all([first, queued, late, queue.flush()]);
  assert.deepEqual(
    new Set(observed.filter((event) => event.type === 'model_usage').map((event) => event.id)),
    new Set([queuedUsage.id, lateUsage.id]),
  );
  rejectObservation(new Error('Late fixture failure'));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('a timed-out observation intentionally leaves later segment usage uncaptured', async () => {
  const controller = new AbortController();
  const observed: RuntimeObservation[] = [];
  const queue = createObservationQueue({
    signal: controller.signal,
    timeoutMs: 10,
    observe: async (event) => {
      observed.push(event);
      return new Promise<void>(() => {});
    },
  });
  const first = queue.record({
    type: 'tool_start',
    id: randomUUID(),
    name: 'fixture',
    input: {},
    startedAt: new Date().toISOString(),
  });
  const queued = queue.record(usage());
  await Promise.all([first, queued, queue.flush()]);
  controller.abort();
  await queue.record(usage());
  assert.deepEqual(
    observed.map((event) => event.type),
    ['tool_start'],
  );
});
