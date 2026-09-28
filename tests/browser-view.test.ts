import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { browserViewScript } from '../src/providers/agent-browser/view.ts';

test('browser view finds generic controls, scrollable areas, and later text', () => {
  const dom = new JSDOM(
    '<main><div role="radiogroup"><div style="cursor:pointer">Jobs</div></div>' +
      '<section id="inbox" style="overflow-y:auto"><p>first second third fourth</p></section>' +
      '<input type="password" value="private-value"></main>',
    { runScripts: 'outside-only' },
  );
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent;
    },
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      width: this.tagName === 'SPAN' ? 0 : 100,
      height: 20,
      top: 0,
      left: 0,
    } as DOMRect;
  };
  Object.defineProperties(dom.window.document.querySelector('#inbox')!, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 100 },
  });
  dom.window.document.body.insertAdjacentHTML(
    'beforeend',
    '<span></span>'.repeat(5001) +
      Array.from({ length: 90 }, (_, index) => `<button>Action ${index}</button>`).join(''),
  );
  try {
    const view = dom.window.eval(browserViewScript(undefined, 6)) as {
      text: string;
      total: number;
      controls: Array<{ selector: string; label: string }>;
      controlsTotal: number;
      scrollAreas: Array<{ selector: string }>;
    };
    assert.equal(view.text, dom.window.document.body.innerText.slice(6, 16_006));
    assert.equal(view.total, dom.window.document.body.innerText.length);
    const jobs = view.controls.find((control) => control.label === 'Jobs');
    assert.ok(jobs);
    assert.equal(dom.window.document.querySelector(jobs.selector)?.textContent, 'Jobs');
    assert.equal(
      view.scrollAreas.some((area) => area.selector === '#inbox'),
      true,
    );
    assert.equal(JSON.stringify(view).includes('private-value'), false);
    assert.equal(view.controlsTotal >= 90, true);

    const later = dom.window.eval(browserViewScript(undefined, 0, 80)) as {
      controls: Array<{ label: string }>;
    };
    assert.equal(
      later.controls.some((control) => control.label === 'Action 89'),
      true,
    );

    const scoped = dom.window.eval(browserViewScript('#inbox', 6)) as { text: string };
    assert.equal(scoped.text, 'second third fourth');
  } finally {
    dom.window.close();
  }
});
