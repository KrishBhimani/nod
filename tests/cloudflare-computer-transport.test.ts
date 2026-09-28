import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { launchCloudflareCommand } from '../src/providers/cloudflare-computer/transport.ts';

const publicError = 'The remote computer connection did not finish safely.';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function frame(type: 'stdout' | 'stderr', data: Uint8Array | string) {
  return JSON.stringify({ type, data: Buffer.from(data).toString('base64') }) + '\n';
}

function launch(options: Partial<Parameters<typeof launchCloudflareCommand>[0]> = {}) {
  let uncertain = 0;
  const errors: Error[] = [];
  const inputErrors: Error[] = [];
  const closes: Array<number | null> = [];
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const completed = deferred<'error' | 'close'>();
  const process = launchCloudflareCommand({
    role: 'browser',
    generation: '17',
    ...options,
    onUncertain: () => {
      uncertain++;
      options.onUncertain?.();
    },
  });
  process.on('error', (error) => {
    errors.push(error);
    completed.resolve('error');
  });
  process.on('close', (code) => {
    closes.push(code);
    completed.resolve('close');
  });
  process.stdin.on('error', (error) => inputErrors.push(error));
  process.stdout.on('data', (bytes: Buffer) => stdout.push(bytes));
  process.stderr.on('data', (bytes: Buffer) => stderr.push(bytes));
  return {
    process,
    errors,
    inputErrors,
    closes,
    stdout,
    stderr,
    completed: completed.promise,
    uncertain: () => uncertain,
  };
}

async function httpFixture(options: { create?: Promise<void>; firstInput?: Promise<void> } = {}) {
  const calls: Array<{
    method: string;
    path: string;
    headers: IncomingHttpHeaders;
    body: Buffer;
  }> = [];
  const output = deferred<ServerResponse>();
  const created = deferred();
  const firstInput = deferred();
  const ended = deferred();
  const killed = deferred();
  let inputs = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const bytes: Buffer[] = [];
      for await (const chunk of request) bytes.push(Buffer.from(chunk));
      const body = Buffer.concat(bytes);
      const path = request.url!;
      calls.push({ method: request.method!, path, headers: request.headers, body });
      if (path === '/v1/commands') {
        created.resolve();
        await options.create;
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: JSON.parse(body.toString()).id }));
      } else if (path.endsWith('/output')) {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.flushHeaders();
        output.resolve(response);
      } else {
        if (path.endsWith('/input')) {
          if (++inputs === 1) {
            firstInput.resolve();
            await options.firstInput;
          }
        }
        response.writeHead(204).end();
        if (path.endsWith('/end')) ended.resolve();
        if (path.endsWith('/kill')) killed.resolve();
      }
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    output: output.promise,
    created: created.promise,
    firstInput: firstInput.promise,
    ended: ended.promise,
    killed: killed.promise,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type FetchStep = (request: Request) => Response | Promise<Response>;

function fetchFixture(
  options: {
    create?: FetchStep;
    input?: FetchStep;
    end?: FetchStep;
    kill?: FetchStep;
    output?: FetchStep;
  } = {},
) {
  const calls: Request[] = [];
  const request: typeof fetch = async (input, init) => {
    const value = new Request(input, init);
    calls.push(value);
    const path = new URL(value.url).pathname;
    if (path === '/v1/commands') {
      if (options.create) return options.create(value);
      return Response.json({ id: (await value.json()).id }, { status: 201 });
    }
    const operation = path.split('/').at(-1)! as 'input' | 'end' | 'kill' | 'output';
    if (options[operation]) return options[operation]!(value);
    if (operation === 'output') return new Response('{"type":"exit","code":0}\n', { status: 200 });
    return new Response(null, { status: 204 });
  };
  return { fetch: request, calls };
}

test(
  'Cloudflare command transport preserves bytes and serializes input across delayed creation',
  { timeout: 5000 },
  async () => {
    const creation = deferred();
    const input = deferred();
    const fixture = await httpFixture({ create: creation.promise, firstInput: input.promise });
    try {
      const command = launch({
        role: 'workspace',
        taskId: 'task-123',
        origin: fixture.origin,
      });
      command.process.stdin.write('héllo ');
      command.process.stdin.write(Buffer.from('🌍'));
      command.process.stdin.end(Buffer.from([0, 255, 10]));
      await fixture.created;
      assert.equal(fixture.calls.length, 1);
      creation.resolve();
      const output = await fixture.output;
      await fixture.firstInput;
      assert.equal(fixture.calls.filter((call) => call.path.endsWith('/input')).length, 1);
      assert.equal(
        fixture.calls.some((call) => call.path.endsWith('/end')),
        false,
      );
      input.resolve();
      await fixture.ended;
      const unicode = Buffer.from('olá 🌍');
      output.write(frame('stdout', unicode.subarray(0, 6)));
      output.write(frame('stdout', unicode.subarray(6)));
      output.write(frame('stderr', 'aviso'));
      output.end('{"type":"exit","code":7}\n');
      assert.equal(await command.completed, 'close');
      assert.deepEqual(command.closes, [7]);
      assert.deepEqual(command.errors, []);
      assert.equal(command.uncertain(), 0);
      assert.deepEqual(Buffer.concat(command.stdout), unicode);
      assert.equal(Buffer.concat(command.stderr).toString(), 'aviso');
      assert.deepEqual(
        Buffer.concat(
          fixture.calls.filter((call) => call.path.endsWith('/input')).map((call) => call.body),
        ),
        Buffer.concat([Buffer.from('héllo 🌍'), Buffer.from([0, 255, 10])]),
      );
      const created = JSON.parse(fixture.calls[0].body.toString());
      assert.deepEqual(Object.keys(created).sort(), ['id', 'role', 'taskId']);
      assert.match(created.id, /^[0-9a-f-]{36}$/);
      assert.equal(created.role, 'workspace');
      assert.equal(created.taskId, 'task-123');
      assert.ok(fixture.calls.every((call) => call.headers['x-otto-generation'] === '17'));
      assert.ok(fixture.calls.slice(1).every((call) => call.path.includes(created.id)));
      assert.equal(command.process.stdin.destroyed, true);
    } finally {
      creation.resolve();
      input.resolve();
      await fixture.close();
    }
  },
);

test(
  'Cloudflare forwards cancellation stdin and separates signal acknowledgement from terminal exit',
  { timeout: 5000 },
  async () => {
    const fixture = await httpFixture();
    try {
      const command = launch({ origin: fixture.origin });
      command.process.stdin.write('{"type":"request","id":"synthetic"}\n');
      command.process.stdin.write('{"type":"cancel","id":"synthetic"}\n');
      const output = await fixture.output;
      command.process.stdin.end();
      await fixture.ended;
      assert.equal(command.process.kill('SIGUSR1'), false);
      assert.equal(command.process.kill('SIGTERM'), true);
      await fixture.killed;
      assert.deepEqual(command.closes, []);
      assert.deepEqual(command.errors, []);
      assert.equal(command.uncertain(), 0);
      const kill = fixture.calls.find((call) => call.path.endsWith('/kill'))!;
      assert.deepEqual(JSON.parse(kill.body.toString()), { signal: 'SIGTERM' });
      assert.equal(
        Buffer.concat(
          fixture.calls.filter((call) => call.path.endsWith('/input')).map((call) => call.body),
        ).toString(),
        '{"type":"request","id":"synthetic"}\n{"type":"cancel","id":"synthetic"}\n',
      );
      output.end('{"type":"exit","code":143}\n');
      assert.equal(await command.completed, 'close');
      assert.deepEqual(command.closes, [143]);
      const count = fixture.calls.length;
      assert.equal(command.process.kill('SIGKILL'), false);
      await new Promise<void>((resolve) => command.process.stdin.end(resolve));
      await delay(10);
      assert.equal(fixture.calls.length, count);
      assert.equal(command.uncertain(), 0);
    } finally {
      await fixture.close();
    }
  },
);

test(
  'Cloudflare rejects malformed, oversized, missing and trailing output without a clean close',
  { timeout: 10000 },
  async (t) => {
    const cases: Array<[string, () => Response]> = [
      ['malformed JSON', () => new Response('synthetic private contents\n')],
      ['invalid UTF-8', () => new Response(new Uint8Array([255, 10]))],
      ['oversized line', () => new Response('x'.repeat(22_001))],
      ['oversized chunk', () => new Response(frame('stdout', Buffer.alloc(16 * 1024 + 1)))],
      ['invalid base64', () => new Response('{"type":"stdout","data":"secret!"}\n')],
      ['noncanonical base64', () => new Response('{"type":"stdout","data":"YR=="}\n')],
      ['extra fields', () => new Response('{"type":"exit","code":0,"private":"value"}\n')],
      ['noninteger exit', () => new Response('{"type":"exit","code":1.5}\n')],
      ['missing exit', () => new Response(frame('stdout', 'partial'))],
      ['missing newline', () => new Response('{"type":"exit","code":0}')],
      ['trailing bytes', () => new Response('{"type":"exit","code":0}\nprivate')],
      [
        'trailing frame',
        () => new Response('{"type":"exit","code":0}\n' + frame('stdout', 'late')),
      ],
      ['failed HTTP', () => new Response('synthetic private contents', { status: 503 })],
      [
        'lost stream',
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('synthetic secret'));
              },
            }),
          ),
      ],
    ];
    for (const [name, response] of cases) {
      await t.test(name, async () => {
        const fixture = fetchFixture({ output: response });
        const command = launch({ fetch: fixture.fetch });
        assert.equal(await command.completed, 'error');
        await delay(0);
        assert.equal(command.uncertain(), 1);
        assert.deepEqual(
          command.errors.map((error) => error.message),
          [publicError],
        );
        assert.deepEqual(command.closes, []);
        assert.equal(command.process.stdin.destroyed, true);
        assert.equal(fixture.calls.length, 2);
      });
    }
  },
);

test(
  'Cloudflare normalizes creation and control failures without retries',
  { timeout: 10000 },
  async (t) => {
    for (const name of [
      'creation throw',
      'creation status',
      'creation identity',
      'creation limit',
      'input',
      'end',
      'kill',
    ] as const) {
      await t.test(name, async () => {
        const output = deferred<Response>();
        const fixture = fetchFixture({
          create:
            name === 'creation throw'
              ? () => {
                  throw new Error('synthetic server secret');
                }
              : name === 'creation status'
                ? () => Response.json({ id: 'private' })
                : name === 'creation identity'
                  ? () => Response.json({ id: 'wrong' }, { status: 201 })
                  : name === 'creation limit'
                    ? () => new Response('x'.repeat(1025), { status: 201 })
                    : undefined,
          output: () => output.promise,
          input:
            name === 'input' ? () => new Response('synthetic secret', { status: 500 }) : undefined,
          end: name === 'end' ? () => new Response('synthetic secret', { status: 200 }) : undefined,
          kill:
            name === 'kill'
              ? () => {
                  throw new Error('synthetic server secret');
                }
              : undefined,
        });
        const command = launch({
          fetch: fixture.fetch,
          onUncertain: () => {
            throw new Error('synthetic callback secret');
          },
        });
        const callbacks: Array<string | undefined> = [];
        if (name === 'input')
          command.process.stdin.write('private input', (error) => callbacks.push(error?.message));
        if (name === 'end') command.process.stdin.end();
        if (name === 'kill') command.process.kill('SIGKILL');
        assert.equal(await command.completed, 'error');
        output.resolve(new Response('{"type":"exit","code":0}\n'));
        await delay(0);
        assert.deepEqual(
          command.errors.map((error) => error.message),
          [publicError],
        );
        assert.deepEqual(command.closes, []);
        assert.equal(command.uncertain(), 1);
        if (name === 'input') assert.deepEqual(callbacks, [publicError]);
        for (const path of new Set(fixture.calls.map((call) => new URL(call.url).pathname)))
          assert.equal(
            fixture.calls.filter((call) => new URL(call.url).pathname === path).length,
            1,
          );
      });
    }
  },
);

test(
  'Cloudflare bounds queued input while command creation is pending',
  { timeout: 5000 },
  async () => {
    const creation = deferred<Response>();
    const fixture = fetchFixture({ create: () => creation.promise });
    const command = launch({ fetch: fixture.fetch });
    const callbacks: Array<string | undefined> = [];
    command.process.stdin.write(Buffer.alloc(1024 * 1024), (error) =>
      callbacks.push(error?.message),
    );
    command.process.stdin.write(Buffer.alloc(1025), (error) => callbacks.push(error?.message));
    assert.equal(await command.completed, 'error');
    creation.resolve(new Response('synthetic failure', { status: 503 }));
    await delay(0);
    assert.equal(command.uncertain(), 1);
    assert.deepEqual(command.closes, []);
    assert.ok(callbacks.length >= 1);
    assert.ok(callbacks.every((message) => message === publicError));
    assert.ok(fixture.calls.every((call) => new URL(call.url).pathname === '/v1/commands'));
  },
);

test(
  'Cloudflare bounds total decoded output and never treats a disconnected stdin as completion',
  { timeout: 10000 },
  async (t) => {
    await t.test('total output', async () => {
      let frames = 0;
      const chunk = Buffer.from(frame('stdout', Buffer.alloc(16 * 1024)));
      const fixture = fetchFixture({
        output: () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                if (++frames <= 2049) controller.enqueue(chunk);
                else controller.close();
              },
            }),
          ),
      });
      const command = launch({ fetch: fixture.fetch });
      assert.equal(await command.completed, 'error');
      assert.equal(command.uncertain(), 1);
      assert.equal(Buffer.concat(command.stdout).length, 32 * 1024 * 1024);
      assert.deepEqual(command.closes, []);
    });
    await t.test('stdin disconnect', async () => {
      const fixture = fetchFixture();
      const command = launch({ fetch: fixture.fetch });
      command.process.stdin.destroy(new Error('synthetic private error'));
      assert.equal(await command.completed, 'error');
      assert.equal(command.uncertain(), 1);
      assert.deepEqual(
        command.errors.map((error) => error.message),
        [publicError],
      );
      assert.deepEqual(command.closes, []);
    });
  },
);

test(
  'Cloudflare waits for input acknowledgement even when output has ended',
  { timeout: 5000 },
  async (t) => {
    for (const succeeds of [true, false]) {
      await t.test(succeeds ? 'acknowledged input' : 'failed input', async () => {
        const input = deferred<Response>();
        const inputStarted = deferred();
        const fixture = fetchFixture({
          input: () => {
            inputStarted.resolve();
            return input.promise;
          },
        });
        const command = launch({ fetch: fixture.fetch });
        command.process.stdin.write('synthetic input');
        await inputStarted.promise;
        await delay(0);
        assert.deepEqual(command.closes, []);
        assert.deepEqual(command.errors, []);
        input.resolve(new Response(null, { status: succeeds ? 204 : 503 }));
        assert.equal(await command.completed, succeeds ? 'close' : 'error');
        assert.equal(command.uncertain(), succeeds ? 0 : 1);
      });
    }
  },
);

test(
  'Cloudflare ignores failed end and kill responses after an acknowledged terminal exit',
  { timeout: 5000 },
  async (t) => {
    for (const operation of ['end', 'kill'] as const) {
      await t.test(operation, async () => {
        const control = deferred<Response>();
        const started = deferred();
        let output!: ReadableStreamDefaultController<Uint8Array>;
        const fixture = fetchFixture({
          [operation]: () => {
            started.resolve();
            return control.promise;
          },
          output: () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  output = controller;
                },
              }),
            ),
        });
        const command = launch({ fetch: fixture.fetch });
        if (operation === 'end') command.process.stdin.end();
        else command.process.kill('SIGKILL');
        await started.promise;
        output.enqueue(Buffer.from('{"type":"exit","code":0}\n'));
        output.close();
        assert.equal(await command.completed, 'close');
        control.reject(new Error('synthetic late secret'));
        await delay(0);
        assert.equal(command.uncertain(), 0);
        assert.deepEqual(command.errors, []);
        assert.deepEqual(command.closes, [0]);
      });
    }
  },
);

test(
  'Cloudflare parses split frames and rejects a real HTTP disconnect before terminal exit',
  { timeout: 5000 },
  async (t) => {
    await t.test('split stream frames', async () => {
      const text = frame('stdout', 'olá') + '{"type":"exit","code":0}\n';
      let position = 0;
      const fixture = fetchFixture({
        output: () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                if (position < text.length)
                  controller.enqueue(Buffer.from(text.slice(position, ++position)));
                else controller.close();
              },
            }),
          ),
      });
      const command = launch({ fetch: fixture.fetch });
      assert.equal(await command.completed, 'close');
      assert.equal(Buffer.concat(command.stdout).toString(), 'olá');
    });
    await t.test('HTTP disconnect', async () => {
      const fixture = await httpFixture();
      try {
        const command = launch({ origin: fixture.origin });
        const output = await fixture.output;
        output.write(frame('stdout', 'partial'));
        output.destroy();
        assert.equal(await command.completed, 'error');
        assert.equal(command.uncertain(), 1);
        assert.deepEqual(
          command.errors.map((error) => error.message),
          [publicError],
        );
        assert.deepEqual(command.closes, []);
      } finally {
        await fixture.close();
      }
    });
  },
);

test('Cloudflare binds immutable configuration and clears deadlines after terminal completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = fetchFixture();
  let uncertain = 0;
  const options = {
    role: 'browser' as const,
    generation: '8',
    fetch: fixture.fetch,
    onUncertain: () => uncertain++,
  };
  const command = launchCloudflareCommand(options);
  const complete = new Promise<void>((resolve, reject) => {
    command.on('close', () => resolve());
    command.on('error', reject);
  });
  options.generation = '9';
  await complete;
  await Promise.resolve();
  t.mock.timers.tick(200_000);
  assert.equal(uncertain, 0);
  assert.ok(fixture.calls.every((call) => call.headers.get('x-otto-generation') === '8'));
  assert.ok(fixture.calls.every((call) => call.redirect === 'error'));
});

test('Cloudflare rejects unsupported origins, identities and task paths before contacting transport', () => {
  const invalid: Array<Partial<Parameters<typeof launchCloudflareCommand>[0]>> = [
    { origin: 'https://otto.computer' },
    { origin: 'http://otto.computer:8080' },
    { origin: 'http://example.test' },
    { origin: 'http://user:password@localhost' },
    { origin: 'http://localhost/path' },
    { origin: 'http://localhost/?secret=value' },
    { origin: 'http://localhost/#private' },
    { generation: '0' },
    { generation: '-1' },
    { generation: '01' },
    { role: 'workspace' },
    { role: 'workspace', taskId: '../private' },
  ];
  for (const value of invalid) {
    assert.throws(
      () =>
        launchCloudflareCommand({ role: 'browser', generation: '1', onUncertain() {}, ...value }),
      { message: 'The remote computer configuration is invalid.' },
    );
  }
});
