import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import { createElement, act, useState } from 'react';
import { createComposerExtensions } from '../src/web/lib/composer-editor.ts';
import type { Artifact } from '../src/shared/contracts.ts';
import type { ComposerSendResult } from '../src/web/components/composer.tsx';

const editorModifier: KeyboardEventInit =
  typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform)
    ? { metaKey: true }
    : { ctrlKey: true };
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'NodeFilter',
  'Text',
  'ShadowRoot',
  'DOMParser',
  'MutationObserver',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'File',
  'FormData',
  'Blob',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
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
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const { Composer } = await import('../src/web/components/composer.tsx');
const { Sidebar } = await import('../src/web/components/sidebar.tsx');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

function editorFixture(
  content = '',
  callbacks: Partial<{ submit(): void; upload(files: File[]): void }> = {},
) {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createComposerExtensions({ submit() {}, upload() {}, ...callbacks }),
    content,
    contentType: 'markdown',
  });
  return {
    editor,
    dispose: () => {
      editor.destroy();
      element.remove();
    },
  };
}
function paste(element: HTMLElement, values: { text?: string; html?: string; files?: File[] }) {
  const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  const files = values.files ?? [];
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      getData: (type: string) =>
        type === 'text/plain'
          ? (values.text ?? '')
          : type === 'text/html'
            ? (values.html ?? '')
            : '',
    },
  });
  element.dispatchEvent(event);
  return event;
}
function key(element: HTMLElement, options: KeyboardEventInit = {}) {
  element.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }),
  );
}
async function mountComposer(
  onSend: (text: string, attachments: Artifact[]) => Promise<ComposerSendResult>,
  initial = '',
) {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  function Fixture() {
    const [text, setText] = useState(initial);
    return createElement(Composer, {
      ready: true,
      sending: false,
      text,
      setText,
      replyTo: null,
      clearReply() {},
      onSend,
    });
  }
  await act(async () => {
    root.render(createElement(Fixture));
    await tick();
  });
  return {
    element,
    input: () => element.querySelector<HTMLElement>('[role="textbox"]')!,
    dispose: async () => {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

test('Tiptap keeps Markdown rendered and round-trips lists, code, tables and task lists', () => {
  const fixture = editorFixture(
    '# Draft\n\n**Important** and *helpful*\n\n- One\n- Two\n\n```ts\nconst value = 1\n```\n\n| Item | Count |\n| --- | --- |\n| Notes | 2 |\n\n- [x] Done',
  );
  try {
    const html = fixture.editor.getHTML();
    assert.match(html, /<h1>Draft<\/h1>/);
    assert.match(html, /<strong>Important<\/strong>/);
    assert.match(html, /<em>helpful<\/em>/);
    assert.match(html, /<table/);
    assert.match(html, /data-type="taskList"/);
    assert.match(fixture.editor.getMarkdown(), /\*\*Important\*\*/);
    assert.match(fixture.editor.getMarkdown(), /\| Notes\s*\| 2/);
    assert.match(fixture.editor.getMarkdown(), /\[x\] Done/);
    fixture.editor.commands.setContent('', { contentType: 'markdown' });
    for (const character of '**typed**') {
      const view = fixture.editor.view;
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (handler) =>
        handler(view, from, to, character, () => view.state.tr.insertText(character, from, to)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(character, from, to));
    }
    assert.match(fixture.editor.getHTML(), /<strong>typed<\/strong>/);
  } finally {
    fixture.dispose();
  }
});

test('Enter submits once, Shift Enter adds a line, and composition Enter does not submit', () => {
  let submitted = 0;
  const fixture = editorFixture('Hello', {
    submit: () => {
      submitted++;
    },
  });
  try {
    fixture.editor.commands.setTextSelection('Hello'.length + 1);
    key(fixture.editor.view.dom);
    assert.equal(submitted, 1);
    key(fixture.editor.view.dom, { shiftKey: true });
    assert.equal(submitted, 1);
    assert.match(fixture.editor.getHTML(), /<br/);
    key(fixture.editor.view.dom, { isComposing: true });
    key(fixture.editor.view.dom, { keyCode: 229 });
    assert.equal(submitted, 1);
    key(fixture.editor.view.dom, { ctrlKey: true });
    assert.equal(submitted, 2);
  } finally {
    fixture.dispose();
  }
});

for (const [label, content, listType, itemType] of [
  ['bullet', '- First', 'bulletList', 'listItem'],
  ['numbered', '1. First', 'orderedList', 'listItem'],
  ['task', '- [x] First', 'taskList', 'taskItem'],
] as const) {
  test(`Shift Enter continues a ${label} list and leaves an empty item without sending`, () => {
    let submitted = 0;
    const fixture = editorFixture(content, { submit: () => submitted++ });
    try {
      const editor = fixture.editor;
      editor.commands.setTextSelection(Selection.atEnd(editor.state.doc).from);
      key(editor.view.dom, { shiftKey: true });
      let list = editor.getJSON().content?.[0];
      assert.equal(list?.type, listType);
      assert.equal(list?.content?.length, 2);
      assert.equal(list?.content?.[1]?.type, itemType);
      if (itemType === 'taskItem') assert.equal(list?.content?.[1]?.attrs?.checked, false);
      assert.doesNotMatch(editor.getHTML(), /<br/);
      editor.commands.insertContent('Second');
      key(editor.view.dom);
      assert.equal(submitted, 1);
      assert.match(editor.getMarkdown(), /Second/);
      key(editor.view.dom, { shiftKey: true });
      list = editor.getJSON().content?.[0];
      assert.equal(list?.content?.length, 3);
      key(editor.view.dom, { shiftKey: true });
      const nodes = editor.getJSON().content!;
      assert.equal(nodes[0]?.content?.length, 2);
      assert.equal(nodes[1]?.type, 'paragraph');
      assert.equal(editor.isActive(itemType), false);
      assert.equal(editor.state.selection.$from.depth, 1);
      assert.equal(submitted, 1);
    } finally {
      fixture.dispose();
    }
  });
}

test('Shift Enter outdents an empty nested list item one level', () => {
  const fixture = editorFixture('- Parent\n  - Child');
  try {
    const editor = fixture.editor;
    editor.commands.setTextSelection(Selection.atEnd(editor.state.doc).from);
    key(editor.view.dom, { shiftKey: true });
    key(editor.view.dom, { shiftKey: true });
    const list = editor.state.doc.firstChild!;
    assert.equal(list.childCount, 2);
    assert.equal(list.firstChild?.child(1).childCount, 1);
    assert.equal(list.child(1).firstChild?.type.name, 'paragraph');
    assert.equal(editor.state.selection.$from.depth, 3);
    key(editor.view.dom, { shiftKey: true });
    assert.equal(editor.isActive('listItem'), false);
  } finally {
    fixture.dispose();
  }
});

test('sidebar leaves native editor bold, italic and underline shortcuts in the composer', async () => {
  const fixture = editorFixture('Format this');
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const actions: string[] = [];
  try {
    await act(async () =>
      root.render(
        createElement(Sidebar, {
          path: '/',
          collapsed: false,
          onToggle: () => actions.push('toggle'),
          onNavigate: (path) => actions.push(path),
          onRestart: () => actions.push('restart'),
          inspectorEnabled: true,
          onToggleInspector: () => actions.push('inspect'),
        }),
      ),
    );
    fixture.editor.view.dom.focus();
    fixture.editor.commands.setTextSelection({ from: 1, to: 12 });
    for (const [letter, mark] of [
      ['b', 'bold'],
      ['i', 'italic'],
      ['u', 'underline'],
    ]) {
      await act(async () => key(fixture.editor.view.dom, { key: letter, ...editorModifier }));
      assert.equal(fixture.editor.isActive(mark), true);
    }
    assert.deepEqual(actions, []);
  } finally {
    fixture.dispose();
    await act(async () => root.unmount());
    element.remove();
  }
});

test('paste uploads each file once and preserves accompanying Markdown without loading pasted images', () => {
  const uploaded: File[][] = [];
  const fixture = editorFixture('', { upload: (files) => uploaded.push(files) });
  try {
    const image = new File(['fixture'], 'clipboard.png', { type: 'image/png' });
    const event = paste(fixture.editor.view.dom, {
      files: [image],
      text: '**Caption**',
      html: '<img src="https://tracking.example/image">',
    });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(uploaded, [[image]]);
    assert.match(fixture.editor.getHTML(), /<strong>Caption<\/strong>/);
    assert.doesNotMatch(fixture.editor.getHTML(), /<img|tracking/);
    paste(fixture.editor.view.dom, { text: '\n\n## Pasted title\n\n- A\n- B' });
    assert.match(fixture.editor.getHTML(), /<h2>Pasted title<\/h2>/);
    assert.match(fixture.editor.getHTML(), /<ul>/);
  } finally {
    fixture.dispose();
  }
});

test('rich HTML paste preserves supported formatting and discards scripts, remote images and unsafe links', () => {
  const fixture = editorFixture();
  try {
    paste(fixture.editor.view.dom, {
      text: 'Safe',
      html: '<p><strong>Safe</strong><img src="https://tracking.example/pixel"><script>window.bad=true</script><a href="javascript:alert(1)">link</a></p>',
    });
    assert.match(fixture.editor.getHTML(), /<strong>Safe<\/strong>/);
    assert.doesNotMatch(fixture.editor.getHTML(), /<script|<img|javascript:|tracking/);
  } finally {
    fixture.dispose();
  }
});

test('composer has no formatting switch and restores a failed message alongside a newly typed draft', async () => {
  let finish!: (result: ComposerSendResult) => void;
  const sent: string[] = [];
  const fixture = await mountComposer(async (text) => {
    sent.push(text);
    return new Promise<ComposerSendResult>((resolve) => {
      finish = resolve;
    });
  }, '**First draft**');
  try {
    assert.match(fixture.input().innerHTML, /<strong>First draft<\/strong>/);
    assert.equal(fixture.element.querySelector('textarea'), null);
    assert.equal(fixture.element.querySelector('[aria-label="Format message"]'), null);
    assert.doesNotMatch(fixture.element.textContent ?? '', /Preview|Formatting/);
    await act(async () => {
      fixture.input().focus();
      key(fixture.input());
      key(fixture.input());
    });
    assert.deepEqual(sent, ['**First draft**']);
    await act(async () => {
      paste(fixture.input(), { text: 'Next message' });
    });
    await act(async () => {
      finish({ sent: false, restoreText: true });
      await tick();
    });
    assert.match(fixture.input().textContent ?? '', /First draft/);
    assert.match(fixture.input().textContent ?? '', /Next message/);
    assert.equal(document.activeElement, fixture.input());
  } finally {
    await fixture.dispose();
  }
});

test('consecutive image pastes upload independently and block submit until both attachments are ready', async () => {
  const previousFetch = globalThis.fetch;
  const pending: ((response: Response) => void)[] = [];
  const sent: { text: string; attachments: Artifact[] }[] = [];
  globalThis.fetch = async () => new Promise<Response>((resolve) => pending.push(resolve));
  const fixture = await mountComposer(async (text, attachments) => {
    sent.push({ text, attachments });
    return { sent: true };
  });
  try {
    await act(async () => {
      paste(fixture.input(), { files: [new File(['a'], 'first.png', { type: 'image/png' })] });
      paste(fixture.input(), { files: [new File(['b'], 'second.png', { type: 'image/png' })] });
      key(fixture.input());
    });
    assert.equal(pending.length, 2);
    assert.equal(sent.length, 0);
    assert.equal(
      fixture.element.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled,
      true,
    );
    const artifacts = ['first.png', 'second.png'].map((name, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      name,
      mimeType: 'image/png',
      size: 1,
      url: `/api/artifacts/00000000-0000-4000-8000-00000000000${index}`,
    }));
    await act(async () => {
      pending[1](new Response(JSON.stringify(artifacts[1])));
      await tick();
    });
    assert.equal(
      fixture.element.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled,
      true,
    );
    await act(async () => {
      pending[0](new Response(JSON.stringify(artifacts[0])));
      await tick();
    });
    await act(async () => {
      key(fixture.input());
      await tick();
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, '');
    assert.deepEqual(sent[0].attachments, artifacts);
    assert.equal(fixture.element.querySelector('.pending-attachment'), null);
  } finally {
    globalThis.fetch = previousFetch;
    await fixture.dispose();
  }
});

test('pending images show thumbnail-only previews and cancelled uploads cannot restore removed attachments', async (t) => {
  const previousFetch = globalThis.fetch;
  const pending: Array<{ resolve(response: Response): void; signal: AbortSignal }> = [];
  const revoked: string[] = [];
  let previews = 0;
  t.mock.method(URL, 'createObjectURL', () => `blob:fixture-${++previews}`);
  t.mock.method(URL, 'revokeObjectURL', (url: string) => revoked.push(url));
  globalThis.fetch = async (_url, init) =>
    new Promise<Response>((resolve) =>
      pending.push({ resolve, signal: init!.signal as AbortSignal }),
    );
  const sent: Artifact[][] = [];
  const fixture = await mountComposer(async (_text, files) => {
    sent.push(files);
    return sent.length > 1 ? { sent: true } : { sent: false, restoreText: true };
  });
  const artifacts = ['first.png', 'second.png'].map((name, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    name,
    mimeType: 'image/png',
    size: 1,
    url: `/api/artifacts/00000000-0000-4000-8000-00000000000${index}`,
  }));
  try {
    await act(async () =>
      paste(fixture.input(), {
        files: [
          new File(['a'], 'first.png', { type: 'image/png' }),
          new File(['b'], 'second.png', { type: 'image/png' }),
        ],
      }),
    );
    const thumbnails = fixture.element.querySelectorAll('.pending-attachment.is-image');
    assert.equal(thumbnails.length, 2);
    for (const thumbnail of thumbnails) assert.equal(thumbnail.textContent, '');
    assert.equal(thumbnails[0].querySelector('img')?.getAttribute('src'), 'blob:fixture-1');
    const trigger = fixture.element.querySelector<HTMLButtonElement>(
      '[aria-label="Preview image 1 of 2"]',
    )!;
    await act(async () => {
      trigger.click();
      await tick();
    });
    const viewer = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(viewer.querySelector('h2')?.textContent, 'first.png');
    assert.equal(viewer.querySelector('a[download]'), null);
    await act(async () =>
      viewer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    );
    assert.equal(viewer.querySelector('h2')?.textContent, 'second.png');
    await act(async () => {
      viewer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await tick();
    });
    assert.equal(document.activeElement, trigger);
    await act(async () =>
      fixture.element.querySelector<HTMLButtonElement>('[aria-label="Remove first.png"]')!.click(),
    );
    assert.equal(pending[0].signal.aborted, true);
    assert.deepEqual(revoked, ['blob:fixture-1']);
    await act(async () => {
      pending[0].resolve(new Response(JSON.stringify(artifacts[0])));
      pending[1].resolve(new Response(JSON.stringify(artifacts[1])));
      await tick();
    });
    assert.equal(fixture.element.querySelectorAll('.pending-attachment').length, 1);
    assert.equal(fixture.element.querySelector('[aria-label="Remove first.png"]'), null);
    await act(async () => {
      key(fixture.input());
      await tick();
    });
    assert.deepEqual(sent, [[artifacts[1]]]);
    assert.equal(fixture.element.querySelectorAll('.pending-attachment.is-image').length, 1);
    assert.deepEqual(revoked, ['blob:fixture-1']);
    await act(async () => {
      key(fixture.input());
      await tick();
    });
    assert.deepEqual(sent, [[artifacts[1]], [artifacts[1]]]);
    assert.equal(fixture.element.querySelector('.pending-attachment'), null);
    assert.deepEqual(revoked, ['blob:fixture-1', 'blob:fixture-2']);
    assert.equal(document.activeElement, fixture.input());
  } finally {
    await fixture.dispose();
    globalThis.fetch = previousFetch;
  }
});

test('pending mixed media preview locally without active documents and keep upload order when sent', async (t) => {
  const previousFetch = globalThis.fetch;
  const pending: Array<(response: Response) => void> = [];
  const revoked: string[] = [];
  let previews = 0;
  t.mock.method(URL, 'createObjectURL', () => `blob:mixed-${++previews}`);
  t.mock.method(URL, 'revokeObjectURL', (url: string) => revoked.push(url));
  globalThis.fetch = async () => new Promise<Response>((resolve) => pending.push(resolve));
  const files = [
    new File(['audio'], 'voice.mp3', { type: 'audio/mpeg' }),
    new File(['pdf'], 'report.pdf', { type: 'application/pdf' }),
    new File(['video'], 'clip.mp4', { type: 'video/mp4' }),
    new File(['image'], 'photo.png', { type: 'image/png' }),
    new File(['svg'], 'vector.svg', { type: 'image/svg+xml' }),
  ];
  const artifacts = files.map((file, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    name: file.name,
    mimeType: file.type,
    size: file.size,
    url: `/api/artifacts/00000000-0000-4000-8000-00000000000${index}`,
  }));
  const sent: Artifact[][] = [];
  const fixture = await mountComposer(async (_text, attachments) => {
    sent.push(attachments);
    return { sent: true };
  });
  try {
    await act(async () => paste(fixture.input(), { files }));
    assert.equal(previews, 4);
    assert.equal(fixture.element.querySelectorAll('.pending-attachment.is-preview').length, 4);
    assert.match(fixture.element.textContent ?? '', /vector.svg/);
    assert.doesNotMatch(
      Array.from(fixture.element.querySelectorAll('.is-preview'))
        .map((node) => node.textContent)
        .join(''),
      /voice.mp3|report.pdf|clip.mp4|photo.png/,
    );
    const trigger = fixture.element.querySelector<HTMLButtonElement>(
      '[aria-label="Preview attachment 1 of 4"]',
    )!;
    await act(async () => {
      trigger.click();
      await tick();
    });
    const viewer = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const surface = viewer.querySelector<HTMLElement>('.attachment-viewer-surface')!;
    assert.equal(viewer.querySelector('audio')?.getAttribute('src'), 'blob:mixed-1');
    assert.equal(document.activeElement, surface);
    await act(async () => key(surface, { key: 'ArrowRight' }));
    assert.equal(
      viewer.querySelector('.attachment-pdf-preview a[download]')?.getAttribute('href'),
      'blob:mixed-2',
    );
    await act(async () => key(surface, { key: 'ArrowRight' }));
    assert.equal(viewer.querySelector('video')?.getAttribute('src'), 'blob:mixed-3');
    await act(async () => key(surface, { key: 'End' }));
    assert.equal(viewer.querySelector('img')?.getAttribute('src'), 'blob:mixed-4');
    assert.equal(document.activeElement, surface);
    await act(async () => {
      for (let index = pending.length - 1; index >= 0; index--)
        pending[index](new Response(JSON.stringify(artifacts[index])));
      await tick();
    });
    assert.equal(viewer.querySelector('a[download]')?.getAttribute('href'), artifacts[3].url);
    await act(async () => {
      key(surface, { key: 'Escape' });
      await tick();
    });
    assert.equal(document.activeElement, trigger);
    await act(async () => {
      key(fixture.input());
      await tick();
    });
    assert.deepEqual(sent, [artifacts]);
    assert.deepEqual(revoked, ['blob:mixed-1', 'blob:mixed-2', 'blob:mixed-3', 'blob:mixed-4']);
    assert.equal(fixture.element.querySelector('.pending-attachment'), null);
  } finally {
    globalThis.fetch = previousFetch;
    await fixture.dispose();
  }
});

test('unmount aborts pending uploads and releases temporary image URLs even if transport finishes late', async (t) => {
  const previousFetch = globalThis.fetch;
  const revoked: string[] = [];
  t.mock.method(URL, 'createObjectURL', () => 'blob:unmounted-image');
  t.mock.method(URL, 'revokeObjectURL', (url: string) => revoked.push(url));
  let signal: AbortSignal | undefined;
  let complete!: (response: Response) => void;
  globalThis.fetch = async (_url, init) => {
    signal = init!.signal as AbortSignal;
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  const fixture = await mountComposer(async () => {
    assert.fail('An unmounted draft must not submit.');
  });
  try {
    await act(async () =>
      paste(fixture.input(), { files: [new File(['a'], 'pending.png', { type: 'image/png' })] }),
    );
    await fixture.dispose();
    assert.equal(signal?.aborted, true);
    assert.deepEqual(revoked, ['blob:unmounted-image']);
    await act(async () => {
      complete(
        new Response(
          JSON.stringify({
            id: 'a',
            name: 'pending.png',
            mimeType: 'image/png',
            size: 1,
            url: '/api/artifacts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          }),
        ),
      );
      await tick();
    });
    assert.deepEqual(revoked, ['blob:unmounted-image']);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
