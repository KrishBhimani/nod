import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
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
  });
  const nodes = new Map([
    ['#user', [username]],
    ['#pass', options.duplicates ? [password, new Input()] : [password]],
    ['#submit', [submit]],
  ]);
  const script = credentialScript('https://example.com', fields, 'fixture');
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

test('secure entry rejects fields hidden by an ancestor', () => {
  for (const attribute of ['hidden', 'aria-hidden="true"', 'inert']) {
    const dom = new JSDOM(`<div ${attribute}><input id="password" type="password"></div>`, {
      url: 'https://example.com/login',
      runScripts: 'outside-only',
    });
    dom.window.HTMLElement.prototype.getClientRects = () =>
      [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
    try {
      const result = dom.window.eval(
        credentialScript('https://example.com', [
          { selector: '#password', value: 'synthetic-secret', password: true },
        ]),
      ) as { ok: boolean };
      assert.equal(result.ok, false);
      assert.equal(dom.window.document.querySelector('input')!.value, '');
    } finally {
      dom.window.close();
    }
  }
});
