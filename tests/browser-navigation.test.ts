import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserActionError } from '../src/ports/computer.ts';
import { createBrowserFixture as createAgentBrowserComputer } from './browser-fixture.ts';
import type { runProcess } from '../src/providers/process.ts';
import { LoginPage, stagedLoginBrowser } from './login-fixture.ts';

test('a browser observation waits for a page that first renders with no text', async () => {
  const directory = await mkdtemp('/tmp/sk-hydration-');
  const browser = stagedLoginBrowser();
  const page = new LoginPage();
  const text = page.text.bind(page);
  const readyAt = Date.now() + 300;
  page.text = () => (Date.now() < readyAt ? '' : text());
  browser.pages.set('fixture', page);
  const computer = createAgentBrowserComputer({ dataRoot: directory, run: browser.run });
  try {
    const result = await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    assert.match(result.text, /Sign in/);
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed public navigation stays diagnosable without exposing a browser error page and a new open recovers', async () => {
  const directory = await mkdtemp('/tmp/sk-navigation-');
  const commands: string[] = [];
  let failed = false;
  const run: typeof runProcess = async (_executable, args) => {
    if (args.includes('info'))
      return {
        stdout: JSON.stringify({ success: true, data: { active: false } }),
        stderr: '',
        exitCode: 0,
      };
    const command = args.slice(args.indexOf('--idle-timeout') + 2);
    commands.push(command[0]);
    let data: Record<string, unknown> = {};
    if (command[0] === 'open') {
      failed = command[1].includes('/denied');
      if (failed)
        return {
          stdout: JSON.stringify({
            success: false,
            error: 'Navigation failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE PRIVATE-UPSTREAM',
          }),
          stderr: '',
          exitCode: 1,
        };
    }
    if (command[0] === 'get')
      data = { url: failed ? 'chrome-error://chromewebdata/' : 'https://1.1.1.1/' };
    if (command[0] === 'eval')
      data = { result: { text: 'Synthetic public page', masked: true, values: [] } };
    if (command[0] === 'snapshot') data = { snapshot: 'Synthetic public page' };
    if (command[0] === 'screenshot') await writeFile(command[1], 'synthetic-png');
    return { stdout: JSON.stringify({ success: true, data }), stderr: '', exitCode: 0 };
  };
  const computer = createAgentBrowserComputer({ dataRoot: directory, run });
  const restored = createAgentBrowserComputer({ dataRoot: directory, run });
  const failure = (error: unknown) => {
    assert.ok(error instanceof BrowserActionError);
    assert.equal(error.code, 'browser_navigation_failed');
    assert.doesNotMatch(error.message, /PRIVATE|chrome-error|HTTP_RESPONSE/);
    return true;
  };
  try {
    await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/' });
    assert.ok(await computer.screenshot('fixture'));
    await assert.rejects(
      computer.act('fixture', {
        action: 'open',
        url: 'https://1.1.1.1/denied?token=private-query',
      }),
      failure,
    );
    const before = commands.length;
    const observation = await computer.act('fixture', { action: 'snapshot' });
    assert.equal(observation.url, 'https://1.1.1.1/denied');
    assert.deepEqual(observation.candidates, []);
    assert.match(observation.text, /website did not load/);
    assert.doesNotMatch(JSON.stringify(observation), /private-query|PRIVATE|chrome-error/);
    await assert.rejects(computer.screenshot('fixture'), failure);
    await assert.rejects(computer.inspectLogin('fixture'), failure);
    await assert.rejects(computer.act('fixture', { action: 'click', selector: '#old' }), failure);
    assert.equal(commands.length, before);
    const stored = JSON.parse(
      await readFile(join(directory, 'runtime/screen-fixture.json'), 'utf8'),
    );
    assert.equal(stored.active, false);
    assert.equal(stored.navigationFailed, true);
    assert.equal(stored.url, 'https://1.1.1.1/denied');
    await assert.rejects(restored.screenshot('fixture'), failure);
    assert.deepEqual(await restored.act('fixture', { action: 'snapshot' }), observation);
    await assert.rejects(restored.inspectLogin('fixture'), failure);
    const blocked = await computer
      .act('blocked', { action: 'open', url: 'file:///private' })
      .catch((error) => error);
    assert.equal(blocked instanceof BrowserActionError, false);
    assert.match(blocked.message, /HTTP or HTTPS/);
    const beforeReopen = commands.length;
    await restored.act('fixture', { action: 'open', url: 'https://1.1.1.1/' });
    assert.deepEqual(commands.slice(beforeReopen, beforeReopen + 2), ['close', 'open']);
    assert.ok(await restored.screenshot('fixture'));
    assert.equal(
      JSON.parse(await readFile(join(directory, 'runtime/screen-fixture.json'), 'utf8'))
        .navigationFailed,
      false,
    );
  } finally {
    await restored.dispose();
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
