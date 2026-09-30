import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  credentialFields,
  credentialEntryScript,
} from '../src/providers/agent-browser/credentials.ts';
import {
  loginInspectionSchema,
  loginInspectionScript,
} from '../src/providers/agent-browser/login.ts';

function page() {
  const dom = new JSDOM(
    '<form><input id="user"><input id="password" type="password"><button type="submit">Continue</button></form><form><input id="other" value="unrelated-user-value"></form>',
    { url: 'https://example.com/login', runScripts: 'outside-only' },
  );
  dom.window.HTMLElement.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
  const username = dom.window.document.querySelector<HTMLInputElement>('#user')!;
  const password = dom.window.document.querySelector<HTMLInputElement>('#password')!;
  const other = dom.window.document.querySelector<HTMLInputElement>('#other')!;
  const inspection = loginInspectionSchema.parse(
    dom.window.eval(
      loginInspectionScript({
        origin: dom.window.location.origin,
        kind: 'password',
        usernameSelector: '#user',
        passwordSelector: '#password',
      }),
    ),
  );
  const fields = credentialFields({
    threadId: 'fixture',
    origin: dom.window.location.origin,
    kind: 'password',
    username: 'synthetic-user',
    password: 'synthetic-secret',
    usernameSelector: inspection.fields[0].selector,
    passwordSelector: inspection.fields[1].selector,
  });
  return { dom, username, password, other, fields };
}

test('credential entry verifies the bound nodes, origin and every target before any values', () => {
  for (const behavior of [
    'origin',
    'type',
    'hidden',
    'disabled',
    'fieldset',
    'duplicate',
    'replacement',
    'form',
    'readonly',
    'focus-replacement',
    'focus-origin',
    'focus-type',
  ]) {
    const f = page();
    try {
      if (behavior === 'origin') f.dom.reconfigure({ url: 'https://other.example/login' });
      if (behavior === 'type') f.password.type = 'text';
      if (behavior === 'hidden') f.password.parentElement!.hidden = true;
      if (behavior === 'disabled') f.password.disabled = true;
      if (behavior === 'fieldset') {
        const fieldset = f.dom.window.document.createElement('fieldset');
        fieldset.disabled = true;
        f.password.before(fieldset);
        fieldset.append(f.password);
      }
      if (behavior === 'duplicate') f.password.after(f.password.cloneNode());
      if (behavior === 'replacement') f.password.replaceWith(f.password.cloneNode());
      if (behavior === 'form') f.other.parentElement!.append(f.password);
      if (behavior === 'readonly') f.username.readOnly = true;
      if (behavior.startsWith('focus-'))
        f.username.addEventListener('focus', () => {
          if (behavior === 'focus-replacement') f.password.replaceWith(f.password.cloneNode());
          if (behavior === 'focus-origin')
            f.dom.reconfigure({ url: 'https://other.example/login' });
          if (behavior === 'focus-type') f.password.type = 'text';
        });
      const result = f.dom.window.eval(credentialEntryScript('https://example.com', f.fields)) as {
        ok: boolean;
      };
      assert.equal(result.ok, false, behavior);
      assert.equal(f.username.value, '', behavior);
      assert.equal(f.password.value, '', behavior);
      assert.equal(f.other.value, 'unrelated-user-value', behavior);
      assert.equal(
        [...f.dom.window.document.querySelectorAll('input')].some((e) =>
          e.value.includes('synthetic-'),
        ),
        false,
        behavior,
      );
    } finally {
      f.dom.window.close();
    }
  }
});

test('secure entry focuses normally, masks values and dispatches native input events without submitting', () => {
  const f = page();
  let submitted = false;
  const events: string[] = [];
  try {
    f.username.readOnly = true;
    f.username.addEventListener('focus', () => {
      f.username.readOnly = false;
    });
    f.username.addEventListener('input', () => events.push('username'));
    f.password.addEventListener('input', () => events.push('password'));
    f.password.form!.addEventListener('submit', (event) => {
      event.preventDefault();
      submitted = true;
    });
    assert.equal(f.password.value, '');
    const result = f.dom.window.eval(credentialEntryScript('https://example.com', f.fields)) as {
      ok: boolean;
    };
    assert.equal(result.ok, true);
    assert.equal(f.username.value, 'synthetic-user');
    assert.equal(f.password.value, 'synthetic-secret');
    assert.equal(f.password.style.color, 'transparent');
    assert.equal(JSON.stringify(result).includes('synthetic'), false);
    assert.deepEqual(events, ['username', 'password']);
    assert.equal(submitted, false);
  } finally {
    f.dom.window.close();
  }
});

test('entry stops after page mutation and clears only the captured original nodes', () => {
  for (const behavior of ['replace', 'origin', 'throw']) {
    const f = page();
    try {
      const replacement = f.password.cloneNode() as HTMLInputElement;
      replacement.value = 'replacement-user-value';
      f.username.addEventListener('input', () => {
        f.password.replaceWith(replacement);
        if (behavior === 'origin') f.dom.reconfigure({ url: 'https://other.example/login' });
      });
      if (behavior === 'throw')
        f.username.dispatchEvent = () => {
          f.password.replaceWith(replacement);
          throw new Error('Synthetic page failure');
        };
      const result = f.dom.window.eval(credentialEntryScript('https://example.com', f.fields)) as {
        ok: boolean;
      };
      assert.equal(result.ok, false);
      assert.equal(f.username.value, '');
      assert.equal(f.password.value, '');
      assert.equal(replacement.value, 'replacement-user-value');
      assert.equal(f.other.value, 'unrelated-user-value');
    } finally {
      f.dom.window.close();
    }
  }
});

test('aborted entry clears controlled state without changing replacement or foreign nodes', () => {
  for (const behavior of ['replace', 'adopt']) {
    const f = page();
    const foreign = new JSDOM('<body></body>', { url: 'https://other.example' });
    const replacement = f.password.cloneNode() as HTMLInputElement;
    replacement.value = 'replacement-user-value';
    const state = { input: '', change: '', replacementEvents: 0, foreignEvents: 0, otherEvents: 0 };
    try {
      f.username.addEventListener('input', () => {
        state.input = f.username.value;
      });
      f.username.addEventListener('change', () => {
        state.change = f.username.value;
        if (!f.username.value) return;
        if (behavior === 'replace') f.password.replaceWith(replacement);
        else {
          foreign.window.document.body.append(foreign.window.document.adoptNode(f.password));
          f.password.value = 'foreign-user-value';
          f.password.addEventListener('input', () => state.foreignEvents++);
          f.password.addEventListener('change', () => state.foreignEvents++);
        }
      });
      replacement.addEventListener('input', () => state.replacementEvents++);
      replacement.addEventListener('change', () => state.replacementEvents++);
      f.other.addEventListener('input', () => state.otherEvents++);
      const result = f.dom.window.eval(credentialEntryScript('https://example.com', f.fields)) as {
        ok: boolean;
      };
      assert.equal(result.ok, false);
      assert.equal(f.username.value, '');
      assert.deepEqual(state, {
        input: '',
        change: '',
        replacementEvents: 0,
        foreignEvents: 0,
        otherEvents: 0,
      });
      assert.equal(replacement.value, 'replacement-user-value');
      if (behavior === 'adopt') assert.equal(f.password.value, 'foreign-user-value');
      assert.equal(f.other.value, 'unrelated-user-value');
    } finally {
      f.dom.window.close();
      foreign.window.close();
    }
  }
});

test('secure entry rejects fields hidden by an ancestor', () => {
  for (const attribute of ['hidden', 'aria-hidden', 'aria-disabled', 'inert']) {
    const f = page();
    try {
      f.password.parentElement!.setAttribute(attribute, 'true');
      assert.equal(
        (
          f.dom.window.eval(credentialEntryScript('https://example.com', f.fields)) as {
            ok: boolean;
          }
        ).ok,
        false,
      );
      assert.equal(f.password.value, '');
    } finally {
      f.dom.window.close();
    }
  }
});
