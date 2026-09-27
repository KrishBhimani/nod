import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { Template } from 'e2b';
import { buildE2BTemplate, prepareE2BTemplate } from '../deployment/e2b/build.ts';
import { prepareE2BContext } from '../deployment/e2b/context.ts';
import { checkBrowserWorker } from '../deployment/e2b/browser-ready.ts';
import { startContainerBrowserWorker } from '../src/providers/container-browser/worker.ts';

test('E2B templates use bounded build contexts and the trusted browser and shell entrypoints', async (t) => {
  const builds: Array<{ name: string; template: string; options: unknown }> = [];
  t.mock.method(
    Template,
    'build',
    async (template: Parameters<typeof Template.toJSON>[0], name: string, options: unknown) => {
      builds.push({ name, template: await Template.toJSON(template), options });
      return { templateId: name + '-id', buildId: name + '-build', name };
    },
  );
  const browser = await buildE2BTemplate({
    role: 'browser',
    name: 'synthetic-browser',
    apiKey: 'synthetic-key',
  });
  const workspace = await buildE2BTemplate({
    role: 'workspace',
    name: 'synthetic-workspace',
    apiKey: 'synthetic-key',
  });
  const computer = await buildE2BTemplate({
    role: 'computer',
    name: 'synthetic-computer',
    apiKey: 'synthetic-key',
  });
  assert.equal(browser.templateId, 'synthetic-browser-id');
  assert.equal(workspace.templateId, 'synthetic-workspace-id');
  assert.equal(computer.templateId, 'synthetic-computer-id');
  assert.match(builds[0].template, /container-browser\/worker\.ts/);
  assert.match(builds[0].template, /browser-ready\.ts/);
  assert.equal(browser.buildId, 'synthetic-browser-build');
  assert.match(builds[1].template, /workspace-command\.py/);
  const combined = JSON.parse(builds[2].template);
  assert.equal(combined.startCmd, 'exec python3 /opt/sidekick/computer-guard.py start');
  assert.equal(combined.readyCmd, 'python3 /opt/sidekick/computer-guard.py check');
  assert.equal(
    builds.some((build) => build.template.includes('synthetic-key')),
    false,
  );
  assert.equal(
    builds.some((build) => build.template.includes('.env')),
    false,
  );
  assert.equal(
    builds.some((build) => build.template.includes('.local/cloud')),
    false,
  );
});

test('offline E2B preflight includes the complete browser import closure and no application source', async (t) => {
  t.mock.method(Template, 'build', () => {
    throw new Error('Offline preflight must not build provider resources.');
  });
  const browser = await prepareE2BTemplate('browser');
  t.after(browser.close);
  const paths = browser.summary.files.map((file) => file.path);
  for (const required of [
    'src/providers/container-browser/worker.ts',
    'src/providers/container-browser/bridge.ts',
    'src/providers/agent-browser/index.ts',
    'src/providers/agent-browser/desktop.ts',
    'src/providers/agent-browser/sign-in.ts',
    'src/ports/computer.ts',
    'src/shared/browser-input.ts',
    'deployment/e2b/browser-ready.ts',
    'package-lock.json',
  ])
    assert.ok(paths.includes(required), required);
  assert.ok(paths.every((path) => !/(src\/(server|runtime|web)|\.env|\.local)/.test(path)));
  const workspace = await prepareE2BTemplate('workspace');
  t.after(workspace.close);
  assert.deepEqual(
    workspace.summary.files.map((file) => file.path),
    ['workspace-command.py'],
  );
  const description = JSON.parse(await Template.toJSON(workspace.template));
  assert.match(JSON.stringify(description), /\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin/);
  assert.doesNotMatch(JSON.stringify(description), /\$PATH/);
  assert.match(description.readyCmd, /test -w \/workspace/);
  const computer = await prepareE2BTemplate('computer');
  t.after(computer.close);
  const combinedPaths = computer.summary.files.map((file) => file.path);
  assert.ok(paths.every((path) => combinedPaths.includes(path)));
  assert.ok(combinedPaths.includes('workspace-command.py'));
  assert.ok(combinedPaths.includes('deployment/e2b/computer-guard.py'));
  assert.ok(combinedPaths.every((path) => !/(src\/(server|runtime|web)|\.env|\.local)/.test(path)));
});

test('template contexts reject symlinked source and do not copy unrelated local files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-template-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['src/providers/container-browser', 'deployment/e2b'])
    await mkdir(join(root, directory), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'Dockerfile.browser'),
      'FROM node:24.21.0-bookworm-slim\nCOPY src /app/src\n',
    ),
    writeFile(join(root, 'package.json'), '{}'),
    writeFile(join(root, 'package-lock.json'), '{}'),
    writeFile(
      join(root, 'src/providers/container-browser/worker.ts'),
      "import './dependency.ts';\n",
    ),
    writeFile(
      join(root, 'src/providers/container-browser/dependency.ts'),
      'export const ready = true;\n',
    ),
    writeFile(join(root, 'src/providers/container-browser/bridge.ts'), 'export {};\n'),
    writeFile(join(root, 'deployment/e2b/browser-ready.ts'), 'export {};\n'),
    writeFile(
      join(root, 'src/providers/container-browser/.env'),
      'UNRELATED=synthetic-private-fixture\n',
    ),
  ]);
  const context = await prepareE2BContext({ role: 'browser', root });
  t.after(context.close);
  assert.equal(
    await readFile(join(context.path, 'src/providers/container-browser/dependency.ts'), 'utf8'),
    'export const ready = true;\n',
  );
  await assert.rejects(stat(join(context.path, 'src/providers/container-browser/.env')));
  assert.equal((await stat(join(context.path, 'src'))).mode & 0o777, 0o755 & ~process.umask());
  await rm(join(root, 'src/providers/container-browser/dependency.ts'));
  await symlink(
    join(root, 'src/providers/container-browser/.env'),
    join(root, 'src/providers/container-browser/dependency.ts'),
  );
  await assert.rejects(prepareE2BContext({ role: 'browser', root }), /approved context/);
});

test('browser readiness completes a real private worker exchange without opening a browser', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-ready-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, 'worker.sock');
  let launches = 0;
  const worker = await startContainerBrowserWorker({
    socketPath,
    dataRoot: root,
    createComputer: () => {
      launches++;
      throw new Error('Readiness must not open a computer.');
    },
  });
  t.after(() => worker.close());
  await checkBrowserWorker(socketPath);
  assert.equal(launches, 0);
  await chmod(socketPath, 0o666);
  await assert.rejects(checkBrowserWorker(socketPath), /not ready/);
  await chmod(socketPath, 0o600);
  await worker.close();
  await writeFile(socketPath, 'synthetic regular file', { mode: 0o600 });
  await assert.rejects(checkBrowserWorker(socketPath), /not ready/);
});

test('browser readiness rejects silent and malformed Unix services within its deadline', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-ready-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, 'unrelated.sock');
  let malformed = false;
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', () => {
      if (malformed) socket.end('{"ok":true}\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await chmod(socketPath, 0o600);
  await assert.rejects(checkBrowserWorker(socketPath, 50), /not ready/);
  malformed = true;
  await assert.rejects(checkBrowserWorker(socketPath), /not ready/);
});

test('computer boundary failures keep fixed diagnostics and clean up both fixture containers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-boundary-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reply = join(root, 'reply.json');
  const calls = join(root, 'calls.jsonl');
  const executable = join(root, 'docker');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'run' && args.includes('none')) {
  process.stderr.write('The private computer is not ready.\\n');
  process.exit(1);
}
if (args[0] === 'exec' && args.includes('check')) process.stdout.write('{"ready":true}\\n');
if (args[0] === 'exec' && args.includes('/tmp/sidekick-boundary.py')) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(reply)}, 'utf8'));
  process.stderr.write('synthetic-private-subprocess-output');
  process.exit(1);
}
`,
    { mode: 0o700 },
  );
  for (const [response, expected] of [
    [JSON.stringify({ passed: false, check: 'chromium-exited' }), 'chromium-exited'],
    [JSON.stringify({ passed: false, check: 'synthetic-private-subprocess-output' }), 'unknown'],
    ['synthetic-private-subprocess-output', 'unknown'],
  ]) {
    await writeFile(reply, response);
    await writeFile(calls, '');
    const result = spawnSync(
      process.execPath,
      [resolve('deployment/e2b/validate-computer.mjs'), 'sidekick-e2b-computer:123456789abc'],
      { env: { PATH: `${root}:${dirname(process.execPath)}` }, encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`boundary check failed (${expected})`));
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-subprocess-output/);
    const invoked = (await readFile(calls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    const created = invoked
      .filter((args) => args[0] === 'run')
      .map((args) => args[args.indexOf('--name') + 1]);
    const removed = invoked.filter((args) => args[0] === 'rm').map((args) => args[2]);
    assert.equal(created.length, 2);
    assert.deepEqual(removed.sort(), created.sort());
  }
});
