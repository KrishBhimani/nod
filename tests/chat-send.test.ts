import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import type { AppState, Artifact, Message } from '../src/shared/contracts.ts';

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
const { Chat } = await import('../src/web/pages/chat.tsx');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
const message: Message = {
  id: 'old-message',
  role: 'assistant',
  text: 'Which draft should I review?',
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
    },
  };
}

type Submission = {
  clientMessageId: string;
  conversationRevision: number;
  text: string;
  attachmentIds: string[];
  replyToMessageId?: string;
};
const image: Artifact = {
  id: '9e7954ee-aa28-49c4-a9fc-7cdc1f5d5bea',
  name: 'fixture.png',
  mimeType: 'image/png',
  size: 7,
  url: '/api/artifacts/9e7954ee-aa28-49c4-a9fc-7cdc1f5d5bea',
};
const sendKey = (element: Element) =>
  element.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
async function draft(text: string) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent('sidekick:compose', { detail: { text, send: false } }));
    await tick();
  });
}

test('a user bubble appears before routing completes and reconciles SSE then response once while preserving focus and a new draft', async () => {
  const priorFetch = globalThis.fetch;
  let current = base;
  const submissions: Submission[] = [];
  let finish!: (response: Response) => void;
  globalThis.fetch = async (path, init) => {
    if (path === '/api/state') return Response.json(current);
    if (path === '/api/messages') {
      submissions.push(JSON.parse(String(init?.body)));
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount();
  try {
    await draft('Research a small weekend trip.');
    const input = fixture.element.querySelector<HTMLElement>('[role="textbox"]')!;
    await act(async () => {
      sendKey(input);
      await tick();
    });
    assert.equal(submissions.length, 1);
    const sent = submissions[0];
    assert.match(sent.clientMessageId, /^[a-f0-9-]{36}$/);
    assert.equal(sent.conversationRevision, 0);
    const bubble = fixture.element.querySelector(`[data-message-id="${sent.clientMessageId}"]`)!;
    assert.match(bubble.textContent ?? '', /Research a small weekend trip/);
    assert.equal(bubble.querySelector('[aria-label="Reply to message"]'), null);
    assert.equal(input.textContent, '');
    assert.equal(document.activeElement, input);
    await draft('A follow-up draft');
    await act(async () => {
      sendKey(input);
      sendKey(input);
    });
    assert.equal(submissions.length, 1);
    const accepted: Message = {
      id: sent.clientMessageId,
      role: 'user',
      text: sent.text,
      attachments: [],
      taskId: 'accepted-task',
      createdAt: new Date().toISOString(),
    };
    current = { ...base, messages: [message, accepted] };
    await act(async () => {
      Events.current.emit({ type: 'refresh' });
      await tick();
    });
    assert.equal(fixture.element.querySelectorAll('.message-user').length, 1);
    await act(async () => {
      finish(Response.json({ taskId: accepted.taskId, messageId: accepted.id, continued: false }));
      await tick();
    });
    assert.equal(fixture.element.querySelectorAll('.message-user').length, 1);
    assert.equal(input.textContent, 'A follow-up draft');
    assert.equal(document.activeElement, input);
    assert.equal(fixture.element.querySelector('[aria-label="Sending message"]'), null);
  } finally {
    await fixture.dispose();
    globalThis.fetch = priorFetch;
  }
});

test('failed sends restore reply and attachment drafts and retry the same message ID without a second upload', async () => {
  const priorFetch = globalThis.fetch;
  let current = base;
  const submissions: Submission[] = [];
  let uploads = 0;
  let finish!: (response: Response) => void;
  globalThis.fetch = async (path, init) => {
    if (path === '/api/state') return Response.json(current);
    if (path === '/api/uploads') {
      uploads++;
      return Response.json(image);
    }
    if (path === '/api/messages') {
      submissions.push(JSON.parse(String(init?.body)));
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount();
  try {
    await act(async () =>
      fixture.element.querySelector<HTMLButtonElement>('[aria-label="Reply to message"]')!.click(),
    );
    await draft('Review this image.');
    const input = fixture.element.querySelector<HTMLElement>('[role="textbox"]')!;
    const upload = fixture.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(upload, 'files', {
      value: [new File(['fixture'], 'fixture.png', { type: 'image/png' })],
    });
    await act(async () => {
      upload.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
    });
    await act(async () => {
      sendKey(input);
      await tick();
    });
    assert.deepEqual(submissions[0].attachmentIds, [image.id]);
    assert.equal(submissions[0].replyToMessageId, message.id);
    const bubble = fixture.element.querySelector('.message-user')!;
    assert.match(
      bubble.querySelector('blockquote')?.textContent ?? '',
      /Which draft should I review/,
    );
    assert.equal(bubble.querySelector('img')?.getAttribute('src'), image.url);
    await act(async () => {
      finish(Response.json({ error: 'The message could not be sent.' }, { status: 503 }));
      await tick();
    });
    assert.equal(fixture.element.querySelector('.message-user'), null);
    assert.equal(input.textContent, 'Review this image.');
    assert.match(fixture.element.textContent ?? '', /Replying to/);
    assert.ok(fixture.element.querySelector('.composer-wrap img'));
    assert.equal(document.activeElement, input);
    await act(async () => {
      sendKey(input);
      await tick();
    });
    assert.equal(submissions.length, 2);
    assert.deepEqual(submissions[1], submissions[0]);
    assert.equal(uploads, 1);
    const accepted: Message = {
      id: submissions[1].clientMessageId,
      role: 'user',
      text: submissions[1].text,
      attachments: [image],
      taskId: 'accepted-task',
      createdAt: new Date().toISOString(),
      replyToMessageId: message.id,
      replyTo: { id: message.id, role: message.role, text: message.text },
    };
    await act(async () => {
      finish(Response.json({ taskId: accepted.taskId, messageId: accepted.id, continued: true }));
      await tick();
    });
    assert.equal(fixture.element.querySelectorAll('.message-user').length, 1);
    assert.equal(input.textContent, '');
    current = { ...base, messages: [message, accepted] };
    await act(async () => {
      Events.current.emit({ type: 'refresh' });
      await tick();
    });
    assert.equal(fixture.element.querySelectorAll('.message-user').length, 1);
    assert.doesNotMatch(fixture.element.textContent ?? '', /Replying to|message could not be sent/);
  } finally {
    await fixture.dispose();
    globalThis.fetch = priorFetch;
  }
});

test('reset fences an optimistic send and its late failure cannot restore the old draft or reply into onboarding', async () => {
  const priorFetch = globalThis.fetch;
  let current = base;
  let finish!: (response: Response) => void;
  let submissions = 0;
  globalThis.fetch = async (path) => {
    if (path === '/api/state') return Response.json(current);
    if (path === '/api/messages') {
      submissions++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    if (path === '/api/conversation/reset') {
      current = { ...base, conversationRevision: 1, messages: [] };
      return Response.json({ ok: true, conversationRevision: 1 });
    }
    if (path === '/api/onboarding') return Response.json({});
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount();
  try {
    await draft('This belongs to the old generation.');
    await act(async () => {
      sendKey(fixture.element.querySelector('[role="textbox"]')!);
      await tick();
    });
    assert.match(
      fixture.element.querySelector('.message-user')?.textContent ?? '',
      /old generation/,
    );
    await act(async () => {
      window.dispatchEvent(new CustomEvent('sidekick:restart-setup'));
      await tick();
    });
    assert.equal(fixture.element.querySelector('.message-user'), null);
    await draft('Fresh draft');
    await act(async () => {
      finish(Response.json({ error: 'Stale request failed.' }, { status: 409 }));
      await tick();
    });
    assert.equal(submissions, 1);
    assert.equal(fixture.element.querySelector('[role="textbox"]')?.textContent, 'Fresh draft');
    assert.doesNotMatch(fixture.element.textContent ?? '', /old generation|Stale request failed/);
  } finally {
    await fixture.dispose();
    globalThis.fetch = priorFetch;
  }
});

test('persisted acceptance prevents restoring a duplicate draft when the HTTP response is lost', async () => {
  const priorFetch = globalThis.fetch;
  let current = base;
  let submitted!: Submission;
  let loseResponse!: (cause: Error) => void;
  globalThis.fetch = async (path, init) => {
    if (path === '/api/state') return Response.json(current);
    if (path === '/api/messages') {
      submitted = JSON.parse(String(init?.body));
      return new Promise((_resolve, reject) => {
        loseResponse = reject;
      });
    }
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount();
  try {
    await draft('A message accepted before disconnection.');
    const input = fixture.element.querySelector<HTMLElement>('[role="textbox"]')!;
    await act(async () => {
      sendKey(input);
      await tick();
    });
    current = {
      ...base,
      messages: [
        message,
        {
          id: submitted.clientMessageId,
          taskId: 'accepted-task',
          role: 'user',
          text: submitted.text,
          attachments: [],
          createdAt: new Date().toISOString(),
        },
      ],
    };
    await act(async () => {
      Events.current.emit({ type: 'refresh' });
      await tick();
    });
    await act(async () => {
      loseResponse(new Error('Response connection lost.'));
      await tick();
    });
    assert.equal(fixture.element.querySelectorAll('.message-user').length, 1);
    assert.equal(input.textContent, '');
    assert.doesNotMatch(fixture.element.textContent ?? '', /Response connection lost/);
    assert.equal(document.activeElement, input);
  } finally {
    await fixture.dispose();
    globalThis.fetch = priorFetch;
  }
});
