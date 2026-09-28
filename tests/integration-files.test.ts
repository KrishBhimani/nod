import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { Composio } from '@composio/core';
import { createIntegrationFileDownloader } from '../src/providers/composio/downloads.ts';
import { createComposioProvider } from '../src/providers/composio/integrations.ts';
import { requestPublicPreview } from '../src/providers/public-web/link-preview.ts';

const descriptor = (url = 'https://files.example.com/attachment?signature=private-fixture') => ({
  data: {
    successful: true,
    data: { file: { name: '../../invoice.pdf', mimetype: 'application/pdf', s3url: url } },
  },
  error: null,
});
const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

test('app downloads use only the completed provider file descriptor and return bounded private bytes', async () => {
  const calls: string[] = [];
  const download = createIntegrationFileDownloader({
    resolver: publicResolver,
    request: async ({ url, address, maxBytes, metadata, purpose }) => {
      calls.push(url.href);
      assert.equal(address, '93.184.216.34');
      assert.equal(maxBytes, 15 * 1024 * 1024);
      assert.equal(metadata, false);
      assert.equal(purpose, 'download');
      if (calls.length === 1)
        return {
          status: 302,
          headers: { location: '/final?signature=private-fixture' },
          body: new Uint8Array(),
        };
      return { status: 200, headers: {}, body: Buffer.from('synthetic-file') };
    },
  });
  const file = await download('GMAIL_GET_ATTACHMENT', descriptor(), AbortSignal.timeout(1000));
  assert.deepEqual(file, {
    name: 'invoice.pdf',
    mimeType: 'application/pdf',
    bytes: Buffer.from('synthetic-file'),
  });
  assert.equal(JSON.stringify(file).includes('signature'), false);
  assert.equal(calls.length, 2);
  const drive = createIntegrationFileDownloader({
    resolver: publicResolver,
    request: async () => ({ status: 200, headers: {}, body: Buffer.from('drive') }),
  });
  assert.equal(
    (
      await drive(
        'GOOGLEDRIVE_DOWNLOAD_FILE',
        {
          data: {
            downloaded_file_content: {
              name: 'report.csv',
              mimetype: 'text/csv',
              s3url: 'https://files.example.com/report',
            },
          },
        },
        AbortSignal.timeout(1000),
      )
    ).name,
    'report.csv',
  );
  for (const result of [
    { data: { successful: false, data: descriptor().data.data } },
    { data: { done: false, downloaded_file_content: descriptor().data.data.file } },
    { data: { uri: '/etc/passwd', display_url: 'https://files.example.com/arbitrary' } },
    {
      data: { file: { ...descriptor().data.data.file, mimetype: 'text/plain\r\nX-Fixture: bad' } },
    },
  ])
    await assert.rejects(drive('GMAIL_GET_ATTACHMENT', result, AbortSignal.timeout(1000)));
});

test('app downloads reject private redirects, rebinding, insecure URLs and oversized responses', async () => {
  for (const url of [
    'http://files.example.com/file',
    'https://127.0.0.1/file',
    'https://[::1]/file',
    'https://169.254.169.254/file',
    'https://name:secret@files.example.com/file',
  ]) {
    let requests = 0;
    const download = createIntegrationFileDownloader({
      resolver: publicResolver,
      request: async () => {
        requests++;
        throw new Error('Unexpected request');
      },
    });
    await assert.rejects(
      download('GMAIL_GET_ATTACHMENT', descriptor(url), AbortSignal.timeout(1000)),
    );
    assert.equal(requests, 0);
  }
  let resolutions = 0;
  let requests = 0;
  const rebound = createIntegrationFileDownloader({
    resolver: async () => [
      { address: ++resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 },
    ],
    request: async ({ address }) => {
      requests++;
      assert.equal(address, '93.184.216.34');
      return { status: 302, headers: { location: '/next' }, body: new Uint8Array() };
    },
  });
  await assert.rejects(rebound('GMAIL_GET_ATTACHMENT', descriptor(), AbortSignal.timeout(1000)));
  assert.equal(requests, 1);
  for (const size of [0, 15 * 1024 * 1024 + 1]) {
    const download = createIntegrationFileDownloader({
      resolver: publicResolver,
      request: async () => ({ status: 200, headers: {}, body: new Uint8Array(size) }),
    });
    await assert.rejects(download('GMAIL_GET_ATTACHMENT', descriptor(), AbortSignal.timeout(1000)));
  }
});

test('app file cancellation releases stalled resolution and response waits without continuing delivery', async () => {
  for (const stage of ['resolve', 'request']) {
    const controller = new AbortController();
    let requests = 0;
    const download = createIntegrationFileDownloader({
      resolver: stage === 'resolve' ? async () => new Promise(() => {}) : publicResolver,
      request: async () => {
        requests++;
        return new Promise(() => {});
      },
    });
    const pending = download('GMAIL_GET_ATTACHMENT', descriptor(), controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(requests, stage === 'resolve' ? 0 : 1);
  }
});

test('the real binary transfer negotiates file responses without changing preview headers', async () => {
  const requests: Array<{ accept?: string; agent?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ accept: request.headers.accept, agent: request.headers['user-agent'] });
    if (request.headers.accept !== '*/*') {
      response.writeHead(406);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/pdf' });
    response.end(Buffer.from('synthetic-pdf'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const input = {
    url: new URL(`http://files.example.com:${address.port}/file`),
    address: '127.0.0.1',
    signal: AbortSignal.timeout(1000),
    maxBytes: 1024,
    metadata: false,
  };
  try {
    assert.equal((await requestPublicPreview(input)).status, 406);
    const result = await requestPublicPreview({ ...input, purpose: 'download' });
    assert.equal(result.status, 200);
    assert.equal(Buffer.from(result.body).toString(), 'synthetic-pdf');
    assert.deepEqual(requests, [
      {
        accept: 'text/html,application/xhtml+xml,image/png,image/jpeg,image/webp',
        agent: 'Otto-LinkPreview/1.0',
      },
      { accept: '*/*', agent: 'Otto-FileDownload/1.0' },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('the real bounded transfer aborts streamed bodies exceeding the file limit', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.write(Buffer.alloc(32));
    response.end(Buffer.alloc(32));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await assert.rejects(
      requestPublicPreview({
        url: new URL(`http://files.example.com:${address.port}/file`),
        address: '127.0.0.1',
        signal: AbortSignal.timeout(1000),
        maxBytes: 40,
        metadata: false,
        purpose: 'download',
      }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Composio downloads bind the account, reject unreviewed arguments and hide upstream URLs and errors', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  const transport = client.getClient().toolRouter.session;
  t.mock.method(transport, 'create', async () => ({
    session_id: 'fixture-files',
    mcp: { type: 'http', url: 'https://backend.composio.dev/tool_router/mcp/fixture-files' },
    config: { user_id: 'fixture-owner' },
    config_version: 1,
  }));
  let executions = 0;
  let fail = false;
  t.mock.method(
    transport,
    'execute',
    async (sessionId: string, input: unknown, options: { signal: AbortSignal }) => {
      executions++;
      assert.equal(sessionId, 'fixture-files');
      assert.deepEqual(input, {
        tool_slug: 'GMAIL_GET_ATTACHMENT',
        arguments: { message_id: 'message-1', attachment_id: 'part-1', file_name: 'invoice.pdf' },
        account: 'owned-account',
      });
      assert.equal(options.signal.aborted, false);
      if (fail) throw new Error('private upstream URL and credential');
      return descriptor();
    },
  );
  const provider = createComposioProvider({
    client,
    fileDownload: {
      resolver: publicResolver,
      request: async () => ({ status: 200, headers: {}, body: Buffer.from('fixture') }),
    },
  });
  const session = await provider.createSession('fixture-owner', { gmail: 'owned-account' });
  const args = { message_id: 'message-1', attachment_id: 'part-1', file_name: 'invoice.pdf' };
  assert.equal(
    (await session.download!('GMAIL_GET_ATTACHMENT', args, 'owned-account')).name,
    'invoice.pdf',
  );
  for (const [action, input] of [
    ['GMAIL_SEND_EMAIL', args],
    ['GMAIL_GET_ATTACHMENT', { ...args, url: 'https://example.com/file' }],
  ] as const)
    await assert.rejects(session.download!(action, input, 'owned-account'), {
      message: 'The app file could not be downloaded.',
    });
  assert.equal(executions, 1);
  fail = true;
  await assert.rejects(session.download!('GMAIL_GET_ATTACHMENT', args, 'owned-account'), {
    message: 'The app file could not be downloaded.',
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    session.download!('GMAIL_GET_ATTACHMENT', args, 'owned-account', controller.signal),
    { name: 'AbortError' },
  );
  assert.equal(executions, 2);
});
