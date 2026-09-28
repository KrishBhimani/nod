import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createComputerCommands } from '../src/computer-commands.ts';
import { RuntimeControlError } from '../src/protocol.ts';
import { launchCloudflareCommand } from '../../../src/providers/cloudflare-computer/transport.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function processFixture() {
  const exited = deferred<number>();
  const input: Uint8Array[] = [];
  const signals: number[] = [];
  const cancelled: string[] = [];
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  let beforeInput = async (_bytes: Uint8Array) => {};
  let beforeClose = async () => {};
  let inputClosed = false;
  const process: ExecProcess = {
    pid: 1,
    isPty: false,
    stdin: new WritableStream<Uint8Array>({
      async write(value) {
        await beforeInput(value);
        input.push(value.slice());
      },
      async close() {
        await beforeClose();
        inputClosed = true;
      },
      abort() {
        cancelled.push('stdin');
      },
    }),
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        stdout = controller;
      },
      cancel() {
        cancelled.push('stdout');
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        stderr = controller;
      },
      cancel() {
        cancelled.push('stderr');
      },
    }),
    exitCode: exited.promise,
    output: async () => {
      throw new Error('Unused synthetic operation');
    },
    kill(signal = 15) {
      signals.push(signal);
    },
    resize() {},
  };
  return {
    process,
    input,
    signals,
    cancelled,
    stdout: (bytes: Uint8Array) => stdout.enqueue(bytes),
    stderr: (bytes: Uint8Array) => stderr.enqueue(bytes),
    beforeInput(value: typeof beforeInput) {
      beforeInput = value;
    },
    beforeClose(value: typeof beforeClose) {
      beforeClose = value;
    },
    inputClosed: () => inputClosed,
    finish(code = 0) {
      try {
        stdout.close();
      } catch {}
      try {
        stderr.close();
      } catch {}
      exited.resolve(code);
    },
    reject() {
      exited.reject(new Error('Synthetic private native exit failure'));
    },
  };
}

function fixture(overrides: Partial<Parameters<typeof createComputerCommands>[0]> = {}) {
  const processes: ReturnType<typeof processFixture>[] = [];
  const launches: Array<{ id: string; generation: string; taskId?: string }> = [];
  const completed: Array<{ id: string; generation: string; code: number }> = [];
  const uncertain: Array<{ id: string; generation: string }> = [];
  let allowed = true;
  const role = overrides.role ?? 'workspace';
  const registry = createComputerCommands({
    role,
    async authorize() {
      if (!allowed) throw new RuntimeControlError(403);
    },
    async launch(input) {
      launches.push(input);
      const process = processFixture();
      processes.push(process);
      return process.process;
    },
    async completed(input) {
      completed.push(input);
    },
    async uncertain(input) {
      uncertain.push(input);
    },
    ...overrides,
  });
  const request = (path: string, init: RequestInit = {}, version = '1') =>
    registry.fetch(
      new Request('http://otto.computer' + path, {
        ...init,
        headers: { ...init.headers, 'x-otto-generation': version },
      }),
    );
  return {
    registry,
    processes,
    launches,
    completed,
    uncertain,
    request,
    create: (id: string = randomUUID(), version = '1') =>
      request(
        '/v1/commands',
        {
          method: 'POST',
          body: JSON.stringify({ id, role, ...(role === 'workspace' && { taskId: 'task' }) }),
        },
        version,
      ),
    revoke() {
      allowed = false;
    },
    async close() {
      await registry.stop();
      for (const process of processes) process.finish();
    },
  };
}

async function eventual(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await delay(5);
  }
  assert.equal(check(), true);
}

async function create(f: ReturnType<typeof fixture>, version = '1') {
  const id = randomUUID();
  const response = await f.create(id, version);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return id;
}

function attachClient(f: ReturnType<typeof fixture>) {
  let uncertain = 0;
  const process = launchCloudflareCommand({
    role: 'workspace',
    generation: '1',
    taskId: 'task',
    fetch: (input, init) => f.registry.fetch(new Request(input, init)) as Promise<Response>,
    onUncertain() {
      uncertain++;
    },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  process.stdout.on('data', (value: Buffer) => stdout.push(value));
  process.stderr.on('data', (value: Buffer) => stderr.push(value));
  const terminal = new Promise<{ code?: number | null; error?: string }>((resolve) => {
    process.on('error', (error: Error) => resolve({ error: error.message }));
    process.on('close', (code: number | null) => resolve({ code }));
  });
  return { process, terminal, stdout, stderr, uncertain: () => uncertain };
}

test('computer command creation validates identities, role, task and generation before launch', async () => {
  for (const role of ['browser', 'workspace'] as const) {
    const f = fixture({ role });
    try {
      const valid = { id: randomUUID(), role, ...(role === 'workspace' && { taskId: 'task' }) };
      for (const body of [
        { ...valid, id: '../private' },
        { ...valid, role: role === 'browser' ? 'workspace' : 'browser' },
        { ...valid, taskId: role === 'browser' ? 'task' : undefined },
        { ...valid, taskId: '../private' },
        { ...valid, arbitrary: 'private synthetic value' },
        null,
        [],
      ]) {
        const response = await f.request('/v1/commands', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400);
        assert.doesNotMatch(await response.text(), /private/);
      }
      for (const version of ['', '0', '-1', '01', '1e2', '12345678901234567890']) {
        assert.equal((await f.create(randomUUID(), version)).status, 400);
      }
      assert.equal(
        (await f.request('/v1/commands', { method: 'POST', body: new Uint8Array([195, 40]) }))
          .status,
        400,
      );
      assert.equal(
        (await f.request('/v1/commands', { method: 'POST', body: 'x'.repeat(513) })).status,
        413,
      );
      assert.equal(f.launches.length, 0);
      const id = await create(f);
      assert.deepEqual(f.launches, [
        { id, generation: '1', taskId: role === 'workspace' ? 'task' : undefined },
      ]);
      assert.equal((await f.create(id)).status, 409);
      assert.equal((await f.request(`/v1/commands/${id}/output`, {}, '2')).status, 404);
      assert.equal((await f.request(`/v1/commands/${randomUUID()}/output`)).status, 404);
    } finally {
      await f.close();
    }
  }
});

test('native command streams interoperate with the client and preserve binary input, cancellation and output', async () => {
  const f = fixture();
  const client = attachClient(f);
  try {
    client.process.stdin.write(Buffer.from([0, 255, 128]));
    client.process.stdin.write(Buffer.from('cancel\n'));
    client.process.stdin.end();
    await eventual(() => f.processes[0]?.inputClosed() ?? false);
    assert.deepEqual(
      Buffer.concat(f.processes[0].input),
      Buffer.from([0, 255, 128, 99, 97, 110, 99, 101, 108, 10]),
    );
    const output = Buffer.alloc(70_003, 173);
    f.processes[0].stdout(output);
    f.processes[0].stderr(Buffer.from('synthetic stderr'));
    f.processes[0].finish(17);
    assert.deepEqual(await client.terminal, { code: 17 });
    assert.deepEqual(Buffer.concat(client.stdout), output);
    assert.equal(Buffer.concat(client.stderr).toString(), 'synthetic stderr');
    assert.equal(f.completed.length, 1);
    assert.equal(client.uncertain(), 0);
    assert.equal(f.registry.uncertain, false);
    await eventual(
      () =>
        !f.processes[0].process.stdin!.locked &&
        !f.processes[0].process.stdout!.locked &&
        !f.processes[0].process.stderr!.locked,
    );
  } finally {
    await f.close();
  }
});

test('signal acknowledgement never substitutes for process exit or durable checkpoint completion', async () => {
  const checkpoint = deferred();
  const checkpointEntered = deferred();
  const f = fixture({
    async completed() {
      checkpointEntered.resolve();
      await checkpoint.promise;
    },
  });
  try {
    const id = await create(f);
    const response = await f.request(`/v1/commands/${id}/output`);
    const reader = response.body!.getReader();
    let finished = false;
    const read = reader.read().then((value) => {
      finished = true;
      return value;
    });
    assert.equal(
      (
        await f.request(`/v1/commands/${id}/kill`, {
          method: 'POST',
          body: JSON.stringify({ signal: 'SIGTERM' }),
        })
      ).status,
      204,
    );
    assert.deepEqual(f.processes[0].signals, [15]);
    await delay(5);
    assert.equal(finished, false);
    assert.equal(f.registry.active, 1);
    f.processes[0].finish(143);
    await checkpointEntered.promise;
    assert.equal(finished, false);
    assert.equal(f.registry.active, 1);
    assert.equal(
      (await f.request(`/v1/commands/${id}/input`, { method: 'POST', body: 'too late' })).status,
      409,
    );
    assert.equal(f.processes[0].input.length, 0);
    assert.equal(f.registry.uncertain, false);
    assert.equal(
      (
        await f.request(`/v1/commands/${id}/kill`, {
          method: 'POST',
          body: JSON.stringify({ signal: 'SIGKILL' }),
        })
      ).status,
      204,
    );
    assert.deepEqual(f.processes[0].signals, [15]);
    checkpoint.resolve();
    const frame = await read;
    assert.deepEqual(JSON.parse(Buffer.from(frame.value!).toString()), { type: 'exit', code: 143 });
    assert.equal((await reader.read()).done, true);
    reader.releaseLock();
    await eventual(() => f.registry.active === 0);
  } finally {
    checkpoint.resolve();
    await f.close();
  }
});

test('blocked input preserves ordering but cannot block a kill signal', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  try {
    const id = await create(f);
    f.processes[0].beforeInput(async () => {
      entered.resolve();
      await release.promise;
    });
    const first = f.request(`/v1/commands/${id}/input`, { method: 'POST', body: 'first' });
    await entered.promise;
    const second = f.request(`/v1/commands/${id}/input`, { method: 'POST', body: 'second' });
    const signal = f.request(`/v1/commands/${id}/kill`, {
      method: 'POST',
      body: JSON.stringify({ signal: 'SIGTERM' }),
    });
    await eventual(() => f.processes[0].signals.length === 1);
    assert.equal((await signal).status, 204);
    assert.equal(f.processes[0].input.length, 0);
    release.resolve();
    assert.equal((await first).status, 204);
    assert.equal((await second).status, 204);
    assert.deepEqual(
      f.processes[0].input.map((value) => Buffer.from(value).toString()),
      ['first', 'second'],
    );
  } finally {
    release.resolve();
    await f.close();
  }
});

test('an output disconnect fences every concurrent browser command and cancels its native readers', async () => {
  const f = fixture({ role: 'browser' });
  try {
    const one = await create(f);
    await create(f);
    const response = await f.request(`/v1/commands/${one}/output`);
    await response.body!.cancel();
    await eventual(() => f.registry.uncertain);
    assert.deepEqual(
      f.processes.map((value) => value.signals),
      [[9], [9]],
    );
    await eventual(() =>
      f.processes.every(
        (value) => value.cancelled.includes('stdout') && value.cancelled.includes('stderr'),
      ),
    );
    await eventual(() =>
      f.processes.every(
        (value) =>
          !value.process.stdin!.locked &&
          !value.process.stdout!.locked &&
          !value.process.stderr!.locked,
      ),
    );
    assert.equal((await f.create()).status, 409);
    assert.equal(f.completed.length, 0);
  } finally {
    await f.close();
  }
});

test('stream overflow and deadline failures withhold terminal acknowledgement and fence reuse', async () => {
  for (const overflow of [true, false]) {
    const f = fixture({ timeoutMs: overflow ? 1000 : 25 });
    const client = attachClient(f);
    try {
      client.process.stdin.end();
      await eventual(() => f.processes.length === 1);
      if (overflow) f.processes[0].stdout(new Uint8Array(32 * 1024 * 1024 + 1));
      const terminal = await client.terminal;
      assert.deepEqual(terminal, {
        error: 'The remote computer connection did not finish safely.',
      });
      assert.equal(client.uncertain(), 1);
      assert.equal(f.registry.uncertain, true);
      assert.equal((await f.create()).status, 409);
      assert.equal(f.completed.length, 0);
    } finally {
      await f.close();
    }
  }
});

test('input overflow fences a known command without writing oversized bytes', async () => {
  const f = fixture();
  try {
    const id = await create(f);
    const response = await f.request(`/v1/commands/${id}/input`, {
      method: 'POST',
      body: new Uint8Array(1024 * 1024 + 1025),
    });
    assert.equal(response.status, 413);
    assert.equal(f.processes[0].input.length, 0);
    assert.equal(f.registry.uncertain, true);
    assert.deepEqual(f.processes[0].signals, [9]);
  } finally {
    await f.close();
  }
});

test('browser and workspace registries reserve their exact concurrent launch limits', async () => {
  for (const role of ['browser', 'workspace'] as const) {
    const f = fixture({ role });
    try {
      const count = role === 'browser' ? 32 : 1;
      const responses = await Promise.all(Array.from({ length: count + 1 }, () => f.create()));
      assert.equal(responses.filter((response) => response.status === 201).length, count);
      assert.equal(responses.filter((response) => response.status === 409).length, 1);
      assert.equal(f.launches.length, count);
      assert.equal(f.registry.active, count);
    } finally {
      await f.close();
    }
  }
});

test('launch, native exit and checkpoint errors expose only fixed failures and retain uncertainty', async () => {
  for (const kind of ['launch', 'native', 'checkpoint'] as const) {
    const f = fixture({
      ...(kind === 'launch' && {
        async launch() {
          throw new Error('Synthetic private launch secret');
        },
      }),
      ...(kind === 'checkpoint' && {
        async completed() {
          throw new Error('Synthetic private checkpoint secret');
        },
      }),
    });
    const client = attachClient(f);
    try {
      client.process.stdin.end();
      if (kind !== 'launch') {
        await eventual(() => f.processes.length === 1);
        if (kind === 'native') f.processes[0].reject();
        else f.processes[0].finish();
      }
      assert.deepEqual(await client.terminal, {
        error: 'The remote computer connection did not finish safely.',
      });
      assert.equal(f.registry.uncertain, true);
      assert.equal(client.uncertain(), 1);
    } finally {
      await f.close();
    }
  }
});

test('authorization expiry fences a silent command without needing another client request', async () => {
  const f = fixture({ authorizationIntervalMs: 10 });
  const client = attachClient(f);
  try {
    client.process.stdin.end();
    await eventual(() => f.processes[0]?.inputClosed() ?? false);
    f.revoke();
    assert.deepEqual(await client.terminal, {
      error: 'The remote computer connection did not finish safely.',
    });
    assert.equal(f.registry.uncertain, true);
    assert.deepEqual(f.processes[0].signals, [9]);
    assert.equal(f.completed.length, 0);
    assert.equal(f.uncertain.length, 1);
  } finally {
    await f.close();
  }
});

test('revoked control requests fence their command while stale IDs cannot interrupt it', async () => {
  const f = fixture();
  try {
    const id = await create(f);
    assert.equal(
      (await f.request(`/v1/commands/${id}/input`, { method: 'POST', body: 'stale' }, '2')).status,
      404,
    );
    const output = await f.request(`/v1/commands/${id}/output`);
    assert.equal((await f.request(`/v1/commands/${id}/output`)).status, 409);
    assert.equal((await f.request(`/v1/commands/${id}/output`, { method: 'POST' })).status, 405);
    assert.equal(f.registry.uncertain, false);
    assert.deepEqual(f.processes[0].signals, []);
    f.revoke();
    assert.equal(
      (await f.request(`/v1/commands/${id}/input`, { method: 'POST', body: 'expired' })).status,
      403,
    );
    assert.equal(f.registry.uncertain, true);
    assert.deepEqual(f.processes[0].signals, [9]);
    await output.body!.cancel().catch(() => {});
  } finally {
    await f.close();
  }
});

test('completion waits for an already accepted end request to settle', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  try {
    const id = await create(f);
    const response = await f.request(`/v1/commands/${id}/output`);
    const output = response.text();
    f.processes[0].beforeClose(async () => {
      entered.resolve();
      await release.promise;
    });
    const ending = f.request(`/v1/commands/${id}/end`, { method: 'POST' });
    await entered.promise;
    f.processes[0].finish();
    await delay(5);
    assert.equal(f.completed.length, 0);
    release.resolve();
    assert.equal((await ending).status, 204);
    assert.deepEqual(JSON.parse(await output), { type: 'exit', code: 0 });
    assert.equal(f.completed.length, 1);
  } finally {
    release.resolve();
    await f.close();
  }
});

test('uncertainty during a checkpoint suppresses exit and stop waits for its durable fence', async () => {
  const checkpointEntered = deferred();
  const checkpoint = deferred();
  const fenceEntered = deferred();
  const fence = deferred();
  const f = fixture({
    authorizationIntervalMs: 10,
    async completed() {
      checkpointEntered.resolve();
      await checkpoint.promise;
    },
    async uncertain() {
      fenceEntered.resolve();
      await fence.promise;
    },
  });
  const client = attachClient(f);
  try {
    client.process.stdin.end();
    await eventual(() => f.processes[0]?.inputClosed() ?? false);
    f.processes[0].finish();
    await checkpointEntered.promise;
    f.revoke();
    await fenceEntered.promise;
    checkpoint.resolve();
    assert.deepEqual(await client.terminal, {
      error: 'The remote computer connection did not finish safely.',
    });
    let stopped = false;
    const stopping = f.registry.stop().then(() => {
      stopped = true;
    });
    await delay(5);
    assert.equal(stopped, false);
    fence.resolve();
    await stopping;
    assert.equal(f.registry.uncertain, true);
  } finally {
    checkpoint.resolve();
    fence.resolve();
    await f.close();
  }
});

test('a late native launch is cancelled after the command deadline without returning a creation acknowledgement', async () => {
  const launched = deferred();
  const release = deferred();
  const native = processFixture();
  const f = fixture({
    timeoutMs: 25,
    async launch() {
      launched.resolve();
      await release.promise;
      return native.process;
    },
  });
  try {
    const creating = f.create();
    await launched.promise;
    await eventual(() => f.registry.uncertain);
    release.resolve();
    assert.equal((await creating).status, 503);
    assert.deepEqual(native.signals, [9]);
    await eventual(() =>
      ['stdin', 'stdout', 'stderr'].every((stream) => native.cancelled.includes(stream)),
    );
    assert.equal(f.completed.length, 0);
  } finally {
    release.resolve();
    native.finish();
    await f.close();
  }
});

test('expiry while post-launch authorization is pending cannot produce a creation acknowledgement', async () => {
  const entered = deferred();
  const release = deferred();
  let checks = 0;
  const f = fixture({
    timeoutMs: 25,
    async authorize() {
      if (++checks === 3) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  try {
    const creating = f.create();
    await entered.promise;
    await eventual(() => f.registry.uncertain);
    release.resolve();
    assert.equal((await creating).status, 503);
    assert.deepEqual(f.processes[0].signals, [9]);
  } finally {
    release.resolve();
    await f.close();
  }
});

test('output backpressure bounds native reads and emits only bounded binary frames', async () => {
  const native = processFixture();
  let reads = 0;
  const stdout = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      controller.enqueue(new Uint8Array(16 * 1024).fill(reads));
      if (reads === 5) controller.close();
    },
  });
  const f = fixture({
    async launch() {
      return { ...native.process, stdout };
    },
  });
  try {
    const id = await create(f);
    native.finish();
    await delay(5);
    assert.ok(reads <= 2);
    const response = await f.request(`/v1/commands/${id}/output`);
    const reader = response.body!.getReader();
    const first = await reader.read();
    await delay(5);
    assert.ok(reads <= 3);
    const chunks = [Buffer.from(first.value!)];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
    reader.releaseLock();
    const frames = Buffer.concat(chunks)
      .toString()
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line));
    assert.equal(frames.length, 6);
    for (const [index, frame] of frames.slice(0, 5).entries()) {
      assert.equal(frame.type, 'stdout');
      assert.deepEqual(Buffer.from(frame.data, 'base64'), Buffer.alloc(16 * 1024, index + 1));
    }
    assert.deepEqual(frames.at(-1), { type: 'exit', code: 0 });
  } finally {
    await f.close();
  }
});

test('cumulative input limits reserve queued bytes before native writes finish', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  try {
    const id = await create(f);
    f.processes[0].beforeInput(async () => {
      entered.resolve();
      await release.promise;
    });
    const pending = f.request(`/v1/commands/${id}/input`, {
      method: 'POST',
      body: new Uint8Array(1024 * 1024 + 1024),
    });
    await entered.promise;
    assert.equal(
      (await f.request(`/v1/commands/${id}/input`, { method: 'POST', body: 'x' })).status,
      413,
    );
    assert.equal(f.registry.uncertain, true);
    release.resolve();
    assert.equal((await pending).status, 503);
  } finally {
    release.resolve();
    await f.close();
  }
});

test('terminal receipt eviction permits more than 1024 sequential commands while durable replay rejection stays safe', async () => {
  const claims = new Set<string>();
  let launched = 0;
  const f = fixture({
    async launch({ id, generation }) {
      const key = `${generation}:${id}`;
      if (claims.has(key)) throw new RuntimeControlError(409);
      claims.add(key);
      launched++;
      const native = processFixture();
      native.finish();
      return native.process;
    },
  });
  let first = '';
  try {
    for (let index = 0; index < 1100; index++) {
      const id = await create(f);
      first ||= id;
      const output = await f.request(`/v1/commands/${id}/output`);
      assert.deepEqual(JSON.parse(await output.text()), { type: 'exit', code: 0 });
    }
    assert.equal((await f.request(`/v1/commands/${first}/output`)).status, 404);
    assert.equal((await f.create(first)).status, 409);
    assert.equal(launched, 1100);
    const next = await create(f);
    const output = await f.request(`/v1/commands/${next}/output`);
    assert.deepEqual(JSON.parse(await output.text()), { type: 'exit', code: 0 });
    assert.equal(launched, 1101);
    assert.equal(f.registry.active, 0);
    assert.equal(f.registry.uncertain, false);
  } finally {
    await f.close();
  }
});

test('terminal metadata expires without retaining process streams or accepting duplicate work', async () => {
  const claims = new Set<string>();
  let launches = 0;
  const f = fixture({
    receiptTimeoutMs: 10,
    async launch({ id }) {
      if (claims.has(id)) throw new RuntimeControlError(409);
      claims.add(id);
      launches++;
      const native = processFixture();
      native.finish();
      return native.process;
    },
  });
  try {
    const id = await create(f);
    const output = await f.request(`/v1/commands/${id}/output`);
    await output.text();
    assert.equal((await f.request(`/v1/commands/${id}/end`, { method: 'POST' })).status, 204);
    assert.equal(
      (
        await f.request(`/v1/commands/${id}/kill`, {
          method: 'POST',
          body: JSON.stringify({ signal: 'SIGKILL' }),
        })
      ).status,
      204,
    );
    assert.equal(
      (await f.request(`/v1/commands/${id}/input`, { method: 'POST', body: 'late' })).status,
      409,
    );
    assert.equal((await f.request(`/v1/commands/${id}/output`)).status, 409);
    await delay(15);
    assert.equal((await f.request(`/v1/commands/${id}/end`, { method: 'POST' })).status, 404);
    assert.equal((await f.create(id)).status, 409);
    assert.equal(launches, 1);
    assert.equal(f.registry.uncertain, false);
    assert.equal(f.uncertain.length, 0);
  } finally {
    await f.close();
  }
});

test('exited commands still occupy capacity until their entire output stream closes', async () => {
  for (const role of ['browser', 'workspace'] as const) {
    const f = fixture({
      role,
      async launch() {
        const native = processFixture();
        native.finish();
        return native.process;
      },
    });
    try {
      const count = role === 'browser' ? 32 : 1;
      const ids = [];
      for (let index = 0; index < count; index++) ids.push(await create(f));
      await delay(5);
      assert.equal(f.registry.active, count);
      assert.equal((await f.create()).status, 409);
      const output = await f.request(`/v1/commands/${ids[0]}/output`);
      assert.deepEqual(JSON.parse(await output.text()), { type: 'exit', code: 0 });
      assert.equal(f.registry.active, count - 1);
      const next = await create(f);
      assert.equal(f.registry.active, count);
      for (const id of [...ids.slice(1), next]) {
        const remaining = await f.request(`/v1/commands/${id}/output`);
        await remaining.text();
      }
      assert.equal(f.registry.active, 0);
    } finally {
      await f.close();
    }
  }
});

test('reading the final frame retains capacity until EOF, which releases it before observer callbacks', async () => {
  const native = processFixture();
  const f = fixture({
    async launch() {
      return native.process;
    },
  });
  try {
    const id = await create(f);
    const output = await f.request(`/v1/commands/${id}/output`);
    const reader = output.body!.getReader();
    native.finish();
    const frame = await reader.read();
    assert.deepEqual(JSON.parse(Buffer.from(frame.value!).toString()), { type: 'exit', code: 0 });
    await delay(5);
    assert.equal(f.registry.active, 1);
    assert.equal((await f.create()).status, 409);
    await reader.read().then(async (next) => {
      assert.equal(next.done, true);
      assert.equal(f.registry.active, 0);
      await f.registry.stop();
      assert.equal(f.uncertain.length, 0);
      assert.deepEqual(native.signals, []);
    });
    reader.releaseLock();
  } finally {
    native.finish();
    await f.close();
  }
});

test('cancelling after the exit frame but before EOF still fences the unacknowledged stream', async () => {
  const native = processFixture();
  const f = fixture({
    async launch() {
      return native.process;
    },
  });
  try {
    const id = await create(f);
    const output = await f.request(`/v1/commands/${id}/output`);
    const reader = output.body!.getReader();
    native.finish();
    assert.equal((await reader.read()).done, false);
    await delay(5);
    await reader.cancel();
    reader.releaseLock();
    assert.equal(f.registry.uncertain, true);
    assert.equal(f.uncertain.length, 1);
    assert.equal(f.registry.active, 0);
    assert.deepEqual(native.signals, [9]);
  } finally {
    native.finish();
    await f.close();
  }
});

test('a durable replay denial after receipt eviction cannot fence a concurrent browser command', async () => {
  const claims = new Set<string>();
  const pendingId = randomUUID();
  const pending = processFixture();
  const f = fixture({
    role: 'browser',
    async launch({ id }) {
      if (claims.has(id)) throw new RuntimeControlError(409);
      claims.add(id);
      if (id === pendingId) return pending.process;
      const native = processFixture();
      native.finish();
      return native.process;
    },
  });
  let first = '';
  try {
    for (let index = 0; index < 33; index++) {
      const id = await create(f);
      first ||= id;
      const output = await f.request(`/v1/commands/${id}/output`);
      await output.text();
    }
    assert.equal((await f.create(pendingId)).status, 201);
    assert.equal((await f.create(first)).status, 409);
    assert.deepEqual(pending.signals, []);
    assert.equal(f.registry.active, 1);
    assert.equal(f.registry.uncertain, false);
    assert.equal(f.uncertain.length, 0);
    pending.finish();
    const output = await f.request(`/v1/commands/${pendingId}/output`);
    assert.deepEqual(JSON.parse(await output.text()), { type: 'exit', code: 0 });
  } finally {
    pending.finish();
    await f.close();
  }
});
