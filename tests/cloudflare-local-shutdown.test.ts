import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createDeploymentVerifier } from '../src/server/deployment-auth.ts';
import {
  createDeploymentBarrier,
  type DeploymentState,
} from '../deployment/cloudflare/src/deployment-barrier.ts';

const { assertLocalCloudflarePortFree, openLocalCloudflareControl, superviseLocalCloudflare } =
  await import(new URL('../scripts/cloudflare-local-control.mjs', import.meta.url).href);
const { startHosted } = await import(new URL('../scripts/start-hosted.mjs', import.meta.url).href);
const { startCloudflareLocal } = await import(
  new URL('../scripts/start-cloudflare-local.mjs', import.meta.url).href
);
const failure = /Local Cloudflare control could not confirm a safe state/;

test('the local listener guard refuses an occupied port and leaves its service untouched', async () => {
  const server = createServer((_request, response) => response.end('synthetic listener'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  try {
    await assert.rejects(assertLocalCloudflarePortFree(port), failure);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'synthetic listener');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((complete) => server.close(() => complete()));
  }
  await assertLocalCloudflarePortFree(port);
});

test('local startup removes its partial secret write but preserves secrets it cannot own', async (t) => {
  for (const condition of ['partial', 'occupied', 'locked'] as const) {
    await t.test(condition, async (subtest) => {
      const root = await mkdtemp(join(tmpdir(), 'sidekick-startup-secret-'));
      let existing: { close(): Promise<void> } | undefined;
      subtest.after(async () => {
        await existing?.close();
        await rm(root, { recursive: true, force: true });
      });
      const directory = join(root, '.local/cloudflare-development');
      const packageDirectory = join(root, 'deployment/cloudflare');
      await mkdir(join(packageDirectory, 'node_modules/wrangler/bin'), { recursive: true });
      await mkdir(join(root, 'dist/web'), { recursive: true });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(packageDirectory, 'node_modules/wrangler/bin/wrangler.js'), '');
      await writeFile(join(root, 'dist/web/index.html'), 'synthetic');
      await writeFile(
        join(packageDirectory, 'wrangler.jsonc'),
        JSON.stringify({
          main: 'src/worker.ts',
          assets: { directory: '../../dist/web' },
          env: {
            development: {
              containers: [
                {
                  class_name: 'GatewayContainer',
                  image: './Dockerfile',
                  image_build_context: '../..',
                },
              ],
            },
          },
        }),
      );
      const environment = {
        COMPUTER_PROVIDER: 'cloudflare',
        SIDEKICK_ENVIRONMENT: 'development',
        SIDEKICK_PUBLIC_URL: 'http://localhost:4330',
        DATABASE_URL: 'postgresql://fixture:synthetic@localhost:54331/local',
        SIDEKICK_MASTER_KEY: randomBytes(32).toString('base64'),
      };
      const secretFile = join(directory, '.dev.vars');
      const preserved = 'GATEWAY_ENV=synthetic-existing-runtime\n';
      await writeFile(secretFile, preserved, { mode: 0o600 });
      const listener = createServer((_request, response) => response.end('synthetic listener'));
      listener.listen(0, '127.0.0.1');
      await once(listener, 'listening');
      const port = (listener.address() as AddressInfo).port;
      subtest.after(async () => {
        listener.closeAllConnections();
        await new Promise<void>((complete) => listener.close(() => complete()));
      });
      existing =
        condition === 'locked'
          ? await openLocalCloudflareControl(directory, environment)
          : undefined;
      const lockFile = join(directory, 'launcher.lock');
      const originalLock = existing ? await readFile(lockFile, 'utf8') : undefined;
      let attemptedWrite = false;
      let checkedPort = false;
      await assert.rejects(
        startCloudflareLocal(environment, {
          root,
          assertPortFree: async () => {
            checkedPort = true;
            if (condition === 'occupied') await assertLocalCloudflarePortFree(port);
          },
          writeSecret: async (path: string, value: string) => {
            attemptedWrite = true;
            assert.equal(path, secretFile);
            await writeFile(path, value.slice(0, 24), { mode: 0o600 });
            throw new Error('Synthetic partial write failure.');
          },
        }),
        condition === 'partial' ? /Synthetic partial write failure/ : failure,
      );
      assert.equal(attemptedWrite, condition === 'partial');
      assert.equal(checkedPort, condition !== 'locked');
      if (condition === 'partial') {
        await assert.rejects(readFile(secretFile), { code: 'ENOENT' });
      } else {
        assert.equal(await readFile(secretFile, 'utf8'), preserved);
      }
      if (existing) assert.equal(await readFile(lockFile, 'utf8'), originalLock);
      else await assert.rejects(readFile(lockFile), { code: 'ENOENT' });
    });
  }
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-local-shutdown-'));
  await chmod(directory, 0o700);
  const environment = {
    COMPUTER_PROVIDER: 'cloudflare',
    SIDEKICK_ENVIRONMENT: 'development',
    SIDEKICK_PUBLIC_URL: 'http://localhost:4330',
    DATABASE_URL: 'postgresql://fixture:synthetic@localhost:54331/local',
    SIDEKICK_MASTER_KEY: randomBytes(32).toString('base64'),
  };
  const hooks = {
    prepare: async () => [{ ownerId: randomUUID(), generation: '2' }],
    abort: async () => {},
    losePrepare: false,
    healthRelease: undefined as string | undefined,
    reply: undefined as ((action: string, result: unknown) => unknown) | undefined,
  };
  let state: DeploymentState | undefined;
  let release = '';
  let barrier: ReturnType<typeof createDeploymentBarrier>;
  const actions: string[] = [];
  const claims: string[] = [];
  const verify = createDeploymentVerifier({
    masterKey: Buffer.from(environment.SIDEKICK_MASTER_KEY, 'base64'),
    environment: environment.SIDEKICK_ENVIRONMENT,
  });
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/health') {
      response.end(JSON.stringify({ ok: true, release: hooks.healthRelease ?? release }));
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const token = request.headers['x-sidekick-deployment'];
      const input = await verify(token, request.method!, request.url!, body);
      claims.push(String(token));
      actions.push(input.action);
      if (input.action === 'prepare') {
        const journal = JSON.parse(await readFile(join(directory, 'local-shutdown.json'), 'utf8'));
        assert.equal(journal.operation.nonce, input.nonce);
        assert.equal(journal.prepared, null);
      }
      const result = await barrier.handle(
        input,
        new Request('http://localhost:4330/api/deployment', { method: 'POST', body }),
      );
      if (input.action === 'prepare' && hooks.losePrepare) {
        response.destroy();
        return;
      }
      response.end(JSON.stringify(hooks.reply?.(input.action, result) ?? result));
    } catch {
      response.writeHead(503);
      response.end(JSON.stringify({ error: 'Synthetic private failure.' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const fetcher: typeof fetch = (url, init) => {
    assert.equal(new URL(String(url)).origin, 'http://localhost:4330');
    return fetch(`http://127.0.0.1:${address.port}${new URL(String(url)).pathname}`, init);
  };
  const controllers: Array<{ close(): Promise<void> }> = [];
  const openControl = async (resume = false, overrides = {}) => {
    const control = await openLocalCloudflareControl(directory, environment, {
      resume,
      fetcher,
      readinessMs: 1000,
      requestMs: 1000,
      intervalMs: 1,
      ...overrides,
    });
    release = control.release;
    controllers.push(control);
    barrier ??= createDeploymentBarrier({
      read: async () => state,
      write: async (value) => {
        state = value;
      },
      currentRelease: release,
      prepare: () => hooks.prepare(),
      resume: () => hooks.abort(),
    });
    return control;
  };
  t.after(async () => {
    await Promise.allSettled(controllers.map((control) => control.close()));
    server.closeAllConnections();
    await new Promise<void>((complete) => server.close(() => complete()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    environment,
    hooks,
    actions,
    claims,
    fetcher,
    open: openControl,
    state: () => state!,
    setState: (value: DeploymentState) => {
      state = value;
    },
  };
}

test('local shutdown signs a durable exact operation and reopens only the same prepared operation after restart', async (t) => {
  const f = await fixture(t);
  const first = await f.open();
  await first.recover();
  await first.prepare();
  assert.equal(f.state().phase, 'prepared');
  assert.equal(f.state().previousRelease, first.release);
  assert.equal(f.state().targetRelease, first.release);
  const journal = JSON.parse(await readFile(join(f.directory, 'local-shutdown.json'), 'utf8'));
  assert.deepEqual(journal.prepared, f.state());
  assert.equal((await stat(join(f.directory, 'local-shutdown.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.directory, 'local-installation.json'))).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(journal), /synthetic|postgresql|MASTER_KEY/);
  const concurrent = await f.open(true);
  await assert.rejects(concurrent.resume(), failure);
  assert.equal(f.state().phase, 'prepared');
  await first.close();
  const next = await f.open();
  assert.equal(next.release, first.release);
  await next.recover();
  assert.equal(f.state().phase, 'aborted');
  await assert.rejects(readFile(join(f.directory, 'local-shutdown.json')), { code: 'ENOENT' });
  assert.deepEqual(f.actions, ['status', 'status', 'prepare', 'status', 'abort']);
  assert.equal(new Set(f.claims).size, f.claims.length);
});

test('local recovery retries timed-out health headers and bodies within its readiness budget', async (t) => {
  for (const condition of ['headers', 'body'] as const) {
    await t.test(condition, async (subtest) => {
      const f = await fixture(subtest);
      const late = deferred<Response>();
      let healthCalls = 0;
      let firstSignal: AbortSignal | undefined;
      const cancelled = deferred();
      const stalled = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ok":'));
          },
          cancel() {
            cancelled.resolve();
          },
        }),
      );
      const control = await f.open(false, {
        requestMs: 100,
        readinessMs: 2000,
        fetcher: (url: URL, init: RequestInit) => {
          if (url.pathname === '/api/health' && ++healthCalls === 1) {
            firstSignal = init.signal ?? undefined;
            return condition === 'headers' ? late.promise : Promise.resolve(stalled);
          }
          return f.fetcher(url, init);
        },
      });
      try {
        await control.recover();
        assert.equal(healthCalls, 2);
        assert.equal(firstSignal?.aborted, true);
        assert.deepEqual(f.actions, ['status']);
        if (condition === 'headers') late.resolve(stalled);
        await cancelled.promise;
      } finally {
        late.resolve(stalled);
      }
    });
  }
});

test('health retries stop at the readiness deadline and explicit cancellation never retries', async (t) => {
  for (const condition of ['deadline', 'cancel'] as const) {
    await t.test(condition, async (subtest) => {
      const f = await fixture(subtest);
      const entered = deferred();
      let calls = 0;
      const control = await f.open(false, {
        requestMs: 30,
        readinessMs: 120,
        fetcher: () => {
          calls++;
          entered.resolve();
          return new Promise(() => {});
        },
      });
      const recovering = control.recover();
      await entered.promise;
      if (condition === 'cancel') control.cancel();
      await assert.rejects(recovering, {
        name: 'Error',
        message: 'Local Cloudflare control could not confirm a safe state.',
      });
      if (condition === 'cancel') assert.equal(calls, 1);
      else assert.ok(calls > 1 && calls <= 4);
      assert.deepEqual(f.actions, []);
      await assert.rejects(readFile(join(f.directory, 'local-shutdown.json')), { code: 'ENOENT' });
    });
  }
});

test('lost prepared response preserves intent and a restart resolves only its exact durable state', async (t) => {
  const f = await fixture(t);
  const first = await f.open();
  f.hooks.losePrepare = true;
  await assert.rejects(first.prepare(), failure);
  assert.equal(f.state().phase, 'prepared');
  assert.equal(
    JSON.parse(await readFile(join(f.directory, 'local-shutdown.json'), 'utf8')).prepared,
    null,
  );
  await assert.rejects(first.prepare(), failure);
  assert.equal(f.actions.filter((action) => action === 'prepare').length, 1);
  await first.close();
  const next = await f.open();
  await next.recover();
  assert.equal(f.state().phase, 'aborted');
});

test('restart may abort an expired prepared operation without replacing its nonce or deadline', async (t) => {
  const f = await fixture(t);
  const first = await f.open();
  await first.prepare();
  await first.close();
  const file = join(f.directory, 'local-shutdown.json');
  const journal = JSON.parse(await readFile(file, 'utf8'));
  const expired = Date.now() - 1000;
  journal.operation.deadline = expired;
  journal.prepared.deadline = expired;
  f.setState({ ...f.state(), deadline: expired });
  await writeFile(file, JSON.stringify(journal), { mode: 0o600 });
  const next = await f.open();
  await next.recover();
  assert.equal(f.state().phase, 'aborted');
  assert.equal(f.state().deadline, expired);
  assert.equal(f.state().nonce, journal.operation.nonce);
});

test('oversized or malformed acknowledgement never becomes a prepared local receipt', async (t) => {
  for (const condition of ['oversized', 'malformed']) {
    await t.test(condition, async (subtest) => {
      const f = await fixture(subtest);
      const control = await f.open();
      f.hooks.reply = (action, result) =>
        action === 'prepare'
          ? condition === 'oversized'
            ? { padding: 'x'.repeat(128 * 1024) }
            : { ok: true, state: null }
          : result;
      await assert.rejects(control.prepare(), failure);
      assert.equal(
        JSON.parse(await readFile(join(f.directory, 'local-shutdown.json'), 'utf8')).prepared,
        null,
      );
      assert.equal(f.actions.filter((action) => action === 'prepare').length, 1);
    });
  }
});

test('held or unknown work remains fenced until explicit same-journal resume succeeds', async (t) => {
  const f = await fixture(t);
  const control = await f.open();
  f.hooks.prepare = async () => {
    throw new Error('Synthetic held work.');
  };
  f.hooks.abort = async () => {
    throw new Error('Synthetic unknown state.');
  };
  await assert.rejects(control.prepare(), failure);
  assert.equal(f.state().phase, 'failed');
  const before = await readFile(join(f.directory, 'local-shutdown.json'), 'utf8');
  await assert.rejects(control.recover(), failure);
  assert.equal(f.actions.filter((action) => action === 'abort').length, 0);
  const explicit = await f.open(true);
  await assert.rejects(explicit.resume(), failure);
  assert.equal(await readFile(join(f.directory, 'local-shutdown.json'), 'utf8'), before);
  f.hooks.abort = async () => {};
  await explicit.resume();
  assert.equal(f.state().phase, 'aborted');
  await assert.rejects(explicit.resume(), failure);
  f.hooks.prepare = async () => [];
  await control.prepare();
  assert.equal(f.state().phase, 'prepared');
});

test('a control in progress excludes resume and a second launcher without signalling anything', async (t) => {
  const f = await fixture(t);
  const control = await f.open();
  const entered = deferred();
  const finish = deferred();
  f.hooks.prepare = async () => {
    entered.resolve();
    await finish.promise;
    return [];
  };
  const preparing = control.prepare();
  await entered.promise;
  await assert.rejects(f.open(), failure);
  const explicit = await f.open(true);
  await assert.rejects(explicit.resume(), failure);
  assert.deepEqual(f.actions, ['status', 'prepare']);
  finish.resolve();
  await preparing;
});

test('local installation is bound to environment and database and rejects unsafe files', async (t) => {
  const f = await fixture(t);
  const control = await f.open();
  await control.close();
  for (const change of [
    { DATABASE_URL: 'postgresql://fixture:synthetic@localhost:54331/other' },
    { SIDEKICK_ENVIRONMENT: 'other' },
    { SIDEKICK_MASTER_KEY: randomBytes(32).toString('base64') },
    { SIDEKICK_PUBLIC_URL: 'https://production.example.test' },
  ])
    await assert.rejects(
      openLocalCloudflareControl(f.directory, { ...f.environment, ...change }),
      failure,
    );
  const file = join(f.directory, 'local-installation.json');
  await chmod(file, 0o644);
  await assert.rejects(f.open(), failure);
  await chmod(file, 0o600);
  const saved = await readFile(file);
  await rm(file);
  const outside = join(f.directory, 'private-other.json');
  await writeFile(outside, saved, { mode: 0o600 });
  await symlink(outside, file);
  await assert.rejects(f.open(), failure);
});

test('wrong image release, foreign journal or incomplete receipt never confirms shutdown', async (t) => {
  for (const condition of ['image', 'receipt', 'foreign', 'missing'] as const) {
    await t.test(condition, async (subtest) => {
      const f = await fixture(subtest);
      const control = await f.open();
      if (condition === 'image') {
        f.hooks.healthRelease = 'local';
        await assert.rejects(control.prepare(), failure);
        assert.deepEqual(f.actions, []);
      } else if (condition === 'receipt') {
        f.hooks.reply = (action, result) =>
          action === 'prepare'
            ? {
                ok: true,
                state: { ...(result as { state: DeploymentState }).state, receipts: [{}] },
              }
            : result;
        await assert.rejects(control.prepare(), failure);
        assert.equal(
          JSON.parse(await readFile(join(f.directory, 'local-shutdown.json'), 'utf8')).prepared,
          null,
        );
      } else {
        await control.prepare();
        if (condition === 'foreign') f.setState({ ...f.state(), nonce: randomUUID() });
        else await rm(join(f.directory, 'local-shutdown.json'));
        await control.close();
        const next = await f.open();
        await assert.rejects(next.recover(), failure);
        assert.equal(f.actions.filter((action) => action === 'abort').length, 0);
      }
    });
  }
});

test('a bounded failed request preserves its journal without retrying preparation', async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const finish = deferred();
  f.hooks.prepare = async () => {
    entered.resolve();
    await finish.promise;
    return [];
  };
  const control = await f.open(false, { drainMs: 15 });
  const result = control.prepare();
  await entered.promise;
  await assert.rejects(result, failure);
  assert.equal(f.state().phase, 'failed');
  assert.equal(f.actions.filter((action) => action === 'prepare').length, 1);
  assert.ok(await readFile(join(f.directory, 'local-shutdown.json')));
  finish.resolve();
});

test('a matching operation with changed owner or generation receipts cannot reopen the barrier', async (t) => {
  for (const change of ['owner', 'generation', 'missing']) {
    await t.test(change, async (subtest) => {
      const f = await fixture(subtest);
      const control = await f.open();
      await control.prepare();
      const previous = await readFile(join(f.directory, 'local-shutdown.json'), 'utf8');
      f.setState({
        ...f.state(),
        receipts:
          change === 'missing'
            ? []
            : [
                {
                  ownerId: change === 'owner' ? randomUUID() : f.state().receipts[0].ownerId,
                  generation: change === 'generation' ? '3' : '2',
                },
              ],
      });
      await control.close();
      const next = await f.open();
      await assert.rejects(next.recover(), failure);
      assert.equal(f.actions.filter((action) => action === 'abort').length, 0);
      assert.equal(await readFile(join(f.directory, 'local-shutdown.json'), 'utf8'), previous);
    });
  }
});

test('supervision waits for preparation, ignores repeated signals and preserves a failed stack', async () => {
  for (const fails of [false, true]) {
    const child = new EventEmitter() as EventEmitter & { kill(signal: string): void };
    const signals = new EventEmitter();
    const prepared = deferred();
    const entered = deferred();
    const killed: string[] = [];
    let calls = 0;
    child.kill = (signal) => {
      killed.push(signal);
      child.emit('exit', 0);
    };
    const result = superviseLocalCloudflare(
      child,
      {
        recover: async () => {},
        cancel: () => {},
        prepare: async () => {
          calls++;
          entered.resolve();
          await prepared.promise;
          if (fails) throw new Error();
        },
      },
      { signals, report: () => {} },
    );
    signals.emit('SIGINT');
    await entered.promise;
    signals.emit('SIGTERM');
    assert.equal(calls, 1);
    assert.deepEqual(killed, []);
    prepared.resolve();
    await delay(5);
    if (fails) {
      assert.deepEqual(killed, []);
      child.emit('exit', 1);
    }
    assert.equal(await result, fails ? 1 : 0);
    assert.deepEqual(killed, fails ? [] : ['SIGINT']);
    assert.equal(signals.listenerCount('SIGINT'), 0);
  }
});

test('a terminal process-group SIGINT cannot reach the detached child before its receipt', async (t) => {
  if (process.platform === 'win32') return;
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-signal-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, 'supervisor.mjs');
  const module = new URL('../scripts/cloudflare-local-control.mjs', import.meta.url).href;
  await writeFile(
    entry,
    `
    import { spawn } from 'node:child_process';
    import { superviseLocalCloudflare } from ${JSON.stringify(module)};
    const child = spawn(process.execPath, ['-e', "process.on('SIGINT',()=>{process.send('interrupted');process.exit(0)});process.send('ready');setInterval(()=>{},1000)"], {detached:true,stdio:['ignore','ignore','ignore','ipc']});
    let finish;
    const receipt = new Promise(resolve => {finish=resolve});
    process.on('message', message => {if(message==='prepared')finish()});
    child.on('message', message => process.send({child:message,pid:child.pid}));
    const code = await superviseLocalCloudflare(child,{recover:async()=>{},cancel(){},prepare:async()=>{process.send({preparing:true});await receipt}},{report(){}});
    process.send({exit:code});process.disconnect();
  `,
  );
  const supervisor = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const messages: Array<{ child?: string; preparing?: boolean; exit?: number; pid?: number }> = [];
  supervisor.on('message', (message) => messages.push(message as (typeof messages)[number]));
  let childPid: number | undefined;
  t.after(() => {
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
    if (childPid) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {}
    }
  });
  const deadline = Date.now() + 5000;
  while (!messages.some((value) => value.child === 'ready')) {
    if (Date.now() >= deadline) throw new Error('Synthetic child did not start.');
    await delay(5);
  }
  childPid = messages.find((value) => value.child === 'ready')!.pid;
  process.kill(-supervisor.pid!, 'SIGINT');
  while (!messages.some((value) => value.preparing)) {
    if (Date.now() >= deadline) throw new Error('Synthetic drain did not start.');
    await delay(5);
  }
  assert.equal(
    messages.some((value) => value.child === 'interrupted'),
    false,
  );
  const closed = once(supervisor, 'exit');
  supervisor.send('prepared');
  await closed;
  assert.equal(
    messages.some((value) => value.child === 'interrupted'),
    true,
  );
  assert.equal(
    messages.some((value) => value.exit === 0),
    true,
  );
  childPid = undefined;
});

test('hosted CLI refuses check/resume ambiguity and resume for the other provider before launching', async (t) => {
  await assert.rejects(startHosted(['--check', '--resume']), /Choose either --check or --resume/);
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-resume-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'fixture.env');
  const values = {
    DATABASE_URL: 'postgresql://fixture:synthetic@localhost:54331/local',
    SIDEKICK_MASTER_KEY: randomBytes(32).toString('base64'),
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    GOOGLE_CLIENT_ID: 'synthetic',
    GOOGLE_CLIENT_SECRET: 'synthetic',
    COMPUTER_PROVIDER: 'e2b',
    E2B_API_KEY: 'synthetic',
    E2B_BROWSER_TEMPLATE: 'synthetic',
    E2B_WORKSPACE_TEMPLATE: 'synthetic',
  };
  await writeFile(
    file,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    { mode: 0o600 },
  );
  await assert.rejects(
    startHosted(['--env', file, '--resume']),
    /requires the Cloudflare computer provider/,
  );
});
