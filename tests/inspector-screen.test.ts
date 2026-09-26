import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { Inspector } from '../src/web/pages/inspector.tsx';

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
  'localStorage',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const taskId = 'f69e3934-3672-45cc-9834-6f6803530558';
const capturedAt = new Date().toISOString();
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function mounted(screen: (capture: number) => Promise<Response>) {
  const previousFetch = globalThis.fetch;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  const requests: Array<{ url: URL; method: string }> = [];
  let captures = 0;
  let images = 0;
  let activity = capturedAt;
  URL.createObjectURL = () => `blob:fixture-${++images}`;
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost:4310');
    requests.push({ url, method: init?.method || 'GET' });
    if (url.pathname === '/api/inspector')
      return json({
        tasks: [
          {
            id: taskId,
            title: 'Browser fixture',
            status: 'running',
            createdAt: capturedAt,
            updatedAt: capturedAt,
          },
        ],
        events: [],
        artifacts: [],
        runtime: { browser: 'Ready', workspace: 'Ready', database: 'Ready' },
        currentBrowser: {
          taskId,
          lastActivityAt: activity,
          title: 'Browser fixture',
          status: 'running',
        },
      });
    if (url.pathname === '/api/notifications') return json([]);
    if (url.pathname === '/api/inspector/providers')
      return json({
        scope: 'owner',
        retentionDays: 7,
        captureEnabled: true,
        droppedEvents: 0,
        providers: [],
        coverage: [],
      });
    if (url.pathname.startsWith('/api/browser/control/'))
      return json({ active: false, paused: false, revision: 0 });
    if (url.pathname === `/api/tasks/${taskId}/cancel`) return json({ ok: true });
    if (url.pathname === '/api/inspector/screen') {
      assert.equal(url.searchParams.get('taskId'), taskId);
      return screen(++captures);
    }
    if (url.pathname === '/api/inspector/tools')
      return json({ tools: [], captureEnabled: true, retentionDays: 7, payloadLimitBytes: 16384 });
    if (url.pathname === '/api/inspector/observations')
      return json({
        scope: 'owner',
        calls: [],
        usage: [],
        toolUsage: [],
        summary: {
          calls: 0,
          modelRequests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          knownCostUsd: null,
          unpricedRequests: 0,
        },
        hasOlder: false,
      });
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(createElement(Inspector, { onClose() {} })));
  return {
    element,
    revoked,
    requests,
    captures: () => captures,
    updateActivity(value: string) {
      activity = value;
    },
    async close() {
      await act(async () => root.unmount());
      element.remove();
      globalThis.fetch = previousFetch;
      URL.createObjectURL = previousCreate;
      URL.revokeObjectURL = previousRevoke;
    },
  };
}

const frame = async () =>
  new Response(Buffer.from('fixture-png'), {
    headers: {
      'content-type': 'image/png',
      'X-Screen-State': 'live',
      'X-Screen-Captured-At': capturedAt,
    },
  });
const takeControl = (element: HTMLElement) =>
  [...element.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Take control',
  )!;

test('failed browser capture revokes the previous live image while Take control remains available', async () => {
  const fixture = await mounted(async (count) => {
    if (count === 1) return frame();
    throw new Error('Synthetic connection failure.');
  });
  try {
    const image = fixture.element.querySelector<HTMLImageElement>('.screen-preview img')!;
    assert.equal(image.src, 'blob:fixture-1');
    assert.doesNotMatch(
      fixture.element.textContent ?? '',
      /Follows the current browser|Live browser/,
    );
    assert.match(fixture.element.querySelector('.screen-caption')!.textContent!, /Updated/);
    assert.equal(takeControl(fixture.element).disabled, false);
    await act(async () => {
      await delay(1100);
    });
    assert.ok(fixture.captures() >= 2);
    assert.equal(fixture.element.querySelector('.screen-preview img'), null);
    assert.ok(fixture.revoked.includes('blob:fixture-1'));
    assert.equal(takeControl(fixture.element).disabled, false);
    assert.match(fixture.element.textContent!, /Reconnecting to the browser/);
    assert.doesNotMatch(
      fixture.element.querySelector('.browser-live-label')?.textContent ?? '',
      /Live/,
    );
  } finally {
    await fixture.close();
  }
});

test('switching inspector tabs retains a valid browser frame and does not restart or replace its session', async () => {
  const fixture = await mounted(frame);
  try {
    const image = fixture.element.querySelector<HTMLImageElement>('.screen-preview img')!.src;
    const switchTab = async (label: string) => {
      const button = [...fixture.element.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (item) => item.textContent === label,
      )!;
      await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    };
    await switchTab('Tools');
    assert.equal(fixture.element.querySelector('.screen-preview img'), null);
    assert.equal(fixture.revoked.length, 0);
    await switchTab('Costs');
    assert.match(fixture.element.textContent!, /Recorded cost/);
    assert.equal(fixture.revoked.length, 0);
    await switchTab('Screen');
    assert.equal(
      fixture.element.querySelector<HTMLImageElement>('.screen-preview img')!.src,
      image,
    );
    assert.equal(takeControl(fixture.element).disabled, false);
    assert.equal(fixture.captures(), 1);
    assert.equal(fixture.revoked.length, 0);
    assert.equal(
      fixture.requests.some((request) => request.method !== 'GET'),
      false,
    );
    assert.ok(
      fixture.requests
        .filter((request) => request.url.pathname.startsWith('/api/browser/control/'))
        .every(
          (request) =>
            request.url.pathname.endsWith(taskId) || request.url.pathname.endsWith('/workspace'),
        ),
    );
  } finally {
    await fixture.close();
  }
});

test('stopping browser work targets the current screen session and leaves inspection available', async () => {
  const fixture = await mounted(frame);
  try {
    const stop = fixture.element.querySelector<HTMLButtonElement>(
      '[aria-label="Stop browser task"]',
    )!;
    assert.ok(stop);
    await act(async () => stop.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.deepEqual(
      fixture.requests
        .filter((request) => request.method === 'POST')
        .map((request) => request.url.pathname),
      [`/api/tasks/${taskId}/cancel`],
    );
    assert.equal(fixture.element.querySelector('[aria-label="Stop browser task"]'), null);
    assert.ok(fixture.element.querySelector('.screen-preview img'));
  } finally {
    await fixture.close();
  }
});

test('known navigation failure pauses screen capture, supports an explicit retry and resumes after browser activity', async () => {
  const fixture = await mounted(async (count) =>
    count < 3
      ? new Response(
          JSON.stringify({
            code: 'browser_navigation_failed',
            error: 'Private response https://private.example?token=secret',
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        )
      : frame(),
  );
  try {
    assert.match(fixture.element.textContent!, /The website did not load successfully/);
    assert.doesNotMatch(fixture.element.textContent!, /private\.example|token=secret/);
    assert.equal(takeControl(fixture.element).disabled, false);
    await act(async () => {
      await delay(1100);
    });
    assert.equal(fixture.captures(), 1);
    const retry = [...fixture.element.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Retry view',
    )!;
    await act(async () => retry.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(fixture.captures(), 2);
    assert.match(fixture.element.textContent!, /The website did not load successfully/);
    fixture.updateActivity(new Date(Date.now() + 1000).toISOString());
    await act(async () => {
      await delay(3600);
    });
    await act(async () => {
      await delay(1100);
    });
    assert.ok(fixture.captures() >= 3);
    assert.ok(fixture.element.querySelector('.screen-preview img'));
    assert.equal(takeControl(fixture.element).disabled, false);
    assert.doesNotMatch(fixture.element.textContent!, /The website did not load successfully/);
  } finally {
    await fixture.close();
  }
});

test('secure input pauses capture until the browser activity changes', async () => {
  const fixture = await mounted(async () => new Response('', { status: 423 }));
  try {
    assert.match(fixture.element.textContent!, /Screen hidden while sign-in details are entered/);
    await act(async () => {
      await delay(1100);
    });
    assert.equal(fixture.captures(), 1);
    assert.equal(fixture.element.querySelector('.screen-preview img'), null);
    assert.equal(takeControl(fixture.element).disabled, false);
  } finally {
    await fixture.close();
  }
});
