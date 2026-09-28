import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { browserDownloadBytes } from '../src/ports/computer.ts';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import {
  completedDownloads,
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
    timeout: 120_000,
  },
  async () => {
    const root = await mkdtemp('/tmp/sk-download-bridge-');
    const socketPath = join(root, 'control.sock');
    const fixture = await createBrowserDownloadFixture();
    const worker = await startContainerBrowserWorker({
      socketPath,
      dataRoot: root,
      createComputer: (dataRoot) =>
        createAgentBrowserComputer({
          dataRoot,
          browserExecutable: process.env.SIDEKICK_TEST_BROWSER_EXECUTABLE,
          headless: true,
        }),
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
    } finally {
      await computer.dispose();
      await worker.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
