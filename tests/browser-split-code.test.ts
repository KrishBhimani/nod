import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { credentialFields, credentialScript } from '../src/providers/agent-browser/credentials.ts';
import {
  loginInspectionSchema,
  loginInspectionScript,
} from '../src/providers/agent-browser/login.ts';

function fixture(html: string) {
  const dom = new JSDOM(html, { url: 'https://example.com/login', runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.getClientRects = function (this: HTMLElement) {
    return (this.closest('[hidden]')
      ? []
      : [{ x: 0, y: 0, width: 30, height: 30 }]) as unknown as DOMRectList;
  } as typeof dom.window.HTMLElement.prototype.getClientRects;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent;
    },
  });
  return dom;
}

const digits = Array.from(
  { length: 6 },
  (_, index) => `<input type="text" class="otp-input" maxlength="1" data-index="${index}">`,
).join('');

test('Portuguese login submit controls advance the observed password form', () => {
  const dom = fixture(
    '<form><input type="email"><input type="password"><button type="button"><span>Entrar</span></button></form>',
  );
  try {
    const inspection = loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
    assert.ok(inspection.submitSelector);
    let submitted = false;
    dom.window.document.querySelector('button')!.onclick = () => {
      submitted = true;
    };
    const result = dom.window.eval(
      credentialScript(
        'https://example.com',
        credentialFields({
          taskId: 'test',
          origin: 'https://example.com',
          kind: 'password',
          username: 'demo@example.com',
          password: 'synthetic-password',
          usernameSelector: inspection.fields.find((field) => field.kind === 'identifier')!
            .selector,
          passwordSelector: inspection.fields.find((field) => field.kind === 'password')!.selector,
          submitSelector: inspection.submitSelector,
        }),
        inspection.submitSelector,
      ),
    );
    assert.equal(JSON.stringify(result), '{"ok":true}');
    assert.equal(submitted, true);
  } finally {
    dom.window.close();
  }
});

test('one private code fills a visible six-digit group and triggers its normal input handler once', () => {
  const dom = fixture(
    `<div id="otp-form"><h1>Código de verificação</h1><div>${digits}</div></div>`,
  );
  try {
    const inspection = loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
    assert.equal(inspection.fields.length, 1);
    assert.equal(inspection.fields[0].kind, 'otp');
    assert.equal(inspection.methods[0].supported, true);
    assert.equal(inspection.submitSelector, undefined);
    const inputs = [...dom.window.document.querySelectorAll('input')];
    let submitted = 0;
    for (const input of inputs)
      input.addEventListener('input', () => {
        if (inputs.every((element) => element.value.length === 1)) submitted++;
      });
    const result = dom.window.eval(
      credentialScript(
        'https://example.com',
        credentialFields({
          taskId: 'test',
          origin: 'https://example.com',
          kind: 'otp',
          code: '483729',
          passwordSelector: inspection.fields[0].selector,
        }),
      ),
    );
    assert.equal(JSON.stringify(result), '{"ok":true}');
    assert.equal(inputs.map((input) => input.value).join(''), '483729');
    assert.equal(submitted, 1);
    assert.equal(
      inputs.every((input) => input.style.color === 'transparent'),
      true,
    );
    assert.equal(JSON.stringify(inspection).includes('483729'), false);
  } finally {
    dom.window.close();
  }
});

test('split-code entry refuses changed, partial, hidden or unrelated groups before entering any digit', () => {
  for (const change of [
    'short-code',
    'hidden',
    'different-parent',
    'changed-size',
    'extra-input',
    'non-digit',
    'collapsed-group',
  ]) {
    const dom = fixture(`<div class="otp">${digits}</div>`);
    try {
      const inspection = loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
      assert.equal(inspection.fields.length, 1);
      const inputs = [...dom.window.document.querySelectorAll('input')];
      if (change === 'hidden') inputs[2].hidden = true;
      if (change === 'different-parent') dom.window.document.body.append(inputs[2]);
      if (change === 'changed-size') inputs[2].maxLength = 2;
      if (change === 'extra-input')
        inputs[0].parentElement!.append(dom.window.document.createElement('input'));
      if (change === 'collapsed-group') inputs.slice(1).forEach((input) => input.remove());
      const result = dom.window.eval(
        credentialScript(
          'https://example.com',
          credentialFields({
            taskId: 'test',
            origin: 'https://example.com',
            kind: 'otp',
            code: change === 'short-code' ? '12345' : change === 'non-digit' ? '12x456' : '123456',
            passwordSelector: inspection.fields[0].selector,
          }),
        ),
      );
      assert.equal(JSON.stringify(result), '{"ok":false}', change);
      assert.equal(
        inputs.every((input) => input.value === ''),
        true,
        change,
      );
    } finally {
      dom.window.close();
    }
  }
});

test('retry replaces a rejected split code before the website can submit a mixed old and new value', () => {
  const dom = fixture(`<div class="otp">${digits}</div>`);
  try {
    const inspection = loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
    const inputs = [...dom.window.document.querySelectorAll('input')];
    const submitted: string[] = [];
    for (const input of inputs) {
      input.value = '9';
      input.addEventListener('input', () => {
        const value = inputs.map((element) => element.value).join('');
        if (value.length === 6) {
          submitted.push(value);
          for (const element of inputs) element.disabled = true;
        }
      });
    }
    const result = dom.window.eval(
      credentialScript(
        'https://example.com',
        credentialFields({
          taskId: 'test',
          origin: 'https://example.com',
          kind: 'otp',
          code: '483729',
          passwordSelector: inspection.fields[0].selector,
        }),
      ),
    );
    assert.equal(JSON.stringify(result), '{"ok":true}');
    assert.deepEqual(submitted, ['483729']);
  } finally {
    dom.window.close();
  }
});

test('split-code entry stops when an input handler changes the observed group', () => {
  for (const change of [
    'selector',
    'type',
    'size',
    'parent',
    'extra-input',
    'order',
    'replacement',
  ]) {
    const dom = fixture(`<div class="otp">${digits}</div>`);
    try {
      const inspection = loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
      const inputs = [...dom.window.document.querySelectorAll('input')];
      inputs[0].addEventListener('input', () => {
        if (change === 'selector') inputs[1].removeAttribute('data-otto-login-field');
        if (change === 'type') inputs[1].type = 'password';
        if (change === 'size') inputs[1].maxLength = 2;
        if (change === 'parent') dom.window.document.body.append(inputs[1]);
        if (change === 'extra-input')
          inputs[0].parentElement!.append(dom.window.document.createElement('input'));
        if (change === 'order') inputs[0].parentElement!.insertBefore(inputs[2], inputs[1]);
        if (change === 'replacement') inputs[1].replaceWith(inputs[1].cloneNode());
      });
      const result = dom.window.eval(
        credentialScript(
          'https://example.com',
          credentialFields({
            taskId: 'test',
            origin: 'https://example.com',
            kind: 'otp',
            code: '483729',
            passwordSelector: inspection.fields[0].selector,
          }),
        ),
      );
      assert.equal(JSON.stringify(result), '{"ok":false}', change);
      assert.deepEqual(
        inputs.map((input) => input.value),
        ['4', '', '', '', '', ''],
        change,
      );
    } finally {
      dom.window.close();
    }
  }
});

test('ordinary repeated text inputs and independent verification groups remain ambiguous', () => {
  for (const html of [
    `<div>${digits.replaceAll('otp-input', 'plain')}</div>`,
    `<div class="otp">${digits}</div><div class="otp">${digits}</div>`,
    `<div class="otp">${digits}<input type="email"></div>`,
  ]) {
    const dom = fixture(html);
    try {
      const inspection = loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
      assert.equal(
        inspection.fields.some((field) => field.kind === 'otp') && inspection.methods[0]?.supported,
        false,
      );
    } finally {
      dom.window.close();
    }
  }
});

test('email-code metadata requires one visible recipient and explicit delivery in the active OTP form', () => {
  for (const [text, expected] of [
    [
      'Introduza o código enviado para o seu email demo@example.com',
      { recipient: 'demo@example.com', length: 6 },
    ],
    ['We sent a code to demo@example.com', { recipient: 'demo@example.com', length: 6 }],
    ['Enter the code from your authenticator. Contact help@example.com', undefined],
    ['Code sent to d***@example.com', undefined],
    ['Code sent to one@example.com or two@example.com', undefined],
  ] as const) {
    const dom = fixture(
      `<form><p>${text}</p><div>${digits}</div></form><p hidden>Code sent to hidden@example.com</p>`,
    );
    try {
      const inspection = loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
      assert.deepEqual(inspection.emailCode, expected);
    } finally {
      dom.window.close();
    }
  }
});
