import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createWorkAdmission, createWorkConsumers } from '../src/server/work-admission.ts';
import { createTenantDrain } from '../src/server/tenant-drain.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}
const input = (duration = 1000) => ({
  nonce: randomUUID(),
  targetRelease: 'a'.repeat(40),
  deadline: Date.now() + duration,
});

test('admission counts accepted pending starts synchronously and drains without cancellation', async () => {
  const admission = createWorkAdmission();
  const running = deferred();
  let started = false;
  const operation = admission.run(async () => {
    started = true;
    await running.promise;
  });
  assert.equal(admission.pending, 1);
  assert.equal(started, false);
  admission.pause();
  assert.equal(
    admission.run(async () => {
      throw new Error('Not admitted');
    }),
    undefined,
  );
  let drained = false;
  const receipt = admission.drain(Date.now() + 1000).then(() => {
    drained = true;
  });
  await delay(5);
  assert.equal(started, true);
  assert.equal(drained, false);
  running.resolve();
  await operation;
  await receipt;
  assert.equal(admission.pending, 0);
  admission.resume();
  assert.equal(await admission.run(async () => 7), 7);
});

test('a drain deadline leaves work admitted earlier running and admission paused', async () => {
  const admission = createWorkAdmission();
  const release = admission.enter()!;
  admission.pause();
  await assert.rejects(admission.drain(Date.now() + 15), /paused/);
  assert.equal(admission.pending, 1);
  assert.equal(admission.enter(), undefined);
  release();
  release();
  await admission.drain(Date.now() + 1000);
  assert.equal(admission.pending, 0);
});

test('late work completion cannot beat an expired deadline while its timer awaits the event loop', async (t) => {
  const admission = createWorkAdmission();
  const release = admission.enter()!;
  const now = Date.now();
  admission.pause();
  const receipt = assert.rejects(admission.drain(now + 1000), /paused/);
  t.mock.method(Date, 'now', () => now + 1000);
  release();
  await receipt;
  assert.equal(admission.pending, 0);
  assert.equal(admission.paused, true);
});

test('resume invalidates an outstanding drain and shutdown can never reopen admission', async () => {
  const admission = createWorkAdmission();
  const release = admission.enter()!;
  admission.pause();
  const receipt = assert.rejects(admission.drain(Date.now() + 1000), /paused/);
  admission.resume();
  await receipt;
  admission.close();
  assert.throws(() => admission.resume(), /paused/);
  assert.equal(admission.enter(), undefined);
  assert.equal(admission.pending, 1);
  release();
  await admission.drain(Date.now() + 1000);
});

test('consumer pause includes delayed registrations and resume cannot stop a replacement worker', async () => {
  const consumers = createWorkConsumers();
  const starting = deferred<string>();
  const oldWork = deferred();
  const stopped: string[] = [];
  let starts = 0;
  const registration = consumers.register({
    start: async () => (++starts === 1 ? starting.promise : 'replacement'),
    stop: async (id) => {
      stopped.push(id);
      if (id === 'old') await oldWork.promise;
    },
  });
  const pausing = consumers.pause();
  let paused = false;
  void pausing.then(() => {
    paused = true;
  });
  await consumers.resume();
  assert.equal(starts, 2);
  starting.resolve('old');
  await registration;
  await delay(5);
  assert.equal(paused, false);
  assert.deepEqual(stopped, ['old']);
  oldWork.resolve();
  await pausing;
  assert.deepEqual(stopped, ['old']);
  await consumers.close();
  assert.deepEqual(stopped, ['old', 'replacement']);
  await assert.rejects(consumers.resume(), /paused/);
});

test('consumers registered while paused wait until resume and close prevents later starts', async () => {
  const consumers = createWorkConsumers();
  let starts = 0;
  await consumers.pause();
  await consumers.register({ start: async () => String(++starts), stop: async () => {} });
  assert.equal(starts, 0);
  await consumers.resume();
  assert.equal(starts, 1);
  await consumers.resume();
  assert.equal(starts, 1);
  await consumers.close();
  await assert.rejects(
    consumers.register({ start: async () => String(++starts), stop: async () => {} }),
  );
  assert.equal(starts, 1);
});

test('tenant drain requires all accepted work and queue callbacks to finish with its exact identity', async () => {
  const admission = createWorkAdmission();
  const consumers = createWorkConsumers();
  const activeTask = deferred();
  await consumers.register({ start: async () => 'worker', stop: async () => activeTask.promise });
  const release = admission.enter()!;
  const drain = createTenantDrain({ admission, consumers });
  const request = input();
  let completed = false;
  const operation = drain.prepare(request).then(() => {
    completed = true;
  });
  assert.equal(drain.active(), true);
  assert.equal(admission.enter(), undefined);
  await delay(5);
  assert.equal(completed, false);
  activeTask.resolve();
  await delay(5);
  assert.equal(completed, false);
  release();
  await operation;
  await assert.rejects(
    drain.resume({ ...request, nonce: randomUUID() }),
    (error) => (error as { statusCode: number }).statusCode === 409,
  );
  await drain.resume(request);
  assert.equal(drain.active(), false);
  await consumers.close();
});

test('tenant drain timeout leaves pause in place and explicit resume fences the stale receipt', async () => {
  const admission = createWorkAdmission();
  const consumers = createWorkConsumers();
  const task = deferred();
  await consumers.register({ start: async () => randomUUID(), stop: async () => task.promise });
  const drain = createTenantDrain({ admission, consumers });
  const expired = input(15);
  await assert.rejects(drain.prepare(expired), /could not be completed/);
  assert.equal(drain.active(), true);
  assert.equal(admission.enter(), undefined);
  await drain.resume(expired);
  assert.equal(drain.active(), false);
  const next = input();
  const preparing = assert.rejects(drain.prepare(next), /could not be completed/);
  await drain.resume(next);
  task.resolve();
  await preparing;
  assert.equal(drain.active(), false);
  await consumers.close();
});

test('a consumer stop failure never yields a successful deployment receipt', async () => {
  const admission = createWorkAdmission();
  const consumers = createWorkConsumers();
  await consumers.register({
    start: async () => 'worker',
    stop: async () => {
      throw new Error('private stop detail');
    },
  });
  const drain = createTenantDrain({ admission, consumers });
  await assert.rejects(drain.prepare(input()));
  assert.equal(admission.paused, true);
  assert.equal(drain.active(), true);
  await assert.rejects(consumers.resume());
  await assert.rejects(consumers.close());
});

test('a lost resume receipt can be retried but cannot reopen a newer drain', async () => {
  const admission = createWorkAdmission();
  const consumers = createWorkConsumers();
  const drain = createTenantDrain({ admission, consumers });
  const first = input();
  await drain.prepare(first);
  await drain.resume(first);
  await drain.resume(first);
  assert.equal(drain.active(), false);
  await assert.rejects(drain.prepare(first));
  const next = input();
  await drain.prepare(next);
  await assert.rejects(
    drain.resume(first),
    (error) => (error as { statusCode: number }).statusCode === 409,
  );
  assert.equal(drain.active(), true);
  assert.equal(admission.enter(), undefined);
  await drain.resume(next);
  await assert.rejects(drain.resume(first));
  await consumers.close();
});
