import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Sandbox } from 'e2b';
import type { Computer } from '../src/ports/computer.ts';
import { runBrowserBridge } from '../src/providers/container-browser/bridge.ts';
import { startContainerBrowserWorker } from '../src/providers/container-browser/worker.ts';
import { workspaceCommandProgram } from '../src/providers/docker/command.ts';
import { createE2BAllocation } from '../src/providers/e2b/allocation.ts';
import type { E2BSandbox } from '../src/providers/e2b/client.ts';
import {
  acceptanceMetadata,
  acceptanceSourceHash,
  cleanupAcceptance,
  inspectAcceptance,
  openAcceptance,
  prepareAcceptance,
  readDevelopmentConfiguration,
  runAcceptance,
  type AcceptanceDriver,
  type ResourceInfo,
} from '../deployment/e2b/acceptance.ts';
import type { JourneyInput } from '../deployment/e2b/acceptance-journey.ts';
import { createAcceptanceDriver } from '../deployment/e2b/acceptance-driver.ts';

const source = 'a'.repeat(64);
const configuration = { apiKey: 'synthetic-development-key', templateId: 'synthetic-template' };

test('live guest probe regressions run offline in the ordinary Node test suite', () => {
  const result = spawnSync(
    'python3',
    ['-B', '-m', 'unittest', 'discover', '-s', 'deployment/e2b', '-p', 'live_boundary_test.py'],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 64 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 13 tests/);
  assert.match(result.stderr, /OK/);
});

test('acceptance CLI has no default execution and refuses CI before reading credentials', () => {
  const entry = fileURLToPath(new URL('../deployment/e2b/acceptance.ts', import.meta.url));
  for (const args of [[], ['run'], ['plan', '--env', '/not-read', '--journal', '/not-created']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { PATH: process.env.PATH, CI: 'true' },
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4096,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'The development acceptance needs inspection before continuing.\n');
  }
});

test('a failed CLI operation remains bounded when a provider stream leaves an active handle', () => {
  const entry = new URL('../deployment/e2b/acceptance.ts', import.meta.url).href;
  const program = `import { runAcceptanceCli } from ${JSON.stringify(entry)}; setInterval(() => {}, 1000); await runAcceptanceCli(async () => { throw new Error('synthetic-private-provider-error'); }, 75);`;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', program],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4096,
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'The development acceptance needs inspection before continuing.\nThe development acceptance deadline expired; inspect its journal.\n',
  );
});
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidekick-e2b-live-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'journal');
  const prepared = await prepareAcceptance(directory, configuration, source);
  const journal = await openAcceptance(directory, configuration, prepared.hash, source);
  const calls: string[] = [];
  const resources = new Map<string, ResourceInfo>();
  let createFailure = false;
  let pauseFailure = false;
  let killFailure = false;
  let nextConnectId: string | undefined;
  const wrap = (id: string): E2BSandbox => ({
    id,
    ready: async () => {
      calls.push('ready');
      assert.equal(
        journal.entries.some((entry) => entry.type === 'created' && entry.id === id),
        true,
      );
      const allocation = await journal.store.read(journal.plan.ownerId, 'computer');
      assert.equal(allocation?.resourceId, id);
    },
    start: async (input) => {
      calls.push(input.role);
      return {
        sendStdin: async () => {},
        closeStdin: async () => {},
        wait: async () => ({ exitCode: 0 }),
        disconnect: async () => {},
      };
    },
    keepAlive: async () => {
      calls.push('keep-alive');
    },
    pause: async () => {
      calls.push('pause');
      if (pauseFailure) throw new Error('synthetic sensitive provider error');
      resources.get(id)!.state = 'paused';
      return true;
    },
  });
  const driver: AcceptanceDriver = {
    client: {
      create: async (templateId, metadata) => {
        calls.push('create');
        assert.equal(journal.entries.filter((entry) => entry.type === 'create-start').length, 1);
        const id = 'disposable-resource';
        resources.set(id, { id, templateId, metadata, state: 'running' });
        if (createFailure) throw new Error('synthetic sensitive provider error');
        return wrap(id);
      },
      connect: async (id) => {
        calls.push('connect');
        resources.get(id)!.state = 'running';
        return wrap(nextConnectId ?? id);
      },
    },
    inspect: async (id) => resources.get(id) ?? null,
    find: async (metadata) => {
      calls.push('find');
      return [...resources.values()].filter((info) =>
        Object.entries(metadata).every(([key, value]) => info.metadata[key] === value),
      );
    },
    boundary: async () => {
      calls.push('boundary');
      return { passed: true, cleanupComplete: true };
    },
    kill: async (id) => {
      calls.push('kill');
      resources.delete(id);
      if (killFailure) throw new Error('synthetic sensitive provider error');
    },
  };
  return {
    root,
    directory,
    prepared,
    journal,
    driver,
    calls,
    resources,
    createFailure: () => {
      createFailure = true;
    },
    pauseFailure: () => {
      pauseFailure = true;
    },
    killFailure: () => {
      killFailure = true;
    },
    differentConnection: () => {
      nextConnectId = 'foreign-resource';
    },
  };
}

async function lifecycleJourney(input: JourneyInput) {
  const create = () =>
    createE2BAllocation({
      ownerId: input.plan.ownerId,
      role: 'computer',
      templateId: input.plan.templateId,
      store: input.store,
      client: input.client,
    });
  let allocation = create();
  const first = await input.stage('prepare-once', () =>
    Promise.all([allocation.get(), allocation.get()]),
  );
  assert.equal(first[0].id, first[1].id);
  await input.stage('guest-boundary', input.boundary);
  for (const role of ['browser', 'workspace'] as const) {
    const acquired = await allocation.acquire();
    try {
      const command = await acquired.sandbox.start({
        role,
        command: 'synthetic',
        stdout: () => {},
        stderr: () => {},
      });
      assert.equal((await command.wait()).exitCode, 0);
    } finally {
      acquired.release();
    }
  }
  await allocation.pause();
  await allocation.resume();
  assert.equal((await allocation.get()).id, first[0].id);
  await allocation.dispose();
  allocation = create();
  assert.equal((await allocation.get()).id, first[0].id);
  await allocation.dispose();
}

test('live E2B plan and event journal are private, exclusive and credential/source bound', async (t) => {
  const f = await fixture(t);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.directory, 'plan.json'))).mode & 0o777, 0o600);
  assert.equal(
    (await readFile(join(f.directory, 'plan.json'), 'utf8')).includes(configuration.apiKey),
    false,
  );
  await assert.rejects(prepareAcceptance(f.directory, configuration, source));
  for (const [config, hash, code] of [
    [{ ...configuration, apiKey: 'different' }, f.prepared.hash, source],
    [{ ...configuration, templateId: 'different' }, f.prepared.hash, source],
    [configuration, 'b'.repeat(64), source],
    [configuration, f.prepared.hash, 'b'.repeat(64)],
  ] as const)
    await assert.rejects(openAcceptance(f.directory, config, hash, code));
  assert.deepEqual(f.calls, []);
});

test('source binding follows actual host imports and rejects changed, escaped or linked dependencies', async (t) => {
  const f = await fixture(t);
  const repository = fileURLToPath(new URL('..', import.meta.url));
  const copied = join(f.root, 'source');
  await mkdir(copied);
  for (const path of ['src', 'deployment/e2b', 'package.json', 'package-lock.json'])
    await cp(join(repository, path), join(copied, path), { recursive: true });
  const originalHash = await acceptanceSourceHash(copied);
  assert.equal(originalHash, await acceptanceSourceHash());
  const directory = join(f.root, 'source-journal');
  const prepared = await prepareAcceptance(directory, configuration, originalHash);
  await openAcceptance(directory, configuration, prepared.hash, originalHash);
  for (const name of [
    'src/providers/container-browser/client.ts',
    'src/providers/docker/index.ts',
    'src/providers/docker/command.ts',
    'deployment/e2b/context.ts',
  ]) {
    const path = join(copied, name);
    const original = await readFile(path);
    await writeFile(
      path,
      Buffer.concat([original, Buffer.from('\nexport const sourceBindingFixture = true;\n')]),
    );
    const changed = await acceptanceSourceHash(copied);
    assert.notEqual(changed, originalHash, name);
    await assert.rejects(openAcceptance(directory, configuration, prepared.hash, changed));
    await writeFile(path, original);
  }
  const name = 'src/providers/container-browser/client.ts';
  const path = join(copied, name);
  const original = await readFile(path);
  await unlink(path);
  await symlink(join(repository, name), path);
  await assert.rejects(acceptanceSourceHash(copied));
  await unlink(path);
  await writeFile(
    path,
    Buffer.concat([original, Buffer.from('\nimport "../../../../outside.ts";\n')]),
  );
  await assert.rejects(acceptanceSourceHash(copied));
  await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(acceptanceSourceHash(copied));
  assert.deepEqual(f.calls, []);
});

test('acceptance SDK creation and reconnect disable retries and refuse a different readback identity', async (t) => {
  const f = await fixture(t);
  const fake = { sandboxId: 'disposable-resource' };
  const creates = t.mock.method(Sandbox, 'create', async () => fake);
  const connects = t.mock.method(Sandbox, 'connect', async () => fake);
  t.mock.method(Sandbox, 'getInfo', async () => ({
    sandboxId: 'different-resource',
    templateId: f.journal.plan.templateId,
    metadata: acceptanceMetadata(f.journal.plan),
    state: 'running',
  }));
  const driver = createAcceptanceDriver(configuration.apiKey, f.journal.plan);
  await driver.client.create(configuration.templateId, acceptanceMetadata(f.journal.plan));
  await driver.client.connect(fake.sandboxId);
  assert.equal((creates.mock.calls[0]!.arguments[1] as { retries: number }).retries, 0);
  assert.equal((connects.mock.calls[0]!.arguments[1] as { retries: number }).retries, 0);
  await assert.rejects(driver.inspect(fake.sandboxId));
});

test('a known allocation cannot inspect or delete a different returned resource with matching metadata', async (t) => {
  const f = await fixture(t);
  await runAcceptance(f.journal, f.driver, lifecycleJourney);
  const inspect = f.driver.inspect;
  f.driver.inspect = async (id) => {
    const info = await inspect(id);
    return info && { ...info, id: 'different-resource' };
  };
  await assert.rejects(inspectAcceptance(f.journal, f.driver));
  await assert.rejects(cleanupAcceptance(f.journal, f.driver));
  assert.equal(f.calls.includes('kill'), false);
  assert.equal(
    f.journal.entries.some((entry) => entry.type === 'cleanup-start'),
    false,
  );
});

test('live E2B environment reader refuses production, legacy templates and endpoint overrides', async (t) => {
  const f = await fixture(t);
  const file = join(f.root, 'development.env');
  const baseline =
    'SIDEKICK_ENVIRONMENT=development\nCOMPUTER_PROVIDER=e2b\nE2B_API_KEY=synthetic-key\nE2B_COMPUTER_TEMPLATE=synthetic-template\n';
  await writeFile(file, baseline, { mode: 0o600 });
  assert.equal((await readDevelopmentConfiguration(file)).templateId, 'synthetic-template');
  for (const text of [
    baseline.replace('development', 'production'),
    baseline + 'E2B_BROWSER_TEMPLATE=old\n',
    baseline + 'E2B_API_URL=https://foreign.test\n',
    baseline.replace('E2B_API_KEY=synthetic-key', 'E2B_API_KEY='),
  ]) {
    await writeFile(file, text);
    await assert.rejects(readDevelopmentConfiguration(file));
  }
  assert.deepEqual(f.calls, []);
});

test('one journaled owner resource serves both roles and survives pause plus adapter reconstruction', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await runAcceptance(f.journal, f.driver, lifecycleJourney), {
    passed: true,
    resourceCount: 1,
    cleanupRequired: true,
  });
  assert.equal(f.calls.filter((call) => call === 'create').length, 1);
  assert.equal(f.calls.filter((call) => call === 'connect').length, 2);
  assert.ok(f.calls.includes('browser') && f.calls.includes('workspace'));
  const restored = await openAcceptance(f.directory, configuration, f.prepared.hash, source);
  const allocation = await restored.store.read(restored.plan.ownerId, 'computer');
  assert.equal(allocation?.resourceId, 'disposable-resource');
  assert.equal(allocation?.leaseId, null);
  assert.equal(allocation?.state, 'ready');
  await assert.rejects(runAcceptance(restored, f.driver, lifecycleJourney));
  assert.equal(f.calls.filter((call) => call === 'create').length, 1);
});

test('lost create acknowledgement is discoverable by exact metadata but never replayed or adopted', async (t) => {
  const f = await fixture(t);
  f.createFailure();
  await assert.rejects(runAcceptance(f.journal, f.driver, lifecycleJourney), /needs inspection/);
  assert.equal(
    f.journal.entries.some((entry) => entry.type === 'created'),
    false,
  );
  assert.equal(
    f.journal.entries.some((entry) => entry.type === 'failed'),
    true,
  );
  assert.equal((await inspectAcceptance(f.journal, f.driver))[0]?.id, 'disposable-resource');
  await assert.rejects(runAcceptance(f.journal, f.driver, lifecycleJourney));
  assert.equal(f.calls.filter((call) => call === 'create').length, 1);
  assert.equal(f.calls.includes('ready'), false);
  assert.equal(f.calls.includes('connect'), false);
  assert.deepEqual(await cleanupAcceptance(f.journal, f.driver), { cleaned: true, absent: true });
  assert.equal(f.resources.size, 0);
});

test('ambiguous or foreign discovery blocks cleanup without touching another resource', async (t) => {
  const f = await fixture(t);
  f.createFailure();
  await assert.rejects(runAcceptance(f.journal, f.driver, lifecycleJourney));
  const original = f.resources.get('disposable-resource')!;
  f.driver.find = async () => [original, { ...original, id: 'second-resource' }];
  await assert.rejects(cleanupAcceptance(f.journal, f.driver));
  f.driver.find = async () => [
    { ...original, metadata: { ...original.metadata, sidekick_owner: 'foreign' } },
  ];
  await assert.rejects(cleanupAcceptance(f.journal, f.driver));
  assert.equal(f.calls.includes('kill'), false);
});

test('failed boundary never advances to role commands and keeps identity for separate inspection', async (t) => {
  const f = await fixture(t);
  f.driver.boundary = async () => ({ passed: false, cleanupComplete: false });
  await assert.rejects(runAcceptance(f.journal, f.driver, lifecycleJourney));
  assert.equal(f.calls.includes('workspace'), false);
  assert.equal(f.calls.includes('browser'), false);
  assert.equal(f.calls.includes('kill'), false);
  assert.equal((await inspectAcceptance(f.journal, f.driver)).length, 1);
});

test('pause uncertainty and changed reconnect identity cannot produce a passing receipt', async (t) => {
  for (const mode of ['pause', 'connect'] as const) {
    const f = await fixture(t);
    if (mode === 'pause') f.pauseFailure();
    else f.differentConnection();
    await assert.rejects(runAcceptance(f.journal, f.driver, lifecycleJourney), /needs inspection/);
    assert.equal(
      f.journal.entries.some((entry) => entry.type === 'passed'),
      false,
    );
    assert.equal(f.calls.filter((call) => call === 'create').length, 1);
  }
});

test('cleanup is one attempt and lost deletion acknowledgement is reconciled only by inspection', async (t) => {
  const f = await fixture(t);
  await runAcceptance(f.journal, f.driver, lifecycleJourney);
  f.killFailure();
  await assert.rejects(cleanupAcceptance(f.journal, f.driver));
  await assert.rejects(cleanupAcceptance(f.journal, f.driver));
  assert.deepEqual(await inspectAcceptance(f.journal, f.driver), []);
  assert.equal(f.calls.filter((call) => call === 'kill').length, 1);
  assert.equal(
    f.journal.entries.some((entry) => entry.type === 'cleaned'),
    false,
  );
});

test('allocation CAS rejects foreign owner, generation and resource replacement', async (t) => {
  const f = await fixture(t);
  await runAcceptance(f.journal, f.driver, lifecycleJourney);
  const record = (await f.journal.store.read(f.journal.plan.ownerId, 'computer'))!;
  for (const change of [
    { ownerId: f.journal.plan.taskId },
    { generation: f.journal.plan.taskId },
    { resourceId: 'replacement' },
  ]) {
    await assert.rejects(
      f.journal.store.compareAndSwap(record.version, {
        ...record,
        ...change,
        version: record.version + 1,
      }),
    );
  }
  assert.equal(
    (await f.journal.store.read(f.journal.plan.ownerId, 'computer'))?.resourceId,
    record.resourceId,
  );
  assert.equal(acceptanceMetadata(f.journal.plan).sidekick_disposable, 'development');
});

for (const pauseDuringHold of [false, true])
  test(
    pauseDuringHold
      ? 'the held-stage assertion refuses a provider pause followed by an error'
      : 'the complete opt-in journey uses the real bridge and Python supervisor without live providers',
    { timeout: 30_000 },
    async (t) => {
      const f = await fixture(t);
      const socketPath = join(f.root, 'control.sock');
      let cookie = '';
      let held = false;
      let resumed = 0;
      const worker = await startContainerBrowserWorker({
        socketPath,
        createComputer: () => {
          resumed++;
          return {
            status: () => 'Synthetic browser',
            act: async (_id, input) => {
              const url = new URL(input.url!);
              if (url.pathname === '/response-headers') {
                const value = url.searchParams.get('Set-Cookie')!;
                assert.ok(value.includes('Max-Age=3600'));
                cookie = value.split(';')[0]!.split('=')[1]!;
              }
              return {
                url: url.href,
                text:
                  url.hostname === 'example.com'
                    ? 'Example Domain'
                    : JSON.stringify({ cookies: { sidekick_e2b: cookie } }),
                candidates: [],
              };
            },
            hold: async (_id, until) => {
              held = until !== null;
            },
            canCheckpoint: () => pauseDuringHold || !held,
            close: async () => {},
            dispose: async () => {},
            screenshot: async () => null,
            injectCredentials: async () => {},
            inspectLogin: async () => ({
              origin: 'https://example.com',
              url: 'https://example.com/',
              fields: [],
              methods: [],
            }),
            selectLoginMethod: async () => {},
          } satisfies Computer & { canCheckpoint(): boolean };
        },
      });
      t.after(() => worker.close());
      const base = f.driver.client;
      const children: ReturnType<typeof spawn>[] = [];
      t.after(() => {
        for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
      });
      function attach(sandbox: E2BSandbox): E2BSandbox {
        return {
          ...sandbox,
          async pause() {
            const result = await sandbox.pause();
            if (pauseDuringHold && held) throw new Error('Synthetic post-pause failure');
            return result;
          },
          async start(input) {
            f.calls.push(input.role);
            if (input.role === 'browser') {
              const stdin = new PassThrough();
              const stdout = new PassThrough();
              stdout.on('data', (data: Buffer) => input.stdout(data.toString()));
              const result = runBrowserBridge({ input: stdin, output: stdout, socketPath });
              return {
                sendStdin: async (data) => {
                  stdin.write(data);
                },
                closeStdin: async () => {
                  stdin.end();
                },
                wait: async () => ({ exitCode: await result }),
                disconnect: async () => {},
              };
            }
            const task = input.command.match(/mkdir -p \/workspace\/([a-f0-9-]+)/)?.[1];
            assert.equal(task, f.journal.plan.taskId);
            const directory = join(f.root, 'workspace');
            await mkdir(directory, { recursive: true });
            const child = spawn('python3', ['-u', '-c', workspaceCommandProgram], {
              cwd: directory,
              env: { PATH: process.env.PATH },
            });
            children.push(child);
            child.stdout.on('data', (data: Buffer) => input.stdout(data.toString()));
            child.stderr.on('data', (data: Buffer) => input.stderr(data.toString()));
            const result = new Promise<{ exitCode: number }>((resolve) =>
              child.once('close', (code) => resolve({ exitCode: code ?? -1 })),
            );
            return {
              sendStdin: async (data) => {
                child.stdin.write(
                  Buffer.from(data).toString().replaceAll(`/workspace/${task}`, directory),
                );
              },
              closeStdin: async () => {
                child.stdin.end();
              },
              wait: () => result,
              disconnect: async () => {},
            };
          },
        };
      }
      f.driver.client = {
        create: async (...args) => attach(await base.create(...args)),
        connect: async (id) => attach(await base.connect(id)),
      };
      if (pauseDuringHold) {
        await assert.rejects(runAcceptance(f.journal, f.driver));
        assert.equal(f.calls.filter((call) => call === 'pause').length, 1);
        assert.equal(f.calls.filter((call) => call === 'connect').length, 0);
        assert.equal(
          f.journal.entries.findLast((entry) => entry.type === 'stage-start')?.name,
          'held-browser-refuses-pause',
        );
        assert.equal(
          f.journal.entries.some(
            (entry) =>
              entry.type === 'stage-complete' && entry.name === 'held-browser-refuses-pause',
          ),
          false,
        );
        return;
      }
      await runAcceptance(f.journal, f.driver).catch((error) => {
        const stage = f.journal.entries.findLast((entry) => entry.type === 'stage-start')?.name;
        throw new Error(`Synthetic journey failed at ${stage}`, { cause: error });
      });
      assert.equal(f.calls.filter((call) => call === 'create').length, 1);
      assert.equal(f.calls.filter((call) => call === 'connect').length, 2);
      assert.equal(f.calls.filter((call) => call === 'pause').length, 3);
      assert.ok(resumed >= 3);
      const childPid = Number(await readFile(join(f.root, 'workspace/cancel-child.pid'), 'utf8'));
      assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
      let stopped = false;
      const stopDeadline = performance.now() + 5_000;
      while (performance.now() < stopDeadline) {
        try {
          process.kill(childPid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          stopped = true;
          break;
        }
        if (process.platform === 'linux') {
          const status = await readFile(`/proc/${childPid}/stat`, 'utf8').catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return undefined;
          });
          if (status !== undefined) {
            const match = status.match(/^(\d+) \([\s\S]*\) ([RSDZTtXxKWPI]) /);
            assert.ok(match && Number(match[1]) === childPid, 'Invalid child process status');
            if (match[2] === 'Z') {
              stopped = true;
              break;
            }
          }
        }
        await delay(25);
      }
      assert.equal(stopped, true, 'The cancelled child is still running');
      const starts = f.journal.entries.filter((entry) => entry.type === 'command-start');
      const completed = f.journal.entries.filter((entry) => entry.type === 'command-complete');
      assert.ok(starts.length > 10);
      assert.equal(starts.length, completed.length);
      assert.deepEqual(
        f.journal.entries
          .filter((entry) => entry.type === 'stage-complete')
          .map((entry) => entry.name),
        [
          'prepare-once',
          'guest-boundary',
          'workspace-and-artifact',
          'browser-and-profile-seed',
          'held-browser-refuses-pause',
          'descendant-cancellation',
          'same-resource-pause-resume',
          'adapter-restart-recovery',
          'confirmed-final-pause',
        ],
      );
    },
  );
