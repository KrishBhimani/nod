import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserActionError } from '../src/ports/computer.ts';
import type { runProcess } from '../src/providers/process.ts';
import { createBrowserFixture } from './browser-fixture.ts';

test('a saved profile moves between tasks and is removed with its private screens', async () => {
  const directory = await mkdtemp('/tmp/sk-browser-profile-');
  const first = randomUUID();
  const second = randomUUID();
  const profile = randomUUID();
  const urls = new Map<string, string>();
  const profiles: string[] = [];
  const run: typeof runProcess = async (_executable, args) => {
    const session = args[args.indexOf('--session') + 1];
    if (args.includes('info'))
      return {
        stdout: JSON.stringify({ success: true, data: { active: urls.has(session) } }),
        stderr: '',
        exitCode: 0,
      };
    const command = args.slice(args.indexOf('--idle-timeout') + 2);
    let data: Record<string, unknown> = {};
    if (command[0] === 'open') {
      profiles.push(args[args.indexOf('--profile') + 1]);
      urls.set(session, command[1]);
    }
    if (command[0] === 'get') data = { url: urls.get(session) };
    if (command[0] === 'eval')
      data = { result: { text: 'Synthetic account', values: [], inputValues: [] } };
    if (command[0] === 'snapshot') data = { snapshot: 'Synthetic account' };
    if (command[0] === 'screenshot') await writeFile(command[1], 'synthetic-png');
    if (command[0] === 'close') urls.delete(session);
    return { stdout: JSON.stringify({ success: true, data }), stderr: '', exitCode: 0 };
  };
  const computer = createBrowserFixture({ dataRoot: directory, run });
  const profilePath = join(directory, 'runtime/profiles', profile);
  try {
    await computer.bindProfile?.(first, profile);
    await computer.act(first, { action: 'open', url: 'https://www.linkedin.com/jobs/' });
    await mkdir(profilePath, { recursive: true });
    await writeFile(join(profilePath, 'cookie-fixture'), 'private-cookie');
    await computer.bindProfile?.(first, profile, 'https://www.linkedin.com');
    await assert.rejects(
      computer.act(first, { action: 'open', url: 'https://www.technogym.com/en-IE/' }),
      (error: unknown) =>
        error instanceof BrowserActionError && error.code === 'browser_origin_changed',
    );
    await computer.bindProfile?.(second, profile, 'https://www.linkedin.com');
    await computer.act(second, { action: 'open', url: 'https://www.linkedin.com/messaging/' });
    assert.equal(profiles[0], profilePath);
    assert.equal(profiles.at(-1), profilePath);
    assert.equal(await readFile(join(profilePath, 'cookie-fixture'), 'utf8'), 'private-cookie');
    await computer.deleteProfile?.(profile);
    assert.equal(await stat(profilePath).catch(() => null), null);
    assert.equal(
      await stat(join(directory, `runtime/screen-${first}.json`)).catch(() => null),
      null,
    );
    assert.equal(
      await stat(join(directory, `runtime/screen-${second}.json`)).catch(() => null),
      null,
    );
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a native website sign-in restores the same browser in the next task', async () => {
  const directory = await mkdtemp('/tmp/sk-browser-native-profile-');
  const first = randomUUID();
  const second = randomUUID();
  const profile = randomUUID();
  const urls = new Map<string, string>();
  const launches: string[][] = [];
  const run: typeof runProcess = async (_executable, args) => {
    const session = args[args.indexOf('--session') + 1];
    if (args.includes('info'))
      return {
        stdout: JSON.stringify({ success: true, data: { active: urls.has(session) } }),
        stderr: '',
        exitCode: 0,
      };
    const command = args.slice(args.indexOf('--idle-timeout') + 2);
    let data: Record<string, unknown> = {};
    if (command[0] === 'open') {
      launches.push(args);
      urls.set(session, command[1]);
    }
    if (command[0] === 'get') data = { url: urls.get(session) };
    if (command[0] === 'eval')
      data = { result: { text: 'Synthetic account', values: [], inputValues: [] } };
    if (command[0] === 'snapshot') data = { snapshot: 'Synthetic account' };
    if (command[0] === 'screenshot') await writeFile(command[1], 'synthetic-png');
    if (command[0] === 'close') urls.delete(session);
    return { stdout: JSON.stringify({ success: true, data }), stderr: '', exitCode: 0 };
  };
  const computer = createBrowserFixture({
    dataRoot: directory,
    run,
    resolveSignInBrowser: async () => '/fixture/chrome',
    signInLauncher: {
      async start() {
        let closed = false;
        return {
          get closed() {
            return closed;
          },
          exited: new Promise<void>(() => {}),
          async close() {
            closed = true;
          },
        };
      },
    },
  });
  try {
    await computer.bindProfile?.(first, profile);
    await computer.act(first, { action: 'open', url: 'https://www.linkedin.com/messaging/' });
    await computer.openSignIn?.(first);
    await computer.finishSignIn?.(first);
    await computer.bindProfile?.(first, profile, 'https://www.linkedin.com');
    await computer.bindProfile?.(second, profile, 'https://www.linkedin.com');
    await computer.act(second, { action: 'open', url: 'https://www.linkedin.com/messaging/' });
    const next = launches.at(-1)!;
    assert.equal(next[next.indexOf('--profile') + 1], join(directory, 'runtime/profiles', profile));
    assert.equal(next[next.indexOf('--executable-path') + 1], '/fixture/chrome');
    assert.ok(next.some((arg) => arg.includes('--restore-last-session')));
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
