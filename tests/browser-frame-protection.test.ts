import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { protectFocusedField, maskPageScript } from '../src/providers/agent-browser/manual.ts';

function fixture() {
  const page = new JSDOM('<iframe></iframe>', {
    url: 'https://example.test/',
    runScripts: 'outside-only',
  });
  const frame = page.window.document.querySelector('iframe')!;
  const document = frame.contentDocument!;
  document.body.innerHTML = '<input><p></p>';
  page.window.HTMLElement.prototype.getClientRects = () =>
    [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
  const input = document.querySelector('input')!;
  input.getClientRects = () => [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
  input.focus();
  return { page, frame, input, document };
}

test('same-origin iframe typing protects the real focused field and reflected text', () => {
  const f = fixture();
  try {
    assert.equal(f.page.window.eval(protectFocusedField), true);
    assert.equal(f.input.getAttribute('data-otto-manual-field'), 'true');
    const value = 'synthetic private typed text';
    f.input.value = value;
    f.document.querySelector('p')!.textContent = value;
    const result = f.page.window.eval(
      maskPageScript(['[data-otto-manual-field="true"]'], [value]),
    ) as { masked: boolean; values: string[] };
    assert.equal(result.masked, true);
    assert.ok(result.values.includes(value));
    assert.equal(f.input.style.getPropertyValue('color'), 'transparent');
    assert.equal(f.document.querySelector('p')!.style.getPropertyValue('color'), 'transparent');
  } finally {
    f.page.window.close();
  }
});

test('hidden and inaccessible iframe fields stay blocked with a native sign-in fallback', () => {
  const f = fixture();
  try {
    f.frame.setAttribute('inert', '');
    assert.equal(f.page.window.eval(protectFocusedField), false);
    f.frame.removeAttribute('inert');
    Object.defineProperty(f.frame, 'contentDocument', { get: () => null });
    assert.equal(f.page.window.eval(protectFocusedField), 'unsupported_frame');
    f.page.window.eval(maskPageScript([], ['synthetic value']));
    assert.equal(f.frame.style.getPropertyValue('visibility'), 'hidden');
  } finally {
    f.page.window.close();
  }
});

test('ordinary unreadable frame content remains available until credentials need protection', () => {
  const f = fixture();
  try {
    Object.defineProperty(f.frame, 'contentDocument', { get: () => null });
    f.page.window.eval(maskPageScript([], []));
    assert.equal(f.frame.style.getPropertyValue('visibility'), '');
    assert.equal(f.page.window.eval(protectFocusedField), 'unsupported_frame');
    f.page.window.eval(maskPageScript([], ['synthetic entered value']));
    assert.equal(f.frame.style.getPropertyValue('visibility'), 'hidden');
  } finally {
    f.page.window.close();
  }
});

test('masking hides unreadable frames after discovering a protected value and bounds frame traversal', () => {
  const page = new JSDOM('<input type="password"><iframe></iframe>'.repeat(17), {
    url: 'https://example.test/',
    runScripts: 'outside-only',
  });
  try {
    const frames = [...page.window.document.querySelectorAll('iframe')];
    Object.defineProperty(frames[0], 'contentDocument', { get: () => null });
    page.window.document.querySelector('input')!.value = 'synthetic discovered value';
    const result = page.window.eval(maskPageScript([], [])) as {
      masked: boolean;
      values: string[];
    };
    assert.equal(result.masked, true);
    assert.deepEqual(Array.from(result.values), ['synthetic discovered value']);
    assert.equal(frames[0].style.getPropertyValue('visibility'), 'hidden');
    assert.equal(frames[15].style.getPropertyValue('visibility'), '');
    assert.equal(frames[16].style.getPropertyValue('visibility'), 'hidden');
  } finally {
    page.window.close();
  }
});
