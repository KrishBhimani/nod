import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { redactBrowserText, redactBrowserUrl } from '../src/providers/agent-browser/index.ts';
import {
  loginInspectionSchema,
  loginInspectionScript,
} from '../src/providers/agent-browser/login.ts';
import { createBrowserFixture as createAgentBrowserComputer } from './browser-fixture.ts';
import { LoginDom, LoginElement, stagedLoginBrowser } from './login-fixture.ts';

function element(tag: string, attributes: Record<string, string> = {}, text = '') {
  const value = new LoginElement();
  value.tagName = tag.toUpperCase();
  value.innerText = text;
  for (const [name, content] of Object.entries(attributes)) {
    if (['type', 'id', 'name', 'autocomplete'].includes(name))
      Object.assign(value, { [name]: content });
    else value.setAttribute(name, content);
  }
  return value;
}

test('visible browser-security login rejection removes credential fields and OAuth methods', () => {
  for (const message of [
    'This browser or app may not be secure.',
    'Couldn’t sign you in. Your browser is not supported.',
    "Couldn't sign you in. Try using a supported browser.",
  ]) {
    const page = new LoginDom();
    page.body.append(
      element('p', {}, message),
      element('input', { type: 'email' }),
      element('button', {}, 'Continue with Google'),
    );
    const inspection = loginInspectionSchema.parse(page.evaluate(loginInspectionScript()));
    assert.equal(inspection.issue, 'browser_not_supported');
    assert.deepEqual(inspection.fields, []);
    assert.deepEqual(inspection.methods, []);
    assert.equal(inspection.submitSelector, undefined);
    assert.equal(page.querySelectorAll('[data-sidekick-login-field]').length, 0);
  }
});

test('ordinary sign-in rejection and hidden or background browser warnings do not block secure entry', () => {
  for (const message of [
    'Wrong password. Try again.',
    "Couldn't sign you in. Check your password.",
    'Use a supported browser for the best experience.',
  ]) {
    const page = new LoginDom();
    page.body.append(
      element('p', {}, message),
      element('p', { hidden: '' }, 'This browser or app may not be secure.'),
      element('p', { 'aria-hidden': 'true' }, 'Your browser is not supported.'),
      element('input', { type: 'password' }),
      element('button', {}, 'Sign in'),
    );
    const inspection = loginInspectionSchema.parse(page.evaluate(loginInspectionScript()));
    assert.equal(inspection.issue, undefined);
    assert.equal(inspection.fields[0].kind, 'password');
    assert.equal(inspection.methods[0].supported, true);
  }
  const page = new LoginDom();
  page.body.append(element('p', {}, 'This browser or app may not be secure.'));
  const dialog = element('div', { role: 'dialog' });
  dialog.append(element('input', { type: 'email' }), element('button', {}, 'Continue'));
  page.body.append(dialog);
  const inspection = loginInspectionSchema.parse(page.evaluate(loginInspectionScript()));
  assert.equal(inspection.issue, undefined);
  assert.equal(inspection.fields[0].kind, 'identifier');
});

test('login inspection scopes fields to the active dialog and deduplicates nested Apple controls', () => {
  const page = new LoginDom();
  const background = element('form');
  const oldInput = element('input', { type: 'email', 'data-sidekick-login-field': 'identifier-0' });
  background.append(oldInput, element('button', {}, 'Continue with Apple'));
  const modal = element('div', { role: 'dialog' });
  const form = element('form');
  const input = element('input', { id: 'login-username', autocomplete: 'username' });
  form.append(input, element('button', {}, 'Next'));
  const wrapper = element('div', { role: 'button' }, 'Continue with Apple');
  const apple = element('button', {}, 'Continue with Apple');
  wrapper.append(apple);
  modal.append(form, wrapper, element('button', {}, 'Continue with Apple'));
  page.body.append(background, modal);
  page.activeElement = input;
  const inspection = loginInspectionSchema.parse(page.evaluate(loginInspectionScript()));
  assert.equal(inspection.fields.length, 1);
  assert.equal(inspection.fields[0].kind, 'identifier');
  assert.equal(inspection.methods.find((method) => method.id === 'credentials')?.supported, true);
  assert.equal(
    inspection.methods.filter((method) => method.label === 'Continue with Apple').length,
    1,
  );
  assert.equal(
    inspection.methods.find((method) => method.kind === 'manual'),
    undefined,
  );
  assert.equal(page.querySelectorAll(inspection.fields[0].selector)[0], input);
  assert.equal(oldInput.getAttribute('data-sidekick-login-field'), null);
  const oauth = inspection.methods.find((method) => method.kind === 'oauth')!;
  assert.equal(page.querySelectorAll(oauth.selector!).length, 1);
  assert.equal(page.querySelectorAll(oauth.selector!)[0], apple);
});

test('login inspection uses visible labels, IDs and autocomplete without reading entered values', () => {
  const page = new LoginDom();
  const form = element('form');
  const username = element('input', { id: 'account-name' });
  username.labels = [element('label', {}, 'Phone, email or username')];
  Object.defineProperty(username, 'value', {
    get() {
      throw new Error('Entered values must not be inspected');
    },
  });
  const password = element('input', { type: 'password', autocomplete: 'current-password' });
  form.append(username, password, element('button', {}, 'Sign in'));
  page.body.append(form);
  let inspection = loginInspectionSchema.parse(page.evaluate(loginInspectionScript()));
  assert.deepEqual(
    inspection.fields.map((field) => field.kind),
    ['identifier', 'password'],
  );
  assert.equal(inspection.methods[0].supported, true);
  username.labels = [];
  username.id = 'verification-code';
  password.setAttribute('hidden', '');
  inspection = loginInspectionSchema.parse(page.evaluate(loginInspectionScript()));
  assert.deepEqual(
    inspection.fields.map((field) => field.kind),
    ['otp'],
  );
});

test('credential choices use the observed identifier label with specific field fallbacks', () => {
  for (const [attributes, observed, expected] of [
    [{ type: 'email' }, '', 'Email'],
    [{ type: 'tel' }, '', 'Phone'],
    [{ autocomplete: 'username' }, '', 'Username'],
    [{ autocomplete: 'username' }, 'Email or phone', 'Email or phone'],
    [{ type: 'password' }, '', 'Password'],
    [{ autocomplete: 'one-time-code' }, '', 'Verification code'],
  ] as const) {
    const page = new LoginDom();
    const input = element('input', attributes);
    if (observed) input.labels = [element('label', {}, observed)];
    page.body.append(input, element('button', {}, 'Continue'));
    const inspection = loginInspectionSchema.parse(page.evaluate(loginInspectionScript()));
    assert.equal(inspection.fields[0].label, expected);
    assert.equal(inspection.methods.find((method) => method.id === 'credentials')?.label, expected);
  }
});

test('multiple real identifiers or unfocused forms remain unsupported while the focused form is isolated', () => {
  const page = new LoginDom();
  const first = element('form');
  const firstInput = element('input', { autocomplete: 'username' });
  first.append(firstInput, element('button', {}, 'Continue'));
  const second = element('form');
  second.append(element('input', { type: 'email' }), element('button', {}, 'Sign in'));
  page.body.append(first, second);
  let inspection = loginInspectionSchema.parse(page.evaluate(loginInspectionScript()));
  assert.equal(inspection.methods[0].supported, false);
  assert.equal(inspection.submitSelector, undefined);
  page.activeElement = firstInput;
  inspection = loginInspectionSchema.parse(page.evaluate(loginInspectionScript()));
  assert.equal(inspection.fields.length, 1);
  assert.equal(inspection.methods[0].supported, true);
  first.append(element('input', { type: 'email' }));
  inspection = loginInspectionSchema.parse(page.evaluate(loginInspectionScript()));
  assert.equal(inspection.methods[0].supported, false);
  assert.equal(inspection.submitSelector, undefined);
});

test('ambiguous dialogs and separate-window OAuth fail closed and inert controls are ignored', () => {
  const page = new LoginDom();
  const first = element('div', { role: 'dialog' });
  first.append(
    element('input', { autocomplete: 'username' }),
    element('a', { target: '_blank' }, 'Continue with Google'),
  );
  const second = element('dialog', { open: '' });
  const secondInput = element('input', { type: 'email' });
  second.append(secondInput);
  const hidden = element('div', { inert: '' });
  hidden.append(element('button', {}, 'Continue with Microsoft'));
  page.body.append(first, second, hidden);
  let inspection = loginInspectionSchema.parse(page.evaluate(loginInspectionScript()));
  assert.equal(inspection.methods.find((method) => method.id === 'credentials')?.supported, false);
  assert.equal(inspection.methods.find((method) => method.id === 'oauth-google')?.supported, false);
  assert.equal(
    inspection.methods.find((method) => method.id === 'oauth-microsoft'),
    undefined,
  );
  page.activeElement = secondInput;
  inspection = loginInspectionSchema.parse(page.evaluate(loginInspectionScript()));
  assert.equal(inspection.fields.length, 1);
  assert.equal(inspection.methods.find((method) => method.id === 'credentials')?.supported, true);
});

test('a nested separate-window OAuth link cannot become supported through its wrapper', () => {
  const page = new LoginDom();
  const wrapper = element('div', { role: 'button' }, 'Continue with Apple');
  wrapper.append(element('a', { target: '_blank' }, 'Continue with Apple'));
  page.body.append(wrapper);
  const inspection = loginInspectionSchema.parse(page.evaluate(loginInspectionScript()));
  assert.equal(inspection.methods.length, 1);
  assert.equal(inspection.methods[0].supported, false);
});

test('login observations redact OAuth callback values and identifiers from URLs', () => {
  const url = redactBrowserUrl(
    'https://example.com/callback?code=private-code&email=private-email&state=private-state&view=account#access_token=private-token',
    [],
  );
  for (const value of ['private-code', 'private-email', 'private-state', 'private-token'])
    assert.equal(url.includes(value), false);
  assert.equal(new URL(url).searchParams.get('view'), 'account');
});

test('browser observations redact manually typed secrets in encoded paths and unknown query fields', () => {
  const secret = 'fixture secret/with+symbols';
  const variants = [
    encodeURIComponent(secret),
    encodeURI(secret),
    new URLSearchParams({ value: secret }).toString().slice(6),
  ];
  for (const value of variants) {
    assert.equal(redactBrowserText(value, [secret]), '[redacted]');
    assert.equal(
      redactBrowserText(
        value.replace(/%[0-9A-F]{2}/g, (code) => code.toLowerCase()),
        [secret],
      ),
      '[redacted]',
    );
    assert.equal(
      redactBrowserUrl(`https://example.com/${value}?other=${value}`, [secret]).includes(value),
      false,
    );
  }
  assert.doesNotThrow(() => redactBrowserText('fixture', ['\ud800']));
});

test('browser observations redact common API credentials and signed URL query values', () => {
  for (const name of [
    'api_key',
    'apiKey',
    'X-API-Key',
    'client_secret',
    'clientSecret',
    'signature',
    'sig',
    'X-Amz-Signature',
    'X-Amz-Credential',
    'X-Goog-Signature',
    'X-Goog-Credential',
  ]) {
    const value = redactBrowserUrl(
      `https://example.com/download?${name}=synthetic-private-value&view=account`,
      [],
    );
    assert.equal(value.includes('synthetic-private-value'), false, name);
    assert.equal(new URL(value).searchParams.get('view'), 'account');
  }
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
    assert.equal(
      first.methods.find((method) => method.kind === 'manual'),
      undefined,
    );
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

test('a focused generic identifier is not replaced by an unrelated recognized form', () => {
  const page = new JSDOM(
    '<form id="login"><h1>Sign in</h1><input id="generic"><button>Next</button></form><form id="newsletter"><input type="email"><button>Subscribe</button></form>',
    { url: 'https://example.test/login', runScripts: 'outside-only' },
  );
  try {
    page.window.HTMLElement.prototype.getClientRects = () =>
      [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
    Object.defineProperty(page.window.HTMLElement.prototype, 'innerText', {
      get() {
        return this.textContent;
      },
    });
    const focused = page.window.document.getElementById('generic')!;
    focused.focus();
    const result = loginInspectionSchema.parse(page.window.eval(loginInspectionScript()));
    assert.equal(result.fields.length, 1);
    assert.equal(page.window.document.querySelector(result.fields[0].selector), focused);
    assert.equal(result.methods.find((method) => method.id === 'credentials')?.supported, true);
    focused.blur();
    const ambiguous = loginInspectionSchema.parse(page.window.eval(loginInspectionScript()));
    assert.equal(ambiguous.methods.find((method) => method.id === 'credentials')?.supported, false);
  } finally {
    page.window.close();
  }
});

test('login methods reject named, inherited and non-current browsing targets', () => {
  for (const html of [
    '<a target="popup">Continue with Google</a>',
    '<form target="popup"><button>Continue with Google</button></form>',
    '<form><button formtarget="popup">Continue with Google</button></form>',
    '<base target="popup"><a>Continue with Google</a>',
    '<a target="_top">Continue with Google</a>',
    '<form target="popup"><input type="password"><button>Sign in</button></form>',
  ]) {
    const page = new JSDOM(html, { url: 'https://example.test/login', runScripts: 'outside-only' });
    try {
      page.window.HTMLElement.prototype.getClientRects = () =>
        [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
      Object.defineProperty(page.window.HTMLElement.prototype, 'innerText', {
        get() {
          return this.textContent;
        },
      });
      const result = loginInspectionSchema.parse(page.window.eval(loginInspectionScript()));
      assert.ok(result.methods.length, html);
      assert.equal(
        result.methods.some((method) => method.supported),
        false,
        html,
      );
      assert.equal(result.submitSelector, undefined, html);
    } finally {
      page.window.close();
    }
  }
  const page = new LoginDom();
  page.body.append(element('a', { target: '_self' }, 'Continue with Google'));
  assert.equal(
    loginInspectionSchema.parse(page.evaluate(loginInspectionScript())).methods[0].supported,
    true,
  );
});
