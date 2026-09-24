import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  createAgentBrowserComputer,
  redactBrowserUrl,
} from '../src/providers/agent-browser/index.ts';
import { stagedLoginBrowser } from './login-fixture.ts';

test('login observations redact OAuth callback values and identifiers from URLs', () => {
  const url = redactBrowserUrl(
    'https://example.com/callback?code=private-code&email=private-email&state=private-state&view=account#access_token=private-token',
    [],
  );
  for (const value of ['private-code', 'private-email', 'private-state', 'private-token'])
    assert.equal(url.includes(value), false);
  assert.equal(new URL(url).searchParams.get('view'), 'account');
});

test('staged identifier, password and OTP entry waits for Next and keeps secrets out of observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-staged-login-'));
  const fixture = stagedLoginBrowser();
  const computer = createAgentBrowserComputer({ dataRoot: directory, run: fixture.run });
  try {
    await computer.act('login', { action: 'open', url: 'https://1.1.1.1/login' });
    const first = await computer.inspectLogin('login');
    assert.deepEqual(
      first.fields.map((field) => field.kind),
      ['identifier'],
    );
    assert.equal(first.methods.find((method) => method.kind === 'oauth')?.supported, true);
    assert.equal(first.methods.find((method) => method.kind === 'passkey')?.supported, false);
    assert.equal(first.methods.find((method) => method.kind === 'manual')?.supported, false);
    await assert.rejects(
      computer.act('login', {
        action: 'fill',
        selector: first.fields[0].selector,
        text: 'not-through-chat',
      }),
      /secure credential/,
    );
    const identifier = computer.injectCredentials({
      taskId: 'login',
      origin: first.origin,
      kind: 'identifier',
      username: 'synthetic-account@example.test',
      usernameSelector: first.fields[0].selector,
      submitSelector: first.submitSelector,
    });
    await delay(1);
    await assert.rejects(computer.screenshot('login'), /paused/);
    await identifier;
    const password = await computer.inspectLogin('login');
    assert.deepEqual(
      password.fields.map((field) => field.kind),
      ['password'],
    );
    await computer.injectCredentials({
      taskId: 'login',
      origin: password.origin,
      kind: 'password',
      password: 'synthetic-password',
      passwordSelector: password.fields[0].selector,
      submitSelector: password.submitSelector,
    });
    const otp = await computer.inspectLogin('login');
    assert.deepEqual(
      otp.fields.map((field) => field.kind),
      ['otp'],
    );
    await computer.injectCredentials({
      taskId: 'login',
      origin: otp.origin,
      kind: 'otp',
      code: '739204',
      passwordSelector: otp.fields[0].selector,
      submitSelector: otp.submitSelector,
    });
    assert.equal(fixture.pages.get('login')?.stage, 'complete');
    const observation = await computer.act('login', { action: 'snapshot' });
    const screen = await computer.screenshot('login');
    for (const secret of ['synthetic-account@example.test', 'synthetic-password', '739204']) {
      assert.equal(JSON.stringify(observation).includes(secret), false);
      assert.equal(screen?.includes(Buffer.from(secret)), false);
    }
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('waiting holds preserve the page across idle cleanup and OAuth selection requires the current origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-login-hold-'));
  const fixture = stagedLoginBrowser();
  const computer = createAgentBrowserComputer({
    dataRoot: directory,
    run: fixture.run,
    idleTimeoutMs: 25,
  });
  try {
    await computer.act('login', { action: 'open', url: 'https://1.1.1.1/login' });
    await computer.hold('login', Date.now() + 2000);
    await delay(80);
    assert.ok(await computer.screenshot('login'));
    assert.equal(fixture.pages.get('login')?.closed, false);
    const inspection = await computer.inspectLogin('login');
    const oauth = inspection.methods.find((method) => method.kind === 'oauth')!;
    await assert.rejects(
      computer.selectLoginMethod('login', 'https://3.3.3.3', oauth.id),
      /no longer available/,
    );
    await assert.rejects(
      computer.selectLoginMethod('login', inspection.origin, 'passkey'),
      /no longer available/,
    );
    const verification = inspection.methods.find((method) =>
      method.id.startsWith('verification-email'),
    )!;
    assert.equal(verification.supported, true);
    await computer.selectLoginMethod('login', inspection.origin, verification.id);
    assert.equal((await computer.inspectLogin('login')).fields[0].kind, 'otp');
    await computer.selectLoginMethod('login', inspection.origin, oauth.id);
    assert.equal((await computer.inspectLogin('login')).origin, 'https://2.2.2.2');
    await assert.rejects(
      computer.selectLoginMethod('login', inspection.origin, oauth.id),
      /no longer available/,
    );
    await computer.hold('login', null);
    for (let attempt = 0; attempt < 100 && !fixture.pages.get('login')?.closed; attempt += 1)
      await delay(10);
    assert.ok(await computer.screenshot('login'));
    assert.equal(computer.screenStatus?.('login').state, 'last_known');
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
