import assert from 'node:assert/strict';
import test, { after } from 'node:test';
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
  'Element',
  'Node',
  'Event',
  'MouseEvent',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');

test('a missing live frame disables manual input while keeping the agent resumable', async () => {
  const priorFetch = globalThis.fetch;
  let control = { active: true, paused: true };
  const writes: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = async (path, init) => {
    if (init?.method === 'POST') {
      writes.push({ path: String(path), body: JSON.parse(String(init.body)) });
      control = { active: false, paused: false };
    }
    return new Response(JSON.stringify(control));
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const render = (screen: string | null) =>
    root.render(
      createElement(BrowserControl, {
        threadId: 'thread-one',
        screen,
        emptyMessage: 'Browser unavailable',
        live: Boolean(screen),
        onEnlarge() {},
      }),
    );
  try {
    await act(async () => render('data:image/png;base64,fixture'));
    assert.equal(element.querySelector('textarea')?.disabled, false);
    await act(async () => render(null));
    assert.match(element.textContent ?? '', /Browser unavailable/);
    assert.equal(element.querySelector('textarea'), null);
    const buttons = Array.from(element.querySelectorAll('button'));
    const resume = buttons.find((button) => button.textContent === 'Resume agent')!;
    assert.ok(resume);
    assert.equal(resume.disabled, false);
    assert.ok(buttons.filter((button) => button !== resume).every((button) => button.disabled));
    await act(async () => resume.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.deepEqual(writes, [{ path: '/api/browser/control/resume', body: {} }]);
    assert.equal(element.querySelector('textarea'), null);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
  }
});

function mountControl() {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const render = (
    controlPath = '/api/browser/control',
    screen: string | null = 'data:image/png;base64,fixture',
  ) =>
    root.render(
      createElement(BrowserControl, {
        threadId: 'thread-one',
        controlPath,
        screen,
        emptyMessage: 'Browser unavailable',
        live: Boolean(screen),
        onEnlarge() {},
      }),
    );
  const button = (label: string) =>
    Array.from(element.querySelectorAll('button')).find((item) => item.textContent === label);
  const click = (label: string) => {
    const target = button(label);
    assert.ok(target, `Missing ${label} button`);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };
  return {
    element,
    render,
    button,
    click,
    async close() {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

const idleState = {
  active: false,
  paused: false,
  mode: null as 'manual' | 'sign_in' | null,
  signInAvailable: true,
};
const signInState = {
  ...idleState,
  active: true,
  paused: true,
  mode: 'sign_in' as const,
};

test('workspace sign-in uses a private frame and input, then explicitly resumes the thread', async () => {
  const priorFetch = globalThis.fetch;
  const priorCreate = URL.createObjectURL;
  const priorRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:private-sign-in';
  const revoked: string[] = [];
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  let control = idleState;
  const writes: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = async (path, init) => {
    if (String(path).includes('/sign-in-screen')) {
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.credentials, 'same-origin');
      assert.equal(String(path), '/api/browser/control/sign-in-screen');
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
    }
    if (init?.method === 'POST') {
      writes.push({ path: String(path), body: JSON.parse(String(init.body)) });
      if (String(path).endsWith('/start')) {
        control = signInState;
        return new Response(JSON.stringify({ mode: 'sign_in', resumable: true }));
      }
      if (String(path).endsWith('/resume')) control = idleState;
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response(JSON.stringify(control));
  };
  const f = mountControl();
  try {
    await act(async () => f.render());
    assert.ok(f.element.querySelector('.screen-preview'));
    await act(async () => f.click('Take control'));
    assert.match(f.element.textContent ?? '', /Click the browser to type/);
    const image = f.element.querySelector<HTMLImageElement>('.screen-preview img')!;
    assert.equal(image.src, 'blob:private-sign-in');
    assert.equal(image.alt, 'Private workspace browser');
    assert.equal(f.element.querySelector('textarea')?.disabled, false);
    assert.equal(f.button('Take control'), undefined);
    assert.equal(f.button('Sign in in browser'), undefined);
    assert.equal(f.button('Resume agent')?.disabled, false);
    const surface = f.element.querySelector('textarea')!;
    surface.focus();
    await act(async () =>
      surface.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      ),
    );
    await act(async () => f.click('Resume agent'));
    assert.deepEqual(writes, [
      { path: '/api/browser/control/start', body: {} },
      {
        path: '/api/browser/control/input',
        body: { input: { action: 'press', key: 'Tab' } },
      },
      { path: '/api/browser/control/resume', body: {} },
    ]);
    assert.equal(
      f.element.querySelector<HTMLImageElement>('.screen-preview img')?.src,
      'data:image/png;base64,fixture',
    );
    assert.equal(f.button('Resume agent'), undefined);
    assert.ok(revoked.includes('blob:private-sign-in'));
  } finally {
    await f.close();
    globalThis.fetch = priorFetch;
    URL.createObjectURL = priorCreate;
    URL.revokeObjectURL = priorRevoke;
  }
});

test('Take control remains available without a screenshot and rejected actions show an error', async () => {
  const priorFetch = globalThis.fetch;
  let control = idleState;
  let status = 409;
  globalThis.fetch = async (_path, init) => {
    if (init?.method === 'POST')
      return new Response(
        JSON.stringify(status === 200 ? { ok: false } : { error: 'Could not open the browser.' }),
        { status },
      );
    return new Response(JSON.stringify(control));
  };
  const f = mountControl();
  try {
    await act(async () => f.render('/api/browser/control', null));
    assert.equal(f.button('Take control')?.disabled, false);
    assert.equal(f.button('Sign in in browser'), undefined);
    await act(async () => f.click('Take control'));
    assert.match(f.element.textContent ?? '', /Could not open the browser/);
    assert.equal(f.button('Resume agent'), undefined);
    control = signInState;
    await act(async () => f.render('/api/inspector/control', null));
    await act(async () => f.click('Resume agent'));
    assert.equal(f.button('Resume agent')?.disabled, false);
    assert.equal(f.element.querySelector('textarea'), null);
    status = 200;
    await act(async () => f.click('Resume agent'));
    assert.match(f.element.textContent ?? '', /The browser could not continue/);
    assert.equal(f.button('Resume agent')?.disabled, false);
  } finally {
    await f.close();
    globalThis.fetch = priorFetch;
  }
});

test('a delayed poll cannot replace an accepted native sign-in state', async (context) => {
  const priorFetch = globalThis.fetch;
  context.mock.timers.enable({ apis: ['setInterval'] });
  let control = idleState;
  let reads = 0;
  let finishPoll!: (value: Response) => void;
  globalThis.fetch = async (path, init) => {
    if (String(path).includes('/sign-in-screen')) return new Response(null, { status: 409 });
    if (init?.method === 'POST') {
      assert.ok(String(path).endsWith('/start'));
      control = signInState;
      return new Response(JSON.stringify({ mode: 'sign_in', resumable: true }));
    }
    reads++;
    if (reads === 2)
      return new Promise<Response>((resolve) => {
        finishPoll = resolve;
      });
    return new Response(JSON.stringify(control));
  };
  const f = mountControl();
  try {
    await act(async () => f.render());
    await act(async () => context.mock.timers.tick(2500));
    await act(async () => f.click('Take control'));
    await act(async () => finishPoll(new Response(JSON.stringify(idleState))));
    assert.ok(f.button('Resume agent'));
    assert.equal(f.element.querySelector('.screen-preview'), null);
  } finally {
    await f.close();
    context.mock.timers.reset();
    globalThis.fetch = priorFetch;
  }
});

test('a late sign-in response cannot update another control surface', async () => {
  const priorFetch = globalThis.fetch;
  let finishSignIn!: (value: Response) => void;
  const reads: string[] = [];
  globalThis.fetch = async (path, init) => {
    if (init?.method === 'POST')
      return new Promise<Response>((resolve) => {
        finishSignIn = resolve;
      });
    reads.push(String(path));
    return new Response(JSON.stringify(idleState));
  };
  const f = mountControl();
  try {
    await act(async () => f.render());
    await act(async () => f.click('Take control'));
    await act(async () => f.render('/api/inspector/control'));
    await act(async () =>
      finishSignIn(new Response(JSON.stringify({ mode: 'sign_in', resumable: true }))),
    );
    assert.equal(f.button('Resume agent'), undefined);
    assert.equal(f.button('Take control')?.disabled, false);
    assert.deepEqual(reads, ['/api/browser/control', '/api/inspector/control']);
  } finally {
    await f.close();
    globalThis.fetch = priorFetch;
  }
});

test('private sign-in frames clear on blur and reject delayed bytes from a hidden or replaced session', async (context) => {
  const priorFetch = globalThis.fetch;
  const priorCreate = URL.createObjectURL;
  const priorRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  let frameId = 0;
  let focused = false;
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
  URL.createObjectURL = () => `blob:private-${++frameId}`;
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  const pending: Array<{ signal: AbortSignal; resolve(response: Response): void }> = [];
  globalThis.fetch = async (path, init) => {
    if (String(path).includes('/sign-in-screen'))
      return new Promise<Response>((resolve) => pending.push({ signal: init!.signal!, resolve }));
    return new Response(
      JSON.stringify(String(path).startsWith('/api/browser/') ? signInState : idleState),
    );
  };
  const frame = () =>
    new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
  const f = mountControl();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await act(async () => f.render());
    assert.equal(pending.length, 0);
    focused = true;
    await act(async () => window.dispatchEvent(new Event('focus')));
    assert.equal(pending.length, 1);
    await act(async () => pending[0].resolve(frame()));
    assert.equal(f.element.querySelector<HTMLImageElement>('img')?.src, 'blob:private-1');
    await act(async () => context.mock.timers.tick(1000));
    assert.equal(pending.length, 2);
    focused = false;
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(pending[1].signal.aborted, true);
    assert.equal(f.element.querySelector('img'), null);
    assert.equal(f.element.querySelector('textarea'), null);
    assert.equal(f.button('Resume agent')?.disabled, false);
    assert.ok(revoked.includes('blob:private-1'));
    await act(async () => pending[1].resolve(frame()));
    assert.equal(frameId, 1);
    focused = true;
    await act(async () => window.dispatchEvent(new Event('focus')));
    assert.equal(pending.length, 3);
    await act(async () => pending[2].resolve(frame()));
    assert.equal(f.element.querySelector<HTMLImageElement>('img')?.src, 'blob:private-2');
    await act(async () => context.mock.timers.tick(1000));
    assert.equal(pending.length, 4);
    await act(async () => f.render('/api/inspector/control', null));
    assert.equal(pending[3].signal.aborted, true);
    assert.equal(pending.length, 4);
    assert.equal(f.element.querySelector('img'), null);
    await act(async () => pending[3].resolve(frame()));
    assert.equal(frameId, 2);
    assert.ok(revoked.includes('blob:private-2'));
    assert.equal(f.element.querySelector('img'), null);
  } finally {
    await f.close();
    context.mock.timers.reset();
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    globalThis.fetch = priorFetch;
    URL.createObjectURL = priorCreate;
    URL.revokeObjectURL = priorRevoke;
  }
});
