import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { BrowserControl } from '../src/web/components/browser-control.tsx';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'InputEvent',
  'CompositionEvent',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');

type InputWrite = { path: string; revision: number; input?: Record<string, unknown> };
async function mountInput(send?: (write: InputWrite) => Promise<Response>) {
  const previousFetch = globalThis.fetch;
  const writes: InputWrite[] = [];
  let active = true;
  let revision = 7;
  globalThis.fetch = async (path, options) => {
    if (options?.method === 'POST') {
      const write = { path: String(path), ...JSON.parse(String(options.body)) } as InputWrite;
      writes.push(write);
      if (write.path.endsWith('/resume')) active = false;
      return send ? send(write) : new Response(JSON.stringify({ ok: true }));
    }
    return new Response(
      JSON.stringify({
        active,
        paused: active,
        mode: 'manual',
        revision: active ? revision : null,
      }),
    );
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const render = async (taskId = 'task-one', live = true) =>
    act(async () =>
      root.render(
        createElement(BrowserControl, {
          taskId,
          screen: 'data:image/png;base64,fixture',
          emptyMessage: '',
          live,
          onEnlarge() {},
        }),
      ),
    );
  await render();
  const surface = element.querySelector<HTMLTextAreaElement>('.screen-preview textarea')!;
  const button = () =>
    [...element.querySelectorAll('button')].find(
      (button) => button.textContent === 'Resume agent',
    )!;
  return {
    element,
    surface,
    writes,
    render,
    setRevision: (value: number) => {
      revision = value;
    },
    button,
    async close() {
      await act(async () => root.unmount());
      element.remove();
      globalThis.fetch = previousFetch;
    },
  };
}
const key = (surface: HTMLElement, key: string, options: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  surface.dispatchEvent(event);
  return event;
};
const text = (surface: HTMLTextAreaElement, data: string) =>
  surface.dispatchEvent(
    new InputEvent('beforeinput', {
      inputType: 'insertText',
      data,
      bubbles: true,
      cancelable: true,
    }),
  );

test('the focused browser surface forwards keyboard presses directly', async () => {
  const f = await mountInput();
  try {
    f.surface.focus();
    let enter!: KeyboardEvent;
    await act(async () => {
      enter = key(f.surface, 'Enter');
    });
    assert.equal(enter.defaultPrevented, true);
    assert.deepEqual(f.writes, [
      {
        path: '/api/browser/control/task-one/input',
        revision: 7,
        input: { action: 'press', key: 'Enter' },
      },
    ]);
    assert.equal(f.element.querySelector('form'), null);
    assert.doesNotMatch(f.element.textContent!, /Enter text|Scroll down|Previous/);
  } finally {
    await f.close();
  }
});

test('rapid private text stays ordered behind pending input and drains before releasing control', async () => {
  let finish!: (response: Response) => void;
  const f = await mountInput(async () =>
    f.writes.length === 1
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : new Response(JSON.stringify({ ok: true })),
  );
  try {
    f.surface.focus();
    await act(async () => {
      text(f.surface, 'first');
      text(f.surface, ' second');
      key(f.surface, 'Tab');
    });
    assert.equal(f.writes.length, 1);
    await act(async () => {
      f.button().focus();
      f.button().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal(f.writes.length, 1);
    await act(async () => finish(new Response(JSON.stringify({ ok: true }))));
    assert.deepEqual(
      f.writes.map((write) => write.input ?? 'resume'),
      [
        { action: 'type', text: 'first' },
        { action: 'type', text: ' second' },
        { action: 'press', key: 'Tab' },
        'resume',
      ],
    );
    assert.equal(f.element.querySelector('textarea'), null);
  } finally {
    await f.close();
  }
});

test('composition and paste send committed Unicode once and clear local text', async () => {
  const f = await mountInput();
  try {
    f.surface.focus();
    await act(async () => {
      f.surface.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      f.surface.value = 'に';
      f.surface.dispatchEvent(
        new InputEvent('input', {
          data: 'に',
          inputType: 'insertCompositionText',
          isComposing: true,
          bubbles: true,
        }),
      );
      key(f.surface, 'Enter', { isComposing: true });
    });
    assert.equal(f.writes.length, 0);
    await act(async () => {
      f.surface.dispatchEvent(
        new CompositionEvent('compositionend', { data: '日本語', bubbles: true }),
      );
      f.surface.value = '日本語';
      f.surface.dispatchEvent(
        new InputEvent('input', { data: '日本語', inputType: 'insertText', bubbles: true }),
      );
    });
    assert.deepEqual(
      f.writes.map((write) => write.input),
      [{ action: 'type', text: '日本語' }],
    );
    assert.equal(f.surface.value, '');
    await act(async () => {
      f.surface.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      f.surface.value = 'cancelled';
      f.surface.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
    });
    assert.equal(f.writes.length, 1);
    assert.equal(f.surface.value, '');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        getData: (kind: string) => (kind === 'text/plain' ? 'Synthetic ç\n二' : '<b>ignored</b>'),
      },
    });
    await act(async () => f.surface.dispatchEvent(paste));
    assert.equal(paste.defaultPrevented, true);
    assert.deepEqual(f.writes.at(-1)?.input, { action: 'type', text: 'Synthetic ç\n二' });
    assert.equal(f.surface.value, '');
    f.surface.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    f.surface.value = 'uncommitted';
    window.dispatchEvent(new Event('blur'));
    assert.equal(f.surface.value, '');
    assert.doesNotMatch(f.element.textContent!, /uncommitted|Synthetic ç/);
  } finally {
    await f.close();
  }
});

test('shortcuts reach only the focused surface and Shift Escape returns keyboard access to controls', async () => {
  const f = await mountInput();
  const outside = document.createElement('input');
  document.body.append(outside);
  try {
    f.surface.focus();
    await act(async () => {
      key(f.surface, 'a', { metaKey: true });
      key(f.surface, 'ArrowLeft', { ctrlKey: true, shiftKey: true });
      key(f.surface, 'Tab', { shiftKey: true });
    });
    assert.deepEqual(
      f.writes.map((write) => write.input),
      [
        { action: 'press', key: 'a', modifiers: ['Control'] },
        { action: 'press', key: 'ArrowLeft', modifiers: ['Control', 'Shift'] },
        { action: 'press', key: 'Tab', modifiers: ['Shift'] },
      ],
    );
    const count = f.writes.length;
    await act(async () => {
      key(f.surface, 'Escape', { shiftKey: true });
    });
    assert.equal(document.activeElement, f.button());
    outside.focus();
    const local = key(outside, 'Enter');
    key(f.surface, 'Enter');
    text(f.surface, 'unfocused');
    assert.equal(local.defaultPrevented, false);
    assert.equal(f.writes.length, count);
  } finally {
    outside.remove();
    await f.close();
  }
});

test('pointer coordinates and bounded two-axis scrolling follow the focused image', async () => {
  const f = await mountInput();
  try {
    const image = f.element.querySelector('img')!;
    Object.defineProperty(image, 'getBoundingClientRect', {
      value: () => ({ left: 10, top: 20, width: 640, height: 400 }),
    });
    f.surface.focus();
    const wheel = new dom.window.WheelEvent('wheel', {
      deltaX: 60,
      deltaY: -140,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      f.surface.dispatchEvent(
        new MouseEvent('click', { clientX: 330, clientY: 220, detail: 1, bubbles: true }),
      );
      f.surface.dispatchEvent(wheel);
    });
    assert.deepEqual(
      f.writes.map((write) => write.input),
      [
        { action: 'click', x: 0.5, y: 0.5 },
        { action: 'wheel', deltaX: 60, deltaY: -140 },
      ],
    );
    assert.equal(wheel.defaultPrevented, true);
    f.surface.blur();
    const local = new dom.window.WheelEvent('wheel', {
      deltaY: 200,
      bubbles: true,
      cancelable: true,
    });
    f.surface.dispatchEvent(local);
    assert.equal(local.defaultPrevented, false);
    assert.equal(f.writes.length, 2);
  } finally {
    await f.close();
  }
});

for (const sameTask of [false, true])
  test(`hidden sessions discard unsent text without fencing ${sameTask ? 'a newer revision' : 'another task'}`, async () => {
    let finish!: (response: Response) => void;
    const f = await mountInput(async () =>
      f.writes.length === 1
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : new Response(JSON.stringify({ ok: true })),
    );
    try {
      f.surface.focus();
      await act(async () => {
        text(f.surface, 'accepted');
        text(f.surface, 'must-discard');
      });
      assert.equal(f.writes.length, 1);
      window.dispatchEvent(new Event('blur'));
      await f.render('task-two');
      if (sameTask) {
        f.setRevision(8);
        await f.render();
      }
      await act(async () =>
        finish(new Response(JSON.stringify({ error: 'must-not-appear' }), { status: 500 })),
      );
      assert.equal(f.writes.length, 1);
      assert.doesNotMatch(f.element.textContent!, /must-discard|must-not-appear/);
      const next = f.element.querySelector('textarea')!;
      next.focus();
      await act(async () => text(next, 'new-lease-input'));
      assert.equal(f.writes.length, 2);
      assert.equal(
        f.writes[1].path,
        `/api/browser/control/${sameTask ? 'task-one' : 'task-two'}/input`,
      );
      assert.equal(f.writes[1].revision, sameTask ? 8 : 7);
      assert.doesNotMatch(f.element.textContent!, /Browser input stopped/);
    } finally {
      await f.close();
    }
  });

for (const refreshScreen of [false, true])
  test(`late input failure fences the same lease after ${refreshScreen ? 'screen suspension' : 'window blur'}`, async () => {
    let finish!: (response: Response) => void;
    const f = await mountInput(async (write) =>
      write.path.endsWith('/input')
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : new Response(JSON.stringify({ ok: true })),
    );
    try {
      f.surface.focus();
      await act(async () => {
        text(f.surface, 'in-flight');
        text(f.surface, 'discard-on-blur');
        window.dispatchEvent(new Event('blur'));
      });
      if (refreshScreen) {
        await f.render('task-one', false);
        await f.render();
      }
      await act(async () =>
        finish(new Response(JSON.stringify({ error: 'private-input-error' }), { status: 500 })),
      );
      f.surface.focus();
      await act(async () => text(f.surface, 'must-not-follow-uncertain-input'));
      assert.equal(f.writes.length, 1);
      assert.match(f.element.textContent!, /Browser input stopped/);
      assert.doesNotMatch(f.element.textContent!, /private-input-error|discard-on-blur/);
      await act(async () => {
        f.button().focus();
        f.button().click();
      });
      assert.equal(f.writes.at(-1)?.path, '/api/browser/control/task-one/resume');
    } finally {
      await f.close();
    }
  });

test('failed input clears the queue, stops later typing and still permits ending control', async () => {
  let finish!: (response: Response) => void;
  const f = await mountInput(async (write) =>
    write.path.endsWith('/input')
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : new Response(JSON.stringify({ ok: true })),
  );
  try {
    f.surface.focus();
    await act(async () => {
      text(f.surface, 'first');
      text(f.surface, 'unsent');
    });
    await act(async () =>
      finish(new Response(JSON.stringify({ error: 'private-provider-error' }), { status: 500 })),
    );
    await act(async () => text(f.surface, 'not-sent-after-failure'));
    assert.equal(f.writes.length, 1);
    assert.match(f.element.textContent!, /Browser input stopped/);
    assert.doesNotMatch(f.element.textContent!, /private-provider-error|unsent/);
    await act(async () => {
      f.button().focus();
      f.button().click();
    });
    assert.equal(f.writes.at(-1)?.path, '/api/browser/control/task-one/resume');
  } finally {
    await f.close();
  }
});
