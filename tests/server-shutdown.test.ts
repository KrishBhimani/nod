import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';

for (const failure of ['none', 'application', 'database'] as const) {
  test(`server shutdown drains the database after ${failure} cleanup failure`, () => {
    const server = new URL('../src/server/', import.meta.url).href;
    const script = `
      import { registerHooks } from 'node:module';
      const modules = new Map([
        [${JSON.stringify(server + 'db.ts')}, "export const pool={end:async()=>{process.stdout.write('database-closed');if(process.env.CLOSE_FAILURE==='database')throw new Error('synthetic-private-failure')}}"],
        [${JSON.stringify(server + 'config.ts')}, "export const port=4310;export const runtimeMode='local';export const ownerId='local-development';export const runtimeGeneration=''"],
        [${JSON.stringify(server + 'composition.ts')}, "export const createGatewayApplication=()=>{throw new Error()};export const createDefaultAdapters=()=>({});export const createApplication=async()=>({app:{register:async()=>{},setNotFoundHandler:()=>{},listen:async()=>{setImmediate(()=>{process.emit('SIGTERM');process.emit('SIGINT')})},close:async()=>{process.stdout.write('application-closed');if(process.env.CLOSE_FAILURE==='application')throw new Error('synthetic-private-failure')}}})"],
      ]);
      registerHooks({load(url, context, next){
        const source=modules.get(url);
        return source===undefined?next(url,context):{format:'module',source,shortCircuit:true};
      }});
      await import(${JSON.stringify(server + 'index.ts')});
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, NODE_ENV: 'production', CLOSE_FAILURE: failure },
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, failure === 'none' ? 0 : 1, child.stderr);
    assert.equal(child.stdout.match(/application-closed/g)?.length, 1);
    assert.equal(child.stdout.match(/database-closed/g)?.length, 1);
    assert.doesNotMatch(child.stderr, /synthetic-private-failure|UnhandledPromise/);
  });
}

async function tenantShutdownFixture(t: TestContext, pending: 'application' | 'database') {
  const server = new URL('../src/server/', import.meta.url).href;
  const script = `
    import { registerHooks } from 'node:module';
    import Fastify from ${JSON.stringify(import.meta.resolve('fastify'))};
    const expiry = Date.now() + 5_000;
    process.env.OTTO_RUNTIME_LEASE_EXPIRES = new Date(expiry).toISOString();
    const resources = setInterval(() => {}, 1_000);
    let release;
    const pendingCleanup = new Promise(resolve => { release = resolve; });
    process.on('message', message => {
      if (message === 'release') release();
    });
    const report = type => process.send({ type, at: Date.now(), expiry });
    globalThis.fixture = {
      async application() {
        report('application-closing');
        if (${JSON.stringify(pending)} === 'application') await pendingCleanup;
        report('application-closed');
      },
      async database() {
        report('database-closing');
        if (${JSON.stringify(pending)} === 'database') await pendingCleanup;
        clearInterval(resources);
        report('database-closed');
      },
      async create() {
        const app = Fastify();
        app.addHook('onClose', async () => globalThis.fixture.application());
        app.addHook('onListen', async () => report('fixture-listening'));
        return { app };
      },
    };
    const modules = new Map([
      [${JSON.stringify(server + 'db.ts')}, 'export const pool = { end: () => globalThis.fixture.database() };'],
      [${JSON.stringify(server + 'config.ts')}, "export const port = 0; export const runtimeMode = 'tenant'; export const ownerId = '11111111-1111-4111-8111-111111111111'; export const runtimeGeneration = '1';"],
      [${JSON.stringify(server + 'composition.ts')}, 'export const createApplication = () => globalThis.fixture.create(); export const createDefaultAdapters = () => ({}); export const createGatewayApplication = () => { throw new Error(); };'],
    ]);
    registerHooks({ load(url, context, next) {
      const source = modules.get(url);
      return source === undefined ? next(url, context) : { format: 'module', source, shortCircuit: true };
    } });
    await import(${JSON.stringify(server + 'index.ts')});
  `;
  const child = spawn(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
    {
      env: { NODE_ENV: 'production', OTTO_BIND_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  const messages: { type: string; at: number; expiry: number }[] = [];
  let stderr = '';
  let stdout = '';
  let exitedAt = 0;
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.on('message', (message) => {
    messages.push(message as (typeof messages)[number]);
  });
  const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        exitedAt = Date.now();
        resolve({ code, signal });
      });
    },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await finished;
  });
  async function waitFor(type: string) {
    const deadline = Date.now() + 10_000;
    while (!messages.some((message) => message.type === type)) {
      assert.equal(child.exitCode, null, stderr);
      assert.equal(child.signalCode, null, stderr);
      assert.ok(Date.now() < deadline, `The fixture did not reach ${type}.`);
      await delay(10);
    }
    return messages.find((message) => message.type === type)!;
  }
  await waitFor('otto-ready');
  const { expiry } = await waitFor('fixture-listening');
  assert.ok(expiry - Date.now() > 500);
  return {
    child,
    expiry,
    finished,
    messages,
    waitFor,
    output: () => ({ stdout, stderr, exitedAt }),
  };
}

for (const pending of ['application', 'database'] as const) {
  test(`tenant SIGTERM retains the lease watchdog during pending ${pending} cleanup`, async (t) => {
    const fixture = await tenantShutdownFixture(t, pending);
    assert.equal(fixture.child.kill('SIGTERM'), true);
    await fixture.waitFor(`${pending}-closing`);
    await delay(Math.max(0, fixture.expiry + 1_250 - Date.now()));
    assert.equal(fixture.child.kill('SIGINT'), true);
    assert.equal(fixture.child.kill('SIGTERM'), true);
    const result = await Promise.race([
      fixture.finished,
      delay(Math.max(0, fixture.expiry + 2_750 - Date.now()), null, { ref: false }),
    ]);
    assert.notEqual(result, null, 'Pending cleanup disabled the existing lease exit watchdog.');
    assert.deepEqual(result, { code: 1, signal: null });
    assert.ok(fixture.output().exitedAt >= fixture.expiry + 1_900);
    assert.ok(fixture.output().exitedAt <= fixture.expiry + 2_750);
    assert.equal(
      fixture.messages.filter((message) => message.type === 'application-closing').length,
      1,
    );
    assert.equal(
      fixture.messages.filter((message) => message.type === 'database-closing').length,
      pending === 'database' ? 1 : 0,
    );
    assert.equal(fixture.output().stdout, '');
    assert.equal(fixture.output().stderr, '');
  });
}

test('tenant SIGTERM finishes cleanup once before expiry despite repeated signals', async (t) => {
  const fixture = await tenantShutdownFixture(t, 'application');
  assert.equal(fixture.child.kill('SIGTERM'), true);
  await fixture.waitFor('application-closing');
  assert.equal(fixture.child.kill('SIGINT'), true);
  assert.equal(fixture.child.kill('SIGTERM'), true);
  fixture.child.send('release');
  const result = await Promise.race([
    fixture.finished,
    delay(Math.max(0, fixture.expiry - Date.now()), null, { ref: false }),
  ]);
  assert.deepEqual(result, { code: 0, signal: null });
  assert.ok(fixture.output().exitedAt < fixture.expiry);
  assert.deepEqual(
    fixture.messages
      .filter((message) => /^(application|database)-/.test(message.type))
      .map((message) => message.type),
    ['application-closing', 'application-closed', 'database-closing', 'database-closed'],
  );
  assert.equal(fixture.output().stdout, '');
  assert.equal(fixture.output().stderr, '');
});
