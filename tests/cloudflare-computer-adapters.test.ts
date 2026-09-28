import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { Computer } from '../src/ports/computer.ts';
import type { CommandProcess } from '../src/providers/command-process.ts';
import { createCloudflareAdapters } from '../src/providers/cloudflare-computer/index.ts';
import { runBrowserBridge } from '../src/providers/container-browser/bridge.ts';
import { startContainerBrowserWorker } from '../src/providers/container-browser/worker.ts';
import { runSupervisedCommand, workspaceCommandProgram } from '../src/providers/docker/command.ts';

const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const namespace = (owner: string) =>
  `sk-${createHash('sha256').update(owner).digest('hex').slice(0, 24)}`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const root = await mkdtemp('/tmp/otto-cloudflare-adapters-');
  const socketPath = join(root, 'control.sock');
  const calls: Array<{ namespace: string; method: string; input?: unknown }> = [];
  const launches: Array<{
    owner: string;
    role: string;
    generation: string;
    taskId?: string;
    frames: string[];
  }> = [];
  let hold:
    { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  let failedDisposals = 0;
  let brokenRole: 'browser' | 'workspace' | undefined;
  const worker = await startContainerBrowserWorker({
    socketPath,
    dataRoot: root,
    createComputer: (directory) => {
      const selected = basename(directory);
      return {
        status: () => 'Synthetic browser',
        act: async (_taskId, input, signal) => {
          calls.push({ namespace: selected, method: 'act', input });
          if (hold) {
            const waiting = hold;
            waiting.entered.resolve();
            await new Promise<void>((resolve) =>
              signal?.addEventListener('abort', () => resolve(), { once: true }),
            );
            await waiting.release.promise;
            throw new Error('Synthetic cancellation');
          }
          return { text: selected, url: input.url ?? 'https://example.test/', candidates: [] };
        },
        screenshot: async () => Buffer.from(selected),
        injectCredentials: async (input) => {
          calls.push({ namespace: selected, method: 'credentials', input });
          return { status: 'submitted' };
        },
        inspectLogin: async () => ({
          origin: 'https://example.test',
          url: 'https://example.test/',
          fields: [],
          methods: [],
        }),
        selectLoginMethod: async () => {},
        hold: async () => {},
        close: async () => {},
        dispose: async () => {
          calls.push({ namespace: selected, method: 'dispose' });
          if (failedDisposals > 0) {
            failedDisposals--;
            throw new Error('Synthetic private cleanup failure');
          }
        },
      } satisfies Computer;
    },
  });
  const options = (ownerId: string) => ({
    ownerId,
    generation: '17',
    workspaceRoot: join(root, 'roots', ownerId),
    drainTimeoutMs: 500,
    launch: ((input) => {
      const record = {
        owner: ownerId,
        role: input.role,
        generation: input.generation,
        taskId: input.taskId,
        frames: [] as string[],
      };
      launches.push(record);
      if (brokenRole === input.role) {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => true,
        });
        queueMicrotask(() => {
          input.onUncertain();
          child.emit('error', new Error('Synthetic private transport detail'));
        });
        return child as CommandProcess;
      }
      if (input.role === 'workspace') {
        assert.ok(input.taskId);
        const directory = join(root, 'workspaces', ownerId, input.taskId);
        mkdirSync(directory, { recursive: true });
        const child = spawn('python3', ['-u', '-c', workspaceCommandProgram], {
          cwd: directory,
          env: { PATH: process.env.PATH },
          stdio: 'pipe',
        });
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((chunk: Buffer | string, ...args: unknown[]) => {
          record.frames.push(chunk.toString());
          return Reflect.apply(write, child.stdin, [chunk, ...args]);
        }) as typeof child.stdin.write;
        return child;
      }
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {
          this.stdin.destroy();
          return true;
        },
      });
      child.stdin.on('data', (chunk: Buffer) => record.frames.push(chunk.toString()));
      void runBrowserBridge({ input: child.stdin, output: child.stdout, socketPath }).then(
        (code) => {
          child.stdout.end();
          child.stderr.end();
          child.emit('close', code);
        },
      );
      return child as CommandProcess;
    }) satisfies NonNullable<Parameters<typeof createCloudflareAdapters>[0]['launch']>,
  });
  return {
    root,
    calls,
    launches,
    options,
    hold() {
      hold = { entered: deferred(), release: deferred() };
      return hold;
    },
    failDisposal() {
      failedDisposals++;
    },
    breakRole(role?: 'browser' | 'workspace') {
      brokenRole = role;
    },
    async close() {
      hold?.release.resolve();
      await worker.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Cloudflare adapters bind owner namespaces and generations while keeping browser and workspace traffic separate', async () => {
  const f = await fixture();
  const input = f.options(ownerA);
  const a = createCloudflareAdapters(input);
  const b = createCloudflareAdapters(f.options(ownerB));
  input.ownerId = ownerB;
  input.generation = '99';
  try {
    assert.equal(
      (await a.computer.act('same-task', { action: 'open', url: 'https://example.test/' })).text,
      namespace(ownerA),
    );
    assert.equal(
      (await b.computer.act('same-task', { action: 'snapshot' })).text,
      namespace(ownerB),
    );
    await a.computer.injectCredentials({
      taskId: 'same-task',
      origin: 'https://example.test',
      password: 'synthetic-browser-only',
    });
    const session = (adapters: typeof a, owner: string) =>
      adapters.workspace.open({
        taskId: 'same-task',
        workspacePath: join(f.root, 'roots', owner, 'same-task'),
        signal: new AbortController().signal,
      });
    await session(a, ownerA).execute('printf owner-a > retained');
    assert.equal(
      await session(b, ownerB).execute('test ! -e retained && printf owner-b'),
      'owner-b',
    );
    assert.equal(await session(a, ownerA).execute('cat retained'), 'owner-a');
    assert.ok(f.launches.every((call) => call.generation === '17'));
    assert.ok(
      f.launches
        .filter((call) => call.role === 'workspace')
        .every(
          (call) =>
            call.taskId === 'same-task' && !call.frames.join('').includes('synthetic-browser-only'),
        ),
    );
    assert.equal(
      f.calls.find((call) => call.method === 'credentials')?.namespace,
      namespace(ownerA),
    );
    assert.throws(
      () =>
        a.workspace.open({
          taskId: 'same-task',
          workspacePath: join(f.root, 'roots', ownerB, 'same-task'),
          signal: new AbortController().signal,
        }),
      /configured root/,
    );
  } finally {
    await Promise.all([
      a.computer.dispose(),
      b.computer.dispose(),
      a.workspace.dispose(),
      b.workspace.dispose(),
    ]);
    await f.close();
  }
});

test('browser disposal drains cancelled work and failed cleanup remains retryable', async () => {
  const f = await fixture();
  const adapters = createCloudflareAdapters(f.options(ownerA));
  const held = f.hold();
  const rejected = assert.rejects(
    adapters.computer.act('task', { action: 'snapshot' }),
    /cancelled/,
  );
  try {
    await held.entered.promise;
    f.failDisposal();
    let settled = false;
    const first = assert.rejects(adapters.computer.dispose(), /could not complete/).finally(() => {
      settled = true;
    });
    await delay(20);
    assert.equal(settled, false);
    held.release.resolve();
    await rejected;
    await first;
    await adapters.computer.dispose();
    const launches = f.launches.length;
    await assert.rejects(adapters.computer.act('later', { action: 'snapshot' }), /unavailable/);
    assert.equal(f.launches.length, launches);
    assert.equal(f.calls.filter((call) => call.method === 'dispose').length, 2);
  } finally {
    held.release.resolve();
    await adapters.workspace.dispose();
    await f.close();
  }
});

test('unused disposal never creates computers and uncertain workspace traffic stays fenced', async () => {
  const f = await fixture();
  const unused = createCloudflareAdapters(f.options(ownerA));
  await Promise.all([unused.computer.dispose(), unused.workspace.dispose()]);
  assert.equal(f.launches.length, 0);
  const adapters = createCloudflareAdapters(f.options(ownerB));
  const session = adapters.workspace.open({
    taskId: 'task',
    workspacePath: join(f.root, 'roots', ownerB, 'task'),
    signal: new AbortController().signal,
  });
  try {
    f.breakRole('workspace');
    await assert.rejects(session.execute('printf first'), /did not stop safely/);
    await assert.rejects(session.execute('printf second'), /Restart Otto/);
    assert.equal(f.launches.length, 1);
    f.breakRole();
    assert.equal(
      (await adapters.computer.act('task', { action: 'snapshot' })).text,
      namespace(ownerB),
    );
  } finally {
    await Promise.all([adapters.computer.dispose(), adapters.workspace.dispose()]);
    await f.close();
  }
});

test('Cloudflare adapters reject invalid immutable identities before launching', () => {
  for (const change of [
    { ownerId: 'local-development' },
    { generation: '' },
    { generation: '0' },
    { generation: '-1' },
    { generation: '1.5' },
  ])
    assert.throws(
      () =>
        createCloudflareAdapters({
          ownerId: ownerA,
          generation: '17',
          workspaceRoot: '/synthetic',
          ...change,
        }),
      { message: 'The remote computer configuration is invalid.' },
    );
});

for (const heldWrite of [false, true]) {
  test(`workspace transport grace preserves the actual command budget with ${heldWrite ? 'a held initial write' : 'a delayed terminal acknowledgement'}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const writes: string[] = [];
    let written: (() => void) | undefined;
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          writes.push(chunk.toString());
          if (heldWrite && writes.length === 1) written = callback;
          else callback();
        },
      }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    const operation = runSupervisedCommand({
      args: ['printf', 'synthetic'],
      timeoutMs: 999_000,
      transportGraceMs: 300_000,
      launch: () => child as CommandProcess,
    });
    assert.equal(JSON.parse(writes[0]).timeoutMs, 120_000);
    t.mock.timers.tick(121_001);
    assert.equal(writes.length, 1);
    written?.();
    t.mock.timers.tick(100_000);
    assert.equal(writes.length, 1);
    child.stdout.write('{"type":"exit","code":0,"reason":null}\n');
    child.emit('close', 0);
    assert.equal((await operation).exitCode, 0);
  });
}

test('workspace transport grace is bounded and eventually requires a drained terminal acknowledgement', async (t) => {
  for (const transportGraceMs of [-1, 300_001, 1.5, Infinity])
    assert.throws(
      () =>
        runSupervisedCommand({
          args: ['true'],
          transportGraceMs,
          launch: () => assert.fail('Invalid grace must not launch.'),
        }),
      /grace period/,
    );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  const writes: string[] = [];
  child.stdin.on('data', (chunk: Buffer) => writes.push(chunk.toString()));
  const rejected = assert.rejects(
    runSupervisedCommand({
      args: ['true'],
      timeoutMs: 10,
      transportGraceMs: 50,
      drainTimeoutMs: 20,
      launch: () => child as CommandProcess,
    }),
    /did not stop safely/,
  );
  t.mock.timers.tick(1060);
  assert.equal(writes[1], '{"type":"cancel"}\n');
  t.mock.timers.tick(20);
  await rejected;
});

test('application composition selects Cloudflare only in tenant mode and binds both brokers to the process generation', () => {
  const base = new URL('../src/', import.meta.url).href;
  for (const mode of ['local', 'tenant'] as const) {
    const script = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      const modules = new Map([
        [${JSON.stringify(base + 'providers/cloudflare-computer/index.ts')}, 'export const createCloudflareAdapters=(options)=>{globalThis.computerOptions=options;return {computer:{status:()=>"cloudflare"},workspace:{status:()=>"cloudflare"}}}'],
        [${JSON.stringify(base + 'providers/object-storage/http.ts')}, 'export const createHttpObjectStore=(options)=>{globalThis.storageOptions=options;return {}}'],
      ]);
      registerHooks({load(url, context, next){const source=modules.get(url);return source===undefined?next(url,context):{format:'module',source,shortCircuit:true}}});
      globalThis.fetch=()=>{throw new Error('Unexpected provider request')};
      const {createDefaultAdapters}=await import(${JSON.stringify(base + 'server/composition.ts')});
      const environment={...process.env,COMPUTER_PROVIDER:'cloudflare',OTTO_RUNTIME_GENERATION:'999',OBJECT_STORAGE_PROVIDER:'http',OBJECT_STORAGE_ENDPOINT:'http://otto.storage/v1/objects/',OTTO_CONTROL_URL:'http://otto.control'};
      if(${JSON.stringify(mode)}==='local')assert.throws(()=>createDefaultAdapters(environment),/isolated computer provider/);
      else {const adapters=createDefaultAdapters(environment);assert.equal(adapters.computer.status(),'cloudflare');assert.equal(globalThis.computerOptions.generation,'17');assert.equal(globalThis.computerOptions.ownerId,${JSON.stringify(ownerA)});assert.equal(globalThis.storageOptions.generation,'17');assert.equal(globalThis.computerOptions.origin,undefined);}
      process.stdout.write('composition passed');
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          DOTENV_CONFIG_PATH: '/tmp/otto-synthetic-missing-env',
          OTTO_MODE: mode,
          OTTO_OWNER_ID: ownerA,
          OTTO_ENVIRONMENT: 'development',
          OTTO_RUNTIME_GENERATION: '17',
          OTTO_RUNTIME_SECRET: Buffer.alloc(32, 1).toString('base64url'),
          OTTO_VAULT_KEY: Buffer.alloc(32, 2).toString('base64'),
          OTTO_DATA_ROOT: '/tmp/otto-synthetic-composition',
          DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
          PGBOSS_SCHEMA: 'sk_jobs_' + 'a'.repeat(32),
        },
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'composition passed');
  }
});
