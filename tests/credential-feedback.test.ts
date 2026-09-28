import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  credentialFeedback,
  credentialFeedbackScript,
  credentialScript,
} from '../src/providers/agent-browser/credentials.ts';
import { credentialSubmitScript } from '../src/providers/agent-browser/login.ts';

function fixture(html: string) {
  const dom = new JSDOM(html, { url: 'https://example.com/login', runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.getClientRects = () =>
    [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
  return {
    dom,
    read: (mark = false, kind: 'identifier' | 'password' | 'otp' = 'password') =>
      credentialFeedback(
        dom.window.eval(credentialFeedbackScript('https://example.com', kind, 'fixture', mark)),
      )!,
  };
}

test('credential feedback distinguishes fresh rejection from old alerts without returning page text or entered values', () => {
  const page = fixture(
    '<input type="password" value="private-input-fixture"><p role="alert"></p><div hidden><p role="alert">Incorrect hidden text</p></div>',
  );
  try {
    const before = page.read(true);
    assert.equal(before.rejected, false);
    assert.equal(before.sameDocument, true);
    page.dom.window.document.querySelector('p')!.textContent =
      'Email or password was incorrect: private-error-fixture';
    const rejected = page.read();
    assert.equal(rejected.rejected, true);
    assert.equal(rejected.advanced, false);
    assert.notEqual(rejected.fingerprint, before.fingerprint);
    for (const secret of ['private-input-fixture', 'private-error-fixture', 'incorrect'])
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

test('rejected authenticator and context-only identifier fields do not look advanced', () => {
  for (const [kind, html] of [
    ['otp', '<label for="code">Authenticator code</label><input id="code" aria-invalid="true">'],
    [
      'otp',
      '<span id="hint">Authenticator code</span><input aria-labelledby="hint" aria-invalid="true">',
    ],
    [
      'identifier',
      '<h1>Sign in</h1><input data-otto-login-field="identifier-0" aria-invalid="true">',
    ],
  ] as const) {
    const page = fixture(html);
    try {
      const result = page.read(false, kind);
      assert.equal(result.advanced, false);
      assert.equal(result.rejected, true);
    } finally {
      page.dom.window.close();
    }
  }
});

test('secure entry and delayed submit reject fields or controls hidden by ancestors', async () => {
  for (const attribute of ['hidden', 'aria-hidden="true"', 'inert', 'aria-disabled="true"']) {
    const page = fixture(
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

test('credential feedback follows password and OTP stages and does not treat unrelated page errors as sign-in rejection', () => {
  const page = fixture(
    '<input autocomplete="one-time-code" aria-invalid="true"><p role="alert">That code was incorrect. Try again.</p>',
  );
  try {
    assert.equal(page.read().advanced, true);
    assert.equal(page.read().rejected, false);
    assert.equal(page.read(false, 'otp').rejected, true);
    page.dom.window.document.body.innerHTML = '<p role="alert">Invalid report filter</p>';
    assert.equal(page.read(false, 'otp').advanced, true);
    assert.equal(page.read(false, 'otp').rejected, false);
    assert.equal(
      credentialFeedback({ rejected: true, fingerprint: 'raw page content' }),
      undefined,
    );
  } finally {
    page.dom.window.close();
  }
});
