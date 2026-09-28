import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { browserSessionId } from '../src/providers/agent-browser/index.ts';
import { createBrowserFixture as createAgentBrowserComputer } from './browser-fixture.ts';
import { stagedLoginBrowser } from './login-fixture.ts';

for (const platform of ['darwin', 'linux'] as const) {
  test(`${platform} browser launch preserves secure login and platform display support`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otto-browser-launch-'));
    const fixture = stagedLoginBrowser();
    const launches: string[][] = [];
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      platform,
      run: async (...args) => {
        launches.push(args[1]);
        return fixture.run(...args);
      },
    });
    try {
      await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
      const launch = launches.find((args) => args.includes('open'))!;
      assert.equal(launch.includes('--headed'), platform === 'darwin');
      const flags = launch[launch.indexOf('--args') + 1].split(',');
      assert.equal(flags.includes('--start-minimized'), platform === 'darwin');
      assert.ok(flags.includes('--disable-quic'));
      assert.ok(flags.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
      assert.match(launch[launch.indexOf('--proxy') + 1], /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(launch[launch.indexOf('--proxy-bypass') + 1], '<-loopback>');
      assert.equal(
        launch[launch.indexOf('--profile') + 1],
        join(directory, 'runtime/profiles/fixture'),
      );
      assert.doesNotMatch(
        launch.join(' '),
        /--(?:user-agent|disable-blink-features|ignore-certificate-errors)/,
      );
      const login = await computer.inspectLogin('fixture');
      assert.equal(login.fields[0].kind, 'identifier');
      assert.equal(login.methods[0].kind, 'credentials');
      assert.ok(await computer.screenshot('fixture'));
    } finally {
      await computer.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('a recovered headless browser stays observable until explicit navigation relaunches it headed', async () => {
  const directory = await mkdtemp('/tmp/sk-display-');
  const fixture = stagedLoginBrowser();
  const original = createAgentBrowserComputer({
    dataRoot: directory,
    platform: 'linux',
    run: fixture.run,
  });
  const socketPath = join(directory, `${browserSessionId('fixture')}.sock`);
  const events: string[] = [];
  const launches: string[][] = [];
  const daemon = createServer((socket) => {
    let input = '';
    socket.on('data', async (chunk) => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      const command = JSON.parse(input);
      input = '';
      events.push(command.action);
      const page = fixture.pages.get('fixture')!;
      let data: Record<string, unknown> = {};
      if (command.action === 'url') data = { url: page.location.href };
      if (command.action === 'evaluate') data = { result: await page.evaluate(command.script) };
      if (command.action === 'screenshot') await writeFile(command.path, page.screen());
      socket.end(JSON.stringify({ success: true, data }) + '\n');
    });
  });
  await new Promise<void>((resolve) => daemon.listen(socketPath, resolve));
  const restored = createAgentBrowserComputer({
    dataRoot: directory,
    platform: 'darwin',
    run: async (executable, args, options) => {
      if (args.includes('info'))
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
      launches.push(args);
      events.push(args[args.indexOf('--idle-timeout') + 2]);
      return fixture.run(executable, args, options);
    },
  });
  try {
    await original.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    assert.ok(await restored.screenshot('fixture'));
    assert.equal(restored.screenStatus?.('fixture').state, 'live');
    assert.equal(launches.length, 0);
    assert.ok(events.includes('screenshot'));
    assert.ok(!events.includes('close'));
    assert.ok(!events.includes('navigate'));
    await restored.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    assert.ok(events.indexOf('close') < events.indexOf('open'));
    const launch = launches.find((args) => args.includes('open'))!;
    assert.ok(launch.includes('--headed'));
    assert.equal(
      launch[launch.indexOf('--profile') + 1],
      join(directory, 'runtime/profiles/fixture'),
    );
    assert.equal((await restored.inspectLogin('fixture')).fields[0].kind, 'identifier');
    assert.ok(await restored.screenshot('fixture'));
  } finally {
    await restored.dispose();
    await original.dispose();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
