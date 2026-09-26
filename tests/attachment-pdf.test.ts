import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';
import PdfPreview, {
  type PreviewPdfDocument,
  type PreviewPdfLoading,
} from '../src/web/components/attachment-pdf.tsx';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLCanvasElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => ({}),
});
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const url = '/api/artifacts/00000000-0000-4000-8000-000000000001';
const nextUrl = '/api/artifacts/00000000-0000-4000-8000-000000000002';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function fakePdf(
  options: { pages?: number; holdPage?: number; holdRender?: number; height?: number } = {},
) {
  const painted: number[] = [];
  const cancelled: number[] = [];
  const pendingPage = deferred<PDFPageProxy>();
  const pendingRender = deferred<void>();
  let destroyed = 0;
  const makePage = (number: number) =>
    ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: (options.height ?? 800) * scale,
      }),
      render: () => {
        painted.push(number);
        return {
          promise: number === options.holdRender ? pendingRender.promise : Promise.resolve(),
          cancel: () => cancelled.push(number),
        } as unknown as RenderTask;
      },
    }) as unknown as PDFPageProxy;
  const pdf: PreviewPdfDocument = {
    numPages: options.pages ?? 3,
    getPage: async (number) =>
      number === options.holdPage ? pendingPage.promise : makePage(number),
  };
  const loading: PreviewPdfLoading = {
    promise: Promise.resolve(pdf),
    destroy: async () => {
      destroyed++;
    },
  };
  return {
    loading,
    painted,
    cancelled,
    pendingRender,
    pendingPage,
    makePage,
    destroyed: () => destroyed,
  };
}
function mount() {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  return {
    element,
    root,
    close: async () => {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

test('PDF previews render bounded canvas pages, use independent page keys and destroy on close', async () => {
  const f = mount();
  const pdf = fakePdf({ height: 100_000 });
  let calls = 0;
  let parentKeys = 0;
  const loadDocument = async (source: string) => {
    assert.equal(source, url);
    calls++;
    return pdf.loading;
  };
  try {
    await act(async () =>
      f.root.render(
        createElement(
          'div',
          { onKeyDown: () => parentKeys++ },
          createElement(PdfPreview, { url, name: 'private-name.pdf', loadDocument }),
        ),
      ),
    );
    assert.equal(calls, 1);
    const canvas = f.element.querySelector('canvas')!;
    assert.equal(canvas.hidden, false);
    assert.equal(canvas.getAttribute('aria-label'), 'PDF page 1');
    assert.ok(canvas.width * canvas.height <= 8_388_608);
    assert.doesNotMatch(f.element.textContent!, /private-name/);
    assert.deepEqual(pdf.painted, [1]);
    await act(async () =>
      f.element.querySelector<HTMLButtonElement>('[aria-label="Next PDF page"]')!.click(),
    );
    assert.deepEqual(pdf.painted, [1, 2]);
    assert.match(f.element.textContent!, /Page 2 of 3/);
    const controls = f.element.querySelector<HTMLElement>('.attachment-pdf-controls')!;
    await act(async () =>
      controls.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
    );
    assert.match(f.element.textContent!, /Page 3 of 3/);
    assert.equal(parentKeys, 0);
    assert.equal(
      f.element.querySelector<HTMLButtonElement>('[aria-label="Next PDF page"]')!.disabled,
      true,
    );
    await act(async () =>
      controls.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    assert.equal(parentKeys, 1);
  } finally {
    await f.close();
  }
  assert.equal(pdf.destroyed(), 1);
});

test('PDF loading failures remain fixed and retry without exposing filenames or provider errors', async () => {
  const f = mount();
  const pdf = fakePdf({ pages: 1 });
  let calls = 0;
  const loadDocument = async () => {
    if (++calls === 1) throw new Error('private-token-file-path');
    return pdf.loading;
  };
  try {
    await act(async () =>
      f.root.render(createElement(PdfPreview, { url, name: 'private-name.pdf', loadDocument })),
    );
    assert.match(f.element.textContent!, /PDF preview unavailable/);
    assert.doesNotMatch(f.element.textContent!, /private-name|private-token/);
    assert.equal(f.element.querySelector('a[download]')?.getAttribute('href'), url);
    await act(async () =>
      [...f.element.querySelectorAll('button')]
        .find((button) => button.textContent === 'Try again')!
        .click(),
    );
    assert.equal(f.element.querySelector('canvas')?.hidden, false);
    assert.equal(f.element.querySelector('.attachment-pdf-controls'), null);
    assert.equal(calls, 2);
  } finally {
    await f.close();
  }
});

test('closing during lazy load destroys late PDF tasks and never renders their pages', async () => {
  const f = mount();
  const pending = deferred<PreviewPdfLoading>();
  const pdf = fakePdf();
  let signal: AbortSignal | undefined;
  const loadDocument = async (_url: string, current: AbortSignal) => {
    signal = current;
    return pending.promise;
  };
  await act(async () =>
    f.root.render(createElement(PdfPreview, { url, name: 'private.pdf', loadDocument })),
  );
  assert.match(f.element.textContent!, /Loading PDF/);
  await f.close();
  assert.equal(signal?.aborted, true);
  await act(async () => pending.resolve(pdf.loading));
  assert.equal(pdf.destroyed(), 1);
  assert.deepEqual(pdf.painted, []);
});

test('switching PDFs fences late pages and cancelling a render cannot replace the next page', async () => {
  const f = mount();
  const old = fakePdf({ holdPage: 1 });
  const current = fakePdf({ holdRender: 1 });
  const loadDocument = async (source: string) => (source === url ? old.loading : current.loading);
  try {
    await act(async () =>
      f.root.render(createElement(PdfPreview, { url, name: 'old.pdf', loadDocument })),
    );
    await act(async () =>
      f.root.render(
        createElement(PdfPreview, { key: 'new', url: nextUrl, name: 'new.pdf', loadDocument }),
      ),
    );
    await act(async () => old.pendingPage.resolve(old.makePage(1)));
    assert.deepEqual(old.painted, []);
    assert.equal(old.destroyed(), 1);
    await act(async () =>
      f.element.querySelector<HTMLButtonElement>('[aria-label="Next PDF page"]')!.click(),
    );
    assert.deepEqual(current.cancelled, [1]);
    await act(async () => current.pendingRender.reject(new Error('cancelled-private-error')));
    assert.match(f.element.textContent!, /Page 2 of 3/);
    assert.doesNotMatch(f.element.textContent!, /unavailable|private-error/);
    assert.equal(f.element.querySelector('canvas')?.getAttribute('aria-label'), 'PDF page 2');
  } finally {
    await f.close();
  }
});

test('PDF sources reject external and active URLs while local pending blobs remain previewable', async () => {
  const f = mount();
  const pdf = fakePdf();
  const sources: string[] = [];
  const loadDocument = async (source: string) => {
    sources.push(source);
    return pdf.loading;
  };
  try {
    for (const source of [
      'https://example.com/file.pdf',
      '//example.com/file.pdf',
      'data:application/pdf,test',
      `${url}?token=private`,
      '/api/artifacts/not-an-id',
    ]) {
      await act(async () =>
        f.root.render(
          createElement(PdfPreview, {
            key: source,
            url: source,
            name: 'private.pdf',
            loadDocument,
          }),
        ),
      );
      assert.match(f.element.textContent!, /Preview unavailable/);
      assert.equal(f.element.querySelector('a'), null);
    }
    assert.deepEqual(sources, []);
    await act(async () =>
      f.root.render(
        createElement(PdfPreview, {
          key: 'blob',
          url: 'blob:http://localhost:4310/pending-fixture',
          name: 'pending.pdf',
          loadDocument,
        }),
      ),
    );
    assert.deepEqual(sources, ['blob:http://localhost:4310/pending-fixture']);
    assert.equal(f.element.querySelector('canvas')?.hidden, false);
  } finally {
    await f.close();
  }
});
