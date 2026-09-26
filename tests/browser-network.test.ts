import assert from 'node:assert/strict';
import { createServer as createHttpServer, request } from 'node:http';
import { connect, createServer as createTcpServer, type AddressInfo } from 'node:net';
import test from 'node:test';
import {
  browserUrl,
  createBrowserProxy,
  publicUrl,
} from '../src/providers/agent-browser/network.ts';

test('browser URLs allow private addresses, ordinary DNS and nonstandard ports without changing public-fetch rules', async () => {
  for (const url of [
    'http://127.0.0.1:4310/private',
    'http://localhost:8080/',
    'https://10.0.0.7:9443/',
    'http://192.168.1.2:8000/',
    'http://169.254.169.254/',
    'http://[::1]:3000/',
    'https://service.internal:8443/',
    'https://host.docker.internal:9443/',
  ]) {
    assert.equal(browserUrl(url).href, new URL(url).href);
    await assert.rejects(publicUrl(url));
  }
  for (const url of [
    'file:///tmp/private',
    'javascript:alert(1)',
    'data:text/plain,hello',
    'https://name:secret@localhost',
    'invalid',
    'http://localhost:99999',
  ])
    assert.throws(() => browserUrl(url));
});

async function response(proxy: string, destination: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(proxy);
    const outgoing = request(
      {
        host: url.hostname,
        port: url.port,
        path: destination,
        headers: { 'proxy-authorization': 'Synthetic proxy value' },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () =>
          resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.setTimeout(2000, () =>
      outgoing.destroy(new Error('Synthetic proxy request timed out.')),
    );
    outgoing.end();
  });
}

function stream(proxy: string, headers: string, payload: string) {
  return new Promise<string>((resolve, reject) => {
    const url = new URL(proxy);
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    let output = '';
    socket.setTimeout(2000, () => socket.destroy(new Error('Synthetic tunnel timed out.')));
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes(payload)) {
        socket.destroy();
        resolve(output);
      }
    });
    socket.on('connect', () => socket.write(headers + '\r\n\r\n' + payload));
  });
}

test('browser HTTP proxy reaches a private DNS target on its actual port and strips proxy credentials', async () => {
  const received: string[] = [];
  const target = createHttpServer((incoming, outgoing) => {
    received.push(incoming.url ?? '');
    assert.equal(incoming.headers['proxy-authorization'], undefined);
    outgoing.end('Synthetic local response');
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const proxy = createBrowserProxy();
  try {
    const endpoint = await proxy.url();
    const port = (target.address() as AddressInfo).port;
    assert.deepEqual(await response(endpoint, `http://localhost:${port}/local?q=synthetic`), {
      status: 200,
      body: 'Synthetic local response',
    });
    assert.deepEqual(received, ['/local?q=synthetic']);
    assert.equal((await response(endpoint, 'file:///tmp/private')).status, 400);
  } finally {
    await proxy.dispose();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test('browser CONNECT tunnel reaches a private endpoint and preserves initial bytes', async () => {
  const target = createTcpServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const proxy = createBrowserProxy();
  try {
    const endpoint = await proxy.url();
    const destination = `127.0.0.1:${(target.address() as AddressInfo).port}`;
    const result = await stream(
      endpoint,
      `CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}`,
      'Synthetic tunnel bytes',
    );
    assert.match(result, /^HTTP\/1.1 200 Connection Established/);
    assert.ok(result.endsWith('Synthetic tunnel bytes'));
  } finally {
    await proxy.dispose();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test('browser HTTP upgrades are forwarded through the same proxy', async () => {
  const target = createHttpServer();
  target.on('upgrade', (incoming, socket, head) => {
    assert.equal(incoming.url, '/socket');
    assert.equal(incoming.headers['proxy-authorization'], undefined);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const proxy = createBrowserProxy();
  try {
    const endpoint = await proxy.url();
    const destination = `localhost:${(target.address() as AddressInfo).port}`;
    const result = await stream(
      endpoint,
      `GET http://${destination}/socket HTTP/1.1\r\nHost: ${destination}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nProxy-Authorization: Synthetic proxy value`,
      'Synthetic upgraded bytes',
    );
    assert.match(result, /^HTTP\/1.1 101 Switching Protocols/);
    assert.ok(result.endsWith('Synthetic upgraded bytes'));
  } finally {
    await proxy.dispose();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});
