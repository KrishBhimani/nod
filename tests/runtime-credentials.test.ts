import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { credentialFields, credentialScript } from '../src/providers/agent-browser/credentials.ts';

class Input {
  isConnected = true;
  disabled = false;
  readOnly = false;
  type = 'text';
  visible = true;
  stored = '';
  masks: string[] = [];
  clicked = false;
  afterEvent = () => {};
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
  dispatchEvent() {
    this.afterEvent();
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
    moveAfterUsername?: boolean;
  } = {},
) {
  const location = { origin: options.origin ?? 'https://example.com' };
  const username = new Input();
  const password = new Input();
  password.type = options.passwordType ?? 'password';
  password.visible = !options.hidden;
  const submit = new Input();
  if (options.moveAfterUsername)
    username.afterEvent = () => {
      location.origin = 'https://other.example';
    };
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
  const result = runInNewContext(credentialScript('https://example.com', fields, '#submit'), {
    location,
    document: { querySelectorAll: (selector: string) => nodes.get(selector) ?? [] },
    HTMLInputElement: Input,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    Event: class {},
  });
  return { result: JSON.parse(JSON.stringify(result)), username, password, submit };
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

test('credential entry masks fields, returns no values and rechecks origin after events', () => {
  const success = page();
  assert.deepEqual(success.result, { ok: true });
  assert.equal(success.password.value, 'fixture-secret');
  assert.equal(success.password.masks.includes('-webkit-text-security'), true);
  assert.equal(success.submit.clicked, true);
  const changed = page({ moveAfterUsername: true });
  assert.deepEqual(changed.result, { ok: false });
  assert.equal(changed.password.value, '');
  assert.equal(changed.submit.clicked, false);
});

test('secure entry rejects transient refs and missing secrets before browser execution', () => {
  assert.throws(() =>
    credentialFields({
      threadId: 'fixture',
      origin: 'https://example.com',
      password: 'fixture',
      passwordSelector: '@e2',
    }),
  );
  assert.throws(() =>
    credentialFields({
      threadId: 'fixture',
      origin: 'https://example.com',
      kind: 'otp',
      password: 'not-a-code',
      passwordSelector: '#code',
    }),
  );
});
