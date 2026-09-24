import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import {
  browserSessionId,
  createAgentBrowserComputer,
} from '../src/providers/agent-browser/index.ts';
import { stagedLoginBrowser } from './login-fixture.ts';

test('inspector reattaches to an existing daemon without navigation or launching a browser', async () => {
  const directory = await mkdtemp('/tmp/sk-screen-');
  const fixture = stagedLoginBrowser();
  const original = createAgentBrowserComputer({ dataRoot: directory, run: fixture.run });
  const socketPath = join(directory, `${browserSessionId('fixture')}.sock`);
  const daemonActions: string[] = [];
  const launches: string[][] = [];
  const daemon = createServer((socket) => {
    let input = '';
    socket.on('data', async (chunk) => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      const command = JSON.parse(input);
      input = '';
      daemonActions.push(command.action);
      const page = fixture.pages.get('fixture')!;
      let data: Record<string, unknown> = {};
      if (command.action === 'url') data = { url: page.location.href };
      if (command.action === 'evaluate') data = { result: await page.evaluate(command.script) };
      if (command.action === 'screenshot') await writeFile(command.path, page.screen());
      if (command.action === 'close') page.closed = true;
      socket.end(JSON.stringify({ success: true, data }) + '\n');
    });
  });
  await new Promise<void>((resolve) => daemon.listen(socketPath, resolve));
  const restored = createAgentBrowserComputer({
    dataRoot: directory,
    run: async (_executable, args) => {
      launches.push(args);
      assert.deepEqual(args.slice(-3), ['session', 'info', '--json']);
      return {
        stdout: JSON.stringify({
          success: true,
          data: {
            active: true,
            namespace: args[args.indexOf('--namespace') + 1],
            session: args[args.indexOf('--session') + 1],
            socketDir: directory,
          },
        }),
        stderr: '',
        exitCode: 0,
      };
    },
  });
  try {
    await original.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    fixture.pages.get('fixture')!.location.href = 'https://1.1.1.1/login?code=private-code#private';
    await original.screenshot('fixture');
    const metadata = JSON.parse(
      await readFile(join(directory, 'runtime/screen-fixture.json'), 'utf8'),
    );
    assert.equal(metadata.url, 'https://1.1.1.1/login');
    assert.equal((await stat(join(directory, 'runtime/screen-fixture.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'runtime/screen-fixture.png'))).mode & 0o777, 0o600);
    assert.ok(await restored.screenshot('fixture'));
    assert.equal(restored.screenStatus?.('fixture').state, 'live');
    assert.equal(launches.length, 1);
    assert.ok(daemonActions.includes('screenshot'));
    assert.ok(!daemonActions.includes('navigate'));
    await restored.close('fixture');
    const before = daemonActions.length;
    assert.ok(await restored.screenshot('fixture'));
    assert.equal(restored.screenStatus?.('fixture').state, 'last_known');
    assert.equal(daemonActions.length, before);
  } finally {
    await restored.dispose();
    await original.dispose();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('a restarted credential session serves only its cached masked image without reading the page', async () => {
  const directory = await mkdtemp('/tmp/sk-sensitive-screen-');
  const fixture = stagedLoginBrowser();
  const original = createAgentBrowserComputer({ dataRoot: directory, run: fixture.run });
  let commands = 0;
  const restored = createAgentBrowserComputer({
    dataRoot: directory,
    run: async () => {
      commands += 1;
      throw new Error('No daemon command should run for a recovered sensitive screen.');
    },
  });
  try {
    await original.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const inspection = await original.inspectLogin('fixture');
    await original.injectCredentials({
      taskId: 'fixture',
      origin: inspection.origin,
      kind: 'identifier',
      username: 'synthetic-secret@example.test',
      usernameSelector: inspection.fields[0].selector,
      submitSelector: inspection.submitSelector,
    });
    const masked = await original.screenshot('fixture');
    assert.equal(masked?.includes(Buffer.from('synthetic-secret@example.test')), false);
    assert.deepEqual(await restored.screenshot('fixture'), masked);
    assert.equal(restored.screenStatus?.('fixture').state, 'last_known');
    assert.equal(commands, 0);
    await assert.rejects(restored.inspectLogin('fixture'), /Open the login page/);
    const metadata = await readFile(join(directory, 'runtime/screen-fixture.json'), 'utf8');
    assert.equal(metadata.includes('synthetic-secret'), false);
  } finally {
    await original.dispose();
    await restored.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
