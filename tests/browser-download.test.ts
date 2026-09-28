import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { browserDownloadBytes } from '../src/ports/computer.ts';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import {
  completedDownloads,
  createDownloadCapture,
  decodeDownload,
  downloadFile,
  readDownload,
} from '../src/providers/agent-browser/downloads.ts';
import {
  createContainerBrowserComputer,
  type BrowserBridgeLauncher,
} from '../src/providers/container-browser/index.ts';
import { startContainerBrowserWorker } from '../src/providers/container-browser/worker.ts';
import { runBrowserBridge } from '../src/providers/container-browser/bridge.ts';
import { browserDownloadPdf, createBrowserDownloadFixture } from './browser-download-fixture.ts';

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
    skip: !process.env.SIDEKICK_TEST_BROWSER_EXECUTABLE,
    timeout: 180_000,
  },
  async (t) => {
    const root = await mkdtemp('/tmp/sk-download-bridge-');
    const socketPath = join(root, 'control.sock');
    let browserRoot = '';
    const fixture = await createBrowserDownloadFixture();
    const worker = await startContainerBrowserWorker({
      socketPath,
      dataRoot: root,
      createComputer: (dataRoot) => {
        browserRoot = dataRoot;
        return createAgentBrowserComputer({
          dataRoot,
          browserExecutable: process.env.SIDEKICK_TEST_BROWSER_EXECUTABLE,
          headless: true,
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
    const computer = createContainerBrowserComputer({
      dataRoot: join(root, 'owner'),
      spawn: launch,
    });
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
      const downloads = join(browserRoot, 'runtime', 'downloads', 'large');
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
      const slowDirectory = join(browserRoot, 'runtime', 'downloads', 'slow');
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
        await computer.dispose();
      } finally {
        try {
          await worker.close();
        } finally {
          try {
            await fixture.close();
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        }
      }
    }
  },
);
