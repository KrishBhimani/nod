import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  credentialFeedback,
  credentialFeedbackScript,
} from '../src/providers/agent-browser/credentials.ts';

function fixture(html: string) {
  const dom = new JSDOM(html, { url: 'https://example.com/login', runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.getClientRects = () =>
    [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
  return {
    dom,
    read: (mark = false, kind: 'password' | 'otp' = 'password') =>
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
    page.dom.window.document.documentElement.removeAttribute('data-sidekick-entry-attempt');
    const navigated = page.read();
    assert.equal(navigated.rejected, true);
    assert.equal(navigated.sameDocument, false);
    assert.equal(navigated.fingerprint, oldAlert.fingerprint);
  } finally {
    page.dom.window.close();
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
