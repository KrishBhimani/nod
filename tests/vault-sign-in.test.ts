import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import { JSDOM } from 'jsdom';
import pg, { type Pool } from 'pg';
import type {
  Agent,
  AgentToolResult,
  RuntimeContext,
  RuntimeObservation,
} from '../src/ports/agent.ts';
import {
  credentialFeedback,
  credentialFeedbackScript,
  credentialFields,
  credentialScript,
} from '../src/providers/agent-browser/credentials.ts';
import { credentialSubmitScript } from '../src/providers/agent-browser/login.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import {
  BrowserConnectionError,
  createBrowserConnections,
} from '../src/server/browser-connections.ts';
import type { TurnRef } from '../src/server/thread.ts';
import { createVault, openCredential } from '../src/server/vault.ts';
import { createBrowserFixture as createAgentBrowserComputer } from './browser-fixture.ts';
import { LoginPage, stagedLoginBrowser } from './login-fixture.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

class Input {
  isConnected = true;
  disabled = false;
  readOnly = false;
  type = 'text';
  visible = true;
  stored = '';
  masks: string[] = [];
  clicked = false;
  attributes = new Map<string, string>();
  style = {
    setProperty: (name: string) => {
      this.masks.push(name);
    },
  };
  get value() {
    return this.stored;
  }
  set value(value: string) {
    this.stored = value;
  }
  getClientRects() {
    return this.visible ? [{}] : [];
  }
  matches(value: string) {
    return value === 'input';
  }
  closest() {
    return null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  click() {
    this.clicked = true;
  }
}

function page(
  options: {
    origin?: string;
    passwordType?: string;
    hidden?: boolean;
    duplicates?: boolean;
  } = {},
) {
  const location = { origin: options.origin ?? 'https://example.com' };
  const username = new Input();
  const password = new Input();
  password.type = options.passwordType ?? 'password';
  password.visible = !options.hidden;
  const submit = new Input();
  const fields = credentialFields({
    threadId: 'fixture',
    origin: 'https://example.com',
    kind: 'password',
    username: 'fixture-user',
    password: 'fixture-secret',
    usernameSelector: '#user',
    passwordSelector: '#pass',
    submitSelector: '#submit',
  });
  const nodes = new Map([
    ['#user', [username]],
    ['#pass', options.duplicates ? [password, new Input()] : [password]],
    ['#submit', [submit]],
  ]);
  const script = credentialScript('https://example.com', fields, '#submit', 'fixture');
  const result = runInNewContext(script, {
    location,
    document: { querySelectorAll: (selector: string) => nodes.get(selector) ?? [] },
    HTMLInputElement: Input,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    Event: class {},
  });
  return { result: JSON.parse(JSON.stringify(result)), username, password, submit, script };
}

test('credential entry verifies origin and every target before filling any values', () => {
  for (const options of [
    { origin: 'https://other.example' },
    { passwordType: 'text' },
    { hidden: true },
    { duplicates: true },
  ]) {
    const { result, username, password, submit } = page(options);
    assert.deepEqual(result, { ok: false });
    assert.equal(username.value, '');
    assert.equal(password.value, '');
    assert.equal(submit.clicked, false);
  }
});

test('credential entry masks and marks fields without writing private values', () => {
  const success = page();
  assert.deepEqual(success.result, { ok: true, counts: [1, 1] });
  assert.equal(success.username.value, '');
  assert.equal(success.password.value, '');
  assert.equal(success.password.masks.includes('-webkit-text-security'), true);
  assert.equal(success.username.attributes.get('data-otto-entry-target'), 'fixture-0-0');
  assert.equal(success.password.attributes.get('data-otto-entry-target'), 'fixture-1-0');
  assert.equal(success.submit.clicked, false);
  assert.equal(success.script.includes('fixture-secret'), false);
});

function domFixture(html: string) {
  const dom = new JSDOM(html, { url: 'https://example.com/login', runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.getClientRects = () =>
    [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
  return {
    dom,
    read: (mark = false, kind: 'identifier' | 'password' | 'otp' = 'password') =>
      credentialFeedback(
        dom.window.eval(credentialFeedbackScript('https://example.com', kind, 'domFixture', mark)),
      )!,
  };
}

test('credential feedback distinguishes fresh rejection from old alerts without returning page text or entered values', () => {
  const page = domFixture(
    '<input type="password" value="private-input-domFixture"><p role="alert"></p><div hidden><p role="alert">Incorrect hidden text</p></div>',
  );
  try {
    const before = page.read(true);
    assert.equal(before.rejected, false);
    assert.equal(before.sameDocument, true);
    page.dom.window.document.querySelector('p')!.textContent =
      'Email or password was incorrect: private-error-domFixture';
    const rejected = page.read();
    assert.equal(rejected.rejected, true);
    assert.equal(rejected.advanced, false);
    assert.notEqual(rejected.fingerprint, before.fingerprint);
    for (const secret of ['private-input-domFixture', 'private-error-domFixture', 'incorrect'])
      assert.equal(JSON.stringify(rejected).includes(secret), false);
    const oldAlert = page.read(true);
    assert.deepEqual(page.read(), oldAlert);
    page.dom.window.document.documentElement.removeAttribute('data-otto-entry-attempt');
    const navigated = page.read();
    assert.equal(navigated.rejected, true);
    assert.equal(navigated.sameDocument, false);
    assert.equal(navigated.fingerprint, oldAlert.fingerprint);
  } finally {
    page.dom.window.close();
  }
});

test('secure entry and delayed submit reject fields or controls hidden by ancestors', async () => {
  for (const attribute of ['hidden', 'aria-hidden="true"', 'inert', 'aria-disabled="true"']) {
    const page = domFixture(
      `<div ${attribute}><input id="password" type="password"><button id="submit">Continue</button></div>`,
    );
    try {
      let clicked = false;
      page.dom.window.document.querySelector('button')!.onclick = () => {
        clicked = true;
      };
      page.dom.window.setTimeout = ((run: () => void) => {
        run();
        return 0;
      }) as typeof page.dom.window.setTimeout;
      const input = page.dom.window.eval(
        credentialScript(
          'https://example.com',
          [{ selector: '#password', value: 'must-not-fill', password: true }],
          '#submit',
          'fixture',
        ),
      ) as { ok: boolean };
      assert.equal(input.ok, false);
      assert.equal(page.dom.window.document.querySelector('input')!.value, '');
      const submitted = (await page.dom.window.eval(
        credentialSubmitScript('https://example.com', '#submit'),
      )) as { ok: boolean };
      assert.equal(submitted.ok, false);
      assert.equal(clicked, false);
    } finally {
      page.dom.window.close();
    }
  }
});
