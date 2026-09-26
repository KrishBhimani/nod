import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert.equal(browser.templateId, 'synthetic-browser-id');
  assert.equal(workspace.templateId, 'synthetic-workspace-id');
  assert.match(builds[0].template, /container-browser\/worker\.ts/);
  assert.match(builds[0].template, /browser-ready\.ts/);
  assert.equal(browser.buildId, 'synthetic-browser-build');
  assert.match(builds[1].template, /workspace-command\.py/);
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
  assert.equal((await stat(join(context.path, 'src'))).mode & 0o777, 0o755);
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
