import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import type { AppState, Message } from '../src/shared/contracts.ts';

const css = registerHooks({
  load(url, context, next) {
    return url.endsWith('.css')
      ? { format: 'module', source: 'export default undefined', shortCircuit: true }
      : next(url, context);
  },
});
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
  'NodeFilter',
  'Text',
  'ShadowRoot',
  'DOMParser',
  'MutationObserver',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'CustomEvent',
  'File',
  'FormData',
  'Blob',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const rect = {
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
  toJSON: () => ({}),
};
dom.window.Range.prototype.getBoundingClientRect = () => rect;
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
class Events {
  static current: Events;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() {
    Events.current = this;
  }
  close() {}
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: Events });
after(() => {
  dom.window.close();
  css.deregister();
});
const { createRoot } = await import('react-dom/client');
const { useAppState } = await import('../src/web/hooks/use-app-state.ts');
const { sessionStore } = await import('../src/web/lib/session.ts');
const { Chat } = await import('../src/web/pages/chat.tsx');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
const message: Message = {
  id: 'old-message',
  role: 'assistant',
  text: 'Archived conversation',
  taskId: 'old-task',
  attachments: [],
  createdAt: '2026-09-25T12:00:00Z',
};
const base: AppState = {
  conversationRevision: 0,
  messages: [message],
  tasks: [],
  configuration: {
    provider: 'fixture',
    model: 'fixture',
    llmReady: true,
    speechReady: false,
    integrationsReady: true,
    browserAssistReady: false,
    inspectorEnabled: true,
    localOnly: true,
  },
};

async function mount() {
  const request = globalThis.fetch;
  globalThis.fetch = async (path, options) =>
    path === '/api/session'
      ? Response.json({
          auth: { mode: 'local', googleAvailable: false },
          user: { id: 'fixture-owner', name: 'Alex Example', email: null, avatarUrl: null },
          settings: { theme: 'system', onboardingCompleted: true },
          capabilities: { developer: false },
        })
      : request(path, options);
  sessionStore.invalidate();
  await sessionStore.refresh();
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  let app!: ReturnType<typeof useAppState>;
  function Fixture() {
    app = useAppState();
    return app.state
      ? createElement(Chat, {
          state: app.state,
          streams: app.streams,
          refresh: app.refresh,
          resetConversation: app.resetConversation,
        })
      : null;
  }
  await act(async () => {
    root.render(createElement(Fixture));
    await tick();
  });
  return {
    element,
    app: () => app,
    dispose: async () => {
      await act(async () => root.unmount());
      element.remove();
      sessionStore.invalidate();
      globalThis.fetch = request;
    },
  };
}

test('restart setup clears archived messages, history, replies and stale streams once without resetting connected configuration', async () => {
  const priorFetch = globalThis.fetch;
  let current = base;
  const requests: { path: string; body: unknown }[] = [];
  let finishHistory!: (response: Response) => void;
  let finishReset!: (response: Response) => void;
  let finishState!: (response: Response) => void;
  let deferState = false;
  globalThis.fetch = async (path, init) => {
    requests.push({ path: String(path), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === '/api/state') {
      if (deferState) {
        deferState = false;
        return new Promise((resolve) => {
          finishState = resolve;
        });
      }
      return new Response(JSON.stringify(current));
    }
    if (String(path).startsWith('/api/messages?'))
      return new Promise((resolve) => {
        finishHistory = resolve;
      });
    if (path === '/api/conversation/reset')
      return new Promise((resolve) => {
        finishReset = resolve;
      });
    if (path === '/api/onboarding') {
      current = {
        ...base,
        conversationRevision: 1,
        messages: [{ ...message, id: 'new-message', taskId: 'new-task', text: 'Fresh setup' }],
      };
      return new Response('{}');
    }
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount();
  try {
    assert.equal(
      requests.some((request) => request.path === '/api/conversation/reset'),
      false,
    );
    await act(async () => {
      fixture.element.querySelector<HTMLButtonElement>('[aria-label="Reply to message"]')!.click();
      [...fixture.element.querySelectorAll('button')]
        .find((button) => button.textContent === 'Load earlier messages')!
        .click();
      Events.current.emit({
        type: 'delta',
        conversationRevision: 0,
        taskId: 'old-task',
        streamId: 'old-stream',
        text: 'Old partial reply',
      });
    });
    assert.match(fixture.element.textContent ?? '', /Old partial reply/);
    deferState = true;
    let staleRefresh!: Promise<void>;
    await act(async () => {
      staleRefresh = fixture.app().refresh();
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('sidekick:restart-setup'));
      window.dispatchEvent(new CustomEvent('sidekick:restart-setup'));
    });
    assert.equal(
      requests.filter((request) => request.path === '/api/conversation/reset').length,
      1,
    );
    await act(async () => {
      finishReset(new Response(JSON.stringify({ ok: true, conversationRevision: 1 })));
      await tick();
    });
    assert.deepEqual(
      requests.filter((request) => request.path === '/api/onboarding'),
      [
        {
          path: '/api/onboarding',
          body: {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            conversationRevision: 1,
          },
        },
      ],
    );
    await act(async () => {
      finishHistory(
        new Response(JSON.stringify([{ ...message, id: 'older-message', text: 'Stale history' }])),
      );
      finishState(new Response(JSON.stringify(base)));
      await staleRefresh;
      Events.current.emit({
        type: 'delta',
        conversationRevision: 0,
        taskId: 'old-task',
        streamId: 'late-stream',
        text: 'Stale stream',
      });
      Events.current.emit({
        type: 'delta',
        conversationRevision: 1,
        taskId: 'new-task',
        streamId: 'new-stream',
        text: 'New partial reply',
      });
      await tick();
    });
    assert.match(fixture.element.textContent ?? '', /Fresh setup/);
    assert.match(fixture.element.textContent ?? '', /New partial reply/);
    assert.doesNotMatch(
      fixture.element.textContent ?? '',
      /Archived conversation|Old partial reply|Stale history|Stale stream|Replying to/,
    );
    assert.equal(fixture.app().state?.configuration.integrationsReady, true);
    assert.match(
      requests.find((request) => request.path.startsWith('/api/messages?'))!.path,
      /conversationRevision=0/,
    );
  } finally {
    await fixture.dispose();
    globalThis.fetch = priorFetch;
  }
});

test('Get started uses the same restart event and failed reset preserves the existing conversation', async () => {
  const priorFetch = globalThis.fetch;
  const requests: string[] = [];
  let failReset = true;
  globalThis.fetch = async (path) => {
    requests.push(String(path));
    if (path === '/api/state') return new Response(JSON.stringify(base));
    if (path === '/api/conversation/reset')
      return failReset
        ? new Response(JSON.stringify({ error: 'Restart failed.' }), { status: 503 })
        : new Response(JSON.stringify({ ok: true, conversationRevision: 1 }));
    return new Response('{}');
  };
  const fixture = await mount();
  try {
    await act(async () => {
      window.dispatchEvent(new CustomEvent('sidekick:restart-setup'));
      await tick();
    });
    assert.match(fixture.element.textContent ?? '', /Restart failed/);
    assert.match(fixture.element.textContent ?? '', /Archived conversation/);
    assert.equal(requests.includes('/api/onboarding'), false);
    failReset = false;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('sidekick:restart-setup'));
      await tick();
    });
    assert.equal(requests.filter((path) => path === '/api/onboarding').length, 1);
    assert.doesNotMatch(fixture.element.textContent ?? '', /Archived conversation/);
    const button = [...fixture.element.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('Get started'),
    )!;
    assert.ok(button);
    await act(async () => {
      button.click();
      await tick();
    });
    assert.equal(requests.filter((path) => path === '/api/conversation/reset').length, 3);
  } finally {
    await fixture.dispose();
    globalThis.fetch = priorFetch;
  }
});

test('reconnecting preserves the current streamed prefix until its saved message arrives', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(base);
  const fixture = await mount();
  try {
    await act(async () =>
      Events.current.emit({
        type: 'delta',
        taskId: 'running',
        streamId: 'stream',
        text: 'First ',
        conversationRevision: 0,
      }),
    );
    await act(async () => {
      Events.current.onerror?.();
      Events.current.onopen?.();
      await tick();
    });
    await act(async () =>
      Events.current.emit({
        type: 'delta',
        taskId: 'running',
        streamId: 'stream',
        text: 'second',
        conversationRevision: 0,
      }),
    );
    assert.equal(fixture.app().streams.stream, 'First second');
  } finally {
    await fixture.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('setup cannot archive a conversation when its model is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (path) => {
    paths.push(String(path));
    return Response.json({
      ...base,
      messages: [],
      configuration: { ...base.configuration, llmReady: false },
    });
  };
  const fixture = await mount();
  try {
    const button = [...fixture.element.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('Get started'),
    )!;
    assert.equal(button.disabled, true);
    await act(async () => {
      window.dispatchEvent(new CustomEvent('sidekick:restart-setup'));
      await tick();
    });
    assert.equal(
      paths.some((path) => path === '/api/conversation/reset' || path === '/api/onboarding'),
      false,
    );
  } finally {
    await fixture.dispose();
    globalThis.fetch = originalFetch;
  }
});
