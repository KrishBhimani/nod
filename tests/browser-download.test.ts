import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  mkdir,
  link,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { browserDownloadBytes } from '../src/ports/computer.ts';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import {
  completedDownloads,
  createDownloadCapture,
  decodeDownload,
  downloadFile,
  readDownload,
  waitForDownload,
} from '../src/providers/agent-browser/downloads.ts';
import { existingDaemonCommand } from '../src/providers/agent-browser/screens.ts';
import {
  createContainerBrowserComputer,
  type BrowserBridgeLauncher,
} from '../src/providers/container-browser/index.ts';
import { startContainerBrowserWorker } from '../src/providers/container-browser/worker.ts';
import { runBrowserBridge } from '../src/providers/container-browser/bridge.ts';
import { browserDownloadPdf, createBrowserDownloadFixture } from './browser-download-fixture.ts';

function downloadWaitProbe(t: TestContext) {
  const controller = new AbortController();
  let scanned!: () => void;
  const scan = new Promise<void>((resolve) => {
    scanned = resolve;
  });
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  let checks = 0;
  t.mock.method(controller.signal, 'throwIfAborted', () => {
    check();
    if (++checks === 2) scanned();
  });
  return {
    controller,
    async scan(pending: Promise<unknown>) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          scan,
          pending.then(() => assert.fail('Capture completed before its scan.')),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('The download scan did not start.')), 2000);
          }),
        ]);
      } catch (error) {
        controller.abort(error);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function createDownloadBrowser(root: string, captureStarted?: () => void) {
  const socketPath = join(root, 'control.sock');
  let browserRoot = '';
  const worker = await startContainerBrowserWorker({
    socketPath,
    dataRoot: root,
    createComputer: (dataRoot) => {
      browserRoot = dataRoot;
      return createAgentBrowserComputer({
        dataRoot,
        browserExecutable: process.env.OTTO_TEST_BROWSER_EXECUTABLE,
        headless: true,
        daemonCommand: async (...args) => {
          const result = await existingDaemonCommand(...args);
          if (args[1].action === 'evaluate' && args[1].script === 'document.contentType')
            captureStarted?.();
          return result;
        },
      });
    },
  });
  const launch: BrowserBridgeLauncher = () => {
    const process = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    void runBrowserBridge({ socketPath, input: process.stdin, output: process.stdout }).then(
      () => process.emit('close', 0),
      () => process.emit('close', 1),
    );
    return process as unknown as ChildProcessWithoutNullStreams;
  };
  const value = createContainerBrowserComputer({
    dataRoot: join(root, 'owner'),
    spawn: launch,
  });
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw new Error(`Native browser fixture stage: ${name}`, { cause: error });
    }
  };
  const computer = {
    ...value,
    act: (...args: Parameters<typeof value.act>) =>
      step(`act:${args[0]}:${args[1].action}`, () => value.act(...args)),
    download: (...args: Parameters<NonNullable<typeof value.download>>) =>
      step(`download:${args[0]}`, () => value.download!(...args)),
    close: (...args: Parameters<typeof value.close>) =>
      step(`close:${args[0]}`, () => value.close(...args)),
  };
  return {
    computer,
    browserRoot: () => browserRoot,
    close: async () => {
      try {
        await computer.dispose();
      } finally {
        await worker.close();
      }
    },
  };
}

test('browser file validation bounds encoded bytes and rejects unsafe metadata', async () => {
  assert.deepEqual(
    decodeDownload({ data: browserDownloadPdf.toString('base64'), mimeType: 'application/pdf' }),
    {
      bytes: browserDownloadPdf,
      name: 'download.pdf',
      mimeType: 'application/pdf',
    },
  );
  assert.throws(() =>
    decodeDownload({
      data: 'A'.repeat(Math.ceil(browserDownloadBytes / 3) * 4 + 4),
      mimeType: 'application/pdf',
    }),
  );
  assert.throws(() => decodeDownload({ data: 'Zh==', mimeType: 'application/pdf' }));
  assert.throws(() => decodeDownload({ data: 'Zg==trailing', mimeType: 'application/pdf' }));
  assert.throws(() => downloadFile(Buffer.alloc(browserDownloadBytes + 1)));
  assert.throws(() => downloadFile(Buffer.alloc(0)));
  for (const name of ['../private', 'folder/file', 'folder\\file', '.', '..', 'file\nname'])
    assert.throws(() => downloadFile(browserDownloadPdf, name));
  assert.throws(() => downloadFile(Buffer.from('text'), 'file', 'text/html\r\nX-Header: value'));
});

test('no-target capture waits through absent, partial and completed native files', async (t) => {
  const root = await mkdtemp('/tmp/sk-download-wait-');
  const directory = join(root, 'downloads');
  const probe = downloadWaitProbe(t);
  const pending = waitForDownload(directory, probe.controller.signal);
  void pending.catch(() => {});
  try {
    await probe.scan(pending);
    await mkdir(directory);
    await writeFile(join(directory, 'invoice.pdf.crdownload'), browserDownloadPdf);
    assert.equal(
      await Promise.race([pending.then(() => 'complete'), delay(50).then(() => 'pending')]),
      'pending',
    );
    await rename(join(directory, 'invoice.pdf.crdownload'), join(directory, 'invoice.pdf'));
    const file = await pending;
    assert.equal(file, 'invoice.pdf');
    assert.deepEqual((await readDownload(directory, file)).bytes, browserDownloadPdf);
  } finally {
    await pending.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('no-target capture cancellation preserves partial and later completed files', async (t) => {
  const root = await mkdtemp('/tmp/sk-download-cancel-');
  const probe = downloadWaitProbe(t);
  const abort = probe.controller;
  try {
    await writeFile(join(root, 'invoice.pdf.crdownload'), browserDownloadPdf);
    const pending = waitForDownload(root, abort.signal);
    await probe.scan(pending);
    const reason = new Error('Stopped capture.');
    abort.abort(reason);
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof Error && error.name === 'AbortError' && error.cause === reason,
    );
    assert.deepEqual(await readdir(root), ['invoice.pdf.crdownload']);
    await rename(join(root, 'invoice.pdf.crdownload'), join(root, 'invoice.pdf'));
    assert.deepEqual(await readFile(join(root, 'invoice.pdf')), browserDownloadPdf);
    await assert.rejects(waitForDownload(root, abort.signal), (error: unknown) => error === reason);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('no-target capture bounds stalled and empty directories without deleting files', async () => {
  const root = await mkdtemp('/tmp/sk-download-stalled-');
  try {
    await assert.rejects(waitForDownload(root, undefined, 50), /did not finish/);
    await writeFile(join(root, 'invoice.pdf.crdownload'), browserDownloadPdf);
    await assert.rejects(waitForDownload(root, undefined, 50), /did not finish/);
    assert.deepEqual(await readdir(root), ['invoice.pdf.crdownload']);
    assert.deepEqual(await readFile(join(root, 'invoice.pdf.crdownload')), browserDownloadPdf);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('no-target capture refuses an older file beside partial or completed downloads', async () => {
  const root = await mkdtemp('/tmp/sk-download-ambiguous-');
  try {
    await writeFile(join(root, 'previous.pdf'), browserDownloadPdf);
    await writeFile(join(root, 'invoice.pdf.crdownload'), browserDownloadPdf);
    await assert.rejects(waitForDownload(root), /Choose the specific/);
    await rename(join(root, 'invoice.pdf.crdownload'), join(root, 'invoice.pdf'));
    await assert.rejects(waitForDownload(root), /Choose the specific/);
    assert.deepEqual((await readdir(root)).sort(), ['invoice.pdf', 'previous.pdf']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('no-target capture refuses replaced directories and unsafe native files', async (t) => {
  const root = await mkdtemp('/tmp/sk-download-unsafe-');
  try {
    for (const kind of ['symlink', 'hardlink', 'oversized', 'entries', 'directory'] as const) {
      await t.test(kind, async () => {
        const directory = join(root, kind);
        await mkdir(directory);
        await writeFile(join(root, `${kind}.pdf`), browserDownloadPdf);
        if (kind === 'symlink') await symlink(join(root, `${kind}.pdf`), join(directory, 'file'));
        if (kind === 'hardlink') await link(join(root, `${kind}.pdf`), join(directory, 'file'));
        if (kind === 'oversized')
          await writeFile(
            join(directory, 'file.crdownload'),
            Buffer.alloc(browserDownloadBytes + 1),
          );
        if (kind === 'entries')
          await Promise.all(
            Array.from({ length: 65 }, (_, index) => writeFile(join(directory, `${index}`), 'x')),
          );
        if (kind === 'directory') await mkdir(join(directory, 'file'));
        await assert.rejects(waitForDownload(directory));
      });
    }
    const directory = join(root, 'replaced');
    await mkdir(directory);
    await writeFile(join(directory, 'file.crdownload'), browserDownloadPdf);
    const probe = downloadWaitProbe(t);
    const pending = waitForDownload(directory, probe.controller.signal);
    void pending.catch(() => {});
    await probe.scan(pending);
    await rename(directory, join(root, 'original'));
    await mkdir(directory);
    await writeFile(join(directory, 'replacement.pdf'), browserDownloadPdf);
    await assert.rejects(pending, /directory/);
    assert.deepEqual(await readFile(join(root, 'original', 'file.crdownload')), browserDownloadPdf);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capture cleanup preserves existing files and their renamed identities after validation failure', async () => {
  const root = await mkdtemp('/tmp/sk-download-cleanup-');
  try {
    await writeFile(join(root, 'previous.pdf'), browserDownloadPdf);
    await writeFile(join(root, 'previous.crdownload'), 'previous partial');
    const capture = await createDownloadCapture(root);
    await rename(join(root, 'previous.crdownload'), join(root, 'previous-finished.pdf'));
    await writeFile(join(root, capture.file), Buffer.alloc(browserDownloadBytes + 1));
    await assert.rejects(capture.inspect());
    await assert.rejects(readDownload(root, capture.file));
    await capture.cleanup();
    assert.deepEqual((await readdir(root)).sort(), ['previous-finished.pdf', 'previous.pdf']);
    assert.equal(await readFile(join(root, 'previous-finished.pdf'), 'utf8'), 'previous partial');
    assert.deepEqual(await readFile(join(root, 'previous.pdf')), browserDownloadPdf);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capture cleanup does not adopt files created after its final inspection', async () => {
  const root = await mkdtemp('/tmp/sk-download-late-file-');
  try {
    const capture = await createDownloadCapture(root);
    await writeFile(join(root, capture.file), browserDownloadPdf);
    assert.deepEqual(await capture.inspect(), [capture.file]);
    await writeFile(join(root, 'unrelated.pdf'), 'unrelated bytes');
    await capture.cleanup();
    assert.deepEqual(await readdir(root), ['unrelated.pdf']);
    assert.equal(await readFile(join(root, 'unrelated.pdf'), 'utf8'), 'unrelated bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('browser captures refuse symlinks, partial files, multiple links and excessive file size', async () => {
  const root = await mkdtemp('/tmp/sk-download-files-');
  try {
    const directory = join(root, 'downloads');
    await mkdir(directory);
    await writeFile(join(root, 'private'), 'private sentinel');
    await symlink(join(root, 'private'), join(directory, 'private.pdf'));
    await writeFile(join(directory, 'partial.crdownload'), browserDownloadPdf);
    assert.deepEqual(await completedDownloads(directory), []);
    await assert.rejects(readDownload(directory, 'private.pdf'));
    await assert.rejects(readDownload(directory, '../private'));
    await writeFile(join(directory, 'invoice.pdf'), browserDownloadPdf);
    assert.deepEqual((await readDownload(directory, 'invoice.pdf')).bytes, browserDownloadPdf);
    await writeFile(join(directory, 'large'), Buffer.alloc(browserDownloadBytes + 1));
    await assert.rejects(readDownload(directory, 'large'));
    await symlink(directory, join(root, 'alias'));
    await assert.rejects(completedDownloads(join(root, 'alias')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'authenticated browser PDFs cross the real private bridge without sharing the profile',
  {
    skip: !process.env.OTTO_TEST_BROWSER_EXECUTABLE,
    timeout: 180_000,
  },
  async (t) => {
    const root = await mkdtemp('/tmp/sk-download-bridge-');
    const fixture = await createBrowserDownloadFixture();
    const bridge = await createDownloadBrowser(root);
    const computer = bridge.computer;
    try {
      assert.equal((await fetch(`${fixture.origin}/invoice.pdf`)).status, 403);
      for (const [id, input] of [
        ['attachment', { selector: '#download', name: 'invoice.pdf' }],
        ['inline-url', { url: `${fixture.origin}/inline.pdf`, name: 'invoice.pdf' }],
        ['blob', { selector: '#blob', name: 'invoice.pdf' }],
        ['blob-anchor', { selector: '#blob-anchor', name: 'invoice.pdf' }],
      ] as const) {
        await computer.act(id, { action: 'open', url: `${fixture.origin}/session` });
        const before = fixture.authenticatedDownloads();
        const file = await computer.download!(id, input);
        assert.equal(fixture.authenticatedDownloads(), before + 1);
        assert.deepEqual(file, {
          bytes: browserDownloadPdf,
          name: 'invoice.pdf',
          mimeType: 'application/pdf',
        });
      }
      await computer.act('cross-inline', { action: 'open', url: `${fixture.origin}/session` });
      const redirected = fixture.authenticatedDownloads();
      await assert.rejects(
        computer.download!('cross-inline', { url: `${fixture.origin}/redirect.pdf` }),
      );
      assert.equal(fixture.authenticatedDownloads(), redirected + 1);
      await computer.act('cross-inline', {
        action: 'open',
        url: `${fixture.crossOrigin}/inline.pdf`,
      });
      assert.deepEqual((await computer.download!('cross-inline', {})).bytes, browserDownloadPdf);
      await computer.act('blob-anchor', { action: 'click', selector: '#download' });
      assert.deepEqual((await computer.download!('blob-anchor', {})).bytes, browserDownloadPdf);
      await computer.act('current-inline', { action: 'open', url: `${fixture.origin}/session` });
      await computer.act('current-inline', { action: 'click', selector: '#download' });
      await computer.act('current-inline', {
        action: 'open',
        url: `${fixture.origin}/inline.pdf?version=current`,
      });
      assert.deepEqual(
        (await computer.download!('current-inline', {})).bytes,
        Buffer.concat([browserDownloadPdf, Buffer.from('% current document\n')]),
      );
      await computer.close('attachment');
      await computer.act('popup', { action: 'open', url: `${fixture.origin}/session` });
      await computer.act('popup', { action: 'click', selector: '#popup' });
      assert.deepEqual(
        (await computer.download!('popup', { name: 'popup.pdf' })).bytes,
        browserDownloadPdf,
      );
      await assert.rejects(computer.download!('unrelated-task', {}));
      await assert.rejects(computer.download!('popup', { url: 'file:///etc/passwd' }));
      assert.equal(fixture.unauthenticatedDownloads(), 1);
      for (const [id, input] of [
        ['cross-selector', { selector: '#cross-origin', name: 'hosted.pdf' }],
        ['cross-url', { url: `${fixture.crossOrigin}/invoice.pdf`, name: 'hosted.pdf' }],
      ] as const) {
        await t.test(id, async () => {
          await computer.act(id, { action: 'open', url: `${fixture.origin}/session` });
          const before = fixture.authenticatedDownloads();
          assert.deepEqual((await computer.download!(id, input)).bytes, browserDownloadPdf);
          assert.equal(fixture.authenticatedDownloads(), before + 1);
        });
      }
      await computer.act('large', { action: 'open', url: `${fixture.origin}/session` });
      const downloads = join(bridge.browserRoot(), 'runtime', 'downloads', 'large');
      await mkdir(downloads, { recursive: true });
      await writeFile(join(downloads, 'previous.pdf'), browserDownloadPdf);
      await writeFile(join(downloads, 'previous.crdownload'), 'preexisting partial');
      await assert.rejects(computer.download!('large', { selector: '#large' }));
      assert.deepEqual((await readdir(downloads)).sort(), ['previous.crdownload', 'previous.pdf']);
      assert.deepEqual(await readFile(join(downloads, 'previous.pdf')), browserDownloadPdf);
      assert.equal(
        await readFile(join(downloads, 'previous.crdownload'), 'utf8'),
        'preexisting partial',
      );
      await computer.act('slow', { action: 'open', url: `${fixture.origin}/session` });
      const slowDirectory = join(bridge.browserRoot(), 'runtime', 'downloads', 'slow');
      await mkdir(slowDirectory, { recursive: true });
      await writeFile(join(slowDirectory, 'previous.pdf'), browserDownloadPdf);
      const abort = new AbortController();
      const failed = assert.rejects(
        computer.download!('slow', { selector: '#slow' }, abort.signal),
      );
      await fixture.slowDownloadStarted();
      abort.abort();
      await failed;
      assert.deepEqual(await readdir(slowDirectory), ['previous.pdf']);
      assert.deepEqual(await readFile(join(slowDirectory, 'previous.pdf')), browserDownloadPdf);
    } finally {
      try {
        await bridge.close();
      } finally {
        try {
          await fixture.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  },
);

test(
  'an authenticated native download waits for the original clicked response to finish',
  { skip: !process.env.OTTO_TEST_BROWSER_EXECUTABLE, timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp('/tmp/sk-download-held-');
    const fixture = await createBrowserDownloadFixture();
    let captureStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      captureStarted = resolve;
    });
    const bridge = await createDownloadBrowser(root, captureStarted);
    let pending: ReturnType<typeof bridge.computer.download> | undefined;
    try {
      await bridge.computer.act('held', { action: 'open', url: `${fixture.origin}/session` });
      await bridge.computer.act('held', { action: 'click', selector: '#held' });
      await fixture.heldDownloadStarted();
      const directory = join(bridge.browserRoot(), 'runtime', 'downloads', 'held');
      const deadline = performance.now() + 5000;
      for (;;) {
        const files = await readdir(directory).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw error;
        });
        if (files.length === 1 && files[0].endsWith('.crdownload')) break;
        assert.ok(performance.now() < deadline, 'The native partial download was not observed.');
        await delay(10, undefined, { signal: t.signal });
      }
      assert.deepEqual(await completedDownloads(directory), []);
      pending = bridge.computer.download('held', {}, t.signal);
      void pending.catch(() => {});
      await Promise.race([
        entered,
        pending.then(() => assert.fail('Capture completed before its response.')),
      ]);
      assert.equal(
        await Promise.race([pending.then(() => 'complete'), delay(500).then(() => 'pending')]),
        'pending',
      );
      fixture.releaseHeldDownload();
      assert.deepEqual(await pending, {
        bytes: browserDownloadPdf,
        name: 'download.pdf',
        mimeType: 'application/pdf',
      });
      assert.equal(fixture.authenticatedDownloads(), 1);
      assert.equal(fixture.unauthenticatedDownloads(), 0);
    } finally {
      fixture.releaseHeldDownload();
      await pending?.catch(() => {});
      try {
        await bridge.close();
      } finally {
        try {
          await fixture.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  },
);

test(
  'native capture cleanup preserves a late unrelated file after the one-file check',
  {
    skip: !process.env.OTTO_TEST_BROWSER_EXECUTABLE,
    timeout: 30_000,
  },
  async (t) => {
    const root = await mkdtemp('/tmp/sk-download-late-');
    const fixture = await createBrowserDownloadFixture();
    const computer = createAgentBrowserComputer({
      dataRoot: root,
      browserExecutable: process.env.OTTO_TEST_BROWSER_EXECUTABLE,
      headless: true,
    });
    let pending: ReturnType<NonNullable<typeof computer.download>> | undefined;
    try {
      await computer.act('late', { action: 'open', url: `${fixture.origin}/session?late=true` });
      pending = computer.download!('late', { url: `${fixture.crossOrigin}/invoice.pdf` }, t.signal);
      void pending.catch(() => {});
      await Promise.race([
        fixture.cleanupWaiting(),
        pending.then(() => {
          throw new Error('The cleanup boundary was not reached.');
        }),
      ]);
      const directory = join(root, 'runtime', 'downloads', 'late');
      const files = await readdir(directory);
      assert.equal(files.filter((name) => name.startsWith('capture-')).length, 1);
      await writeFile(join(directory, 'unrelated.pdf'), browserDownloadPdf);
      fixture.releaseCleanup();
      assert.deepEqual((await pending).bytes, browserDownloadPdf);
      assert.deepEqual(await readdir(directory), ['unrelated.pdf']);
      assert.deepEqual(await readFile(join(directory, 'unrelated.pdf')), browserDownloadPdf);
    } finally {
      fixture.releaseCleanup();
      await pending?.catch(() => {});
      try {
        await computer.dispose();
      } finally {
        try {
          await fixture.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  },
);
