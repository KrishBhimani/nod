import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, request } from 'node:http';
import { connect, createServer, Socket, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createFixtureProxy } from '../scripts/e2e-fixtures.ts';
import { createBrowserProxy } from '../src/providers/agent-browser/network.ts';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function closed(socket: Socket, timeout = 1000) {
  if (socket.destroyed) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const complete = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      socket.removeListener('close', complete);
      resolve(false);
    }, timeout);
    socket.once('close', complete);
  });
}

async function target(context: TestContext, handler: (socket: Socket) => void = () => {}) {
  const sockets = new Set<Socket>();
  let accepted: (socket: Socket) => void;
  const connected = new Promise<Socket>((resolve) => {
    accepted = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('data', () => {});
    accepted(socket);
    handler(socket);
  });
  const port = await listen(server);
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port, connected };
}

async function proxy(context: TestContext) {
  const proxy = createBrowserProxy();
  const endpoint = await proxy.url();
  context.after(() => proxy.dispose());
  return { proxy, endpoint };
}

async function tunnel(context: TestContext, endpoint: string, port: number) {
  return new Promise<{ socket: Socket; head: Buffer }>((resolve, reject) => {
    const outgoing = request(new URL(endpoint), {
      method: 'CONNECT',
      path: `127.0.0.1:${port}`,
      headers: { host: `127.0.0.1:${port}` },
    });
    outgoing.once('error', reject);
    outgoing.once('connect', (response, socket, head) => {
      assert.equal(response.statusCode, 200);
      socket.on('error', () => {});
      context.after(() => socket.destroy());
      resolve({ socket, head });
    });
    context.after(() => outgoing.destroy());
    outgoing.end();
  });
}

async function fixture(context: TestContext, upstream: string) {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-proxy-lifecycle-'));
  const fixture = await createFixtureProxy(directory);
  fixture.nativeArgs([`--proxy-server=${upstream}`, 'about:blank']);
  context.after(async () => {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  return fixture;
}

function fastIdleTimeout(context: TestContext) {
  const original = Socket.prototype.setTimeout;
  let fired = false;
  context.mock.method(
    Socket.prototype,
    'setTimeout',
    function (this: Socket, milliseconds: number, listener?: () => void) {
      if (milliseconds !== 60_000) return original.call(this, milliseconds, listener);
      return original.call(this, 30, () => {
        fired = true;
        listener?.call(this);
      });
    },
  );
  return () => fired;
}

test(
  'idle CONNECT timeout closes the browser tunnel as well as its upstream',
  { timeout: 5000 },
  async (context) => {
    const timedOut = fastIdleTimeout(context);
    const upstream = await target(context);
    const { endpoint } = await proxy(context);
    const { socket } = await tunnel(context, endpoint, upstream.port);
    const remote = await upstream.connected;
    socket.resume();
    assert.equal(await closed(socket), true);
    assert.equal(timedOut(), true);
    assert.equal(await closed(remote), true);
  },
);

test(
  'closing the browser tunnel closes the connected upstream',
  { timeout: 5000 },
  async (context) => {
    const upstream = await target(context);
    const { endpoint } = await proxy(context);
    const { socket } = await tunnel(context, endpoint, upstream.port);
    const remote = await upstream.connected;
    socket.destroy();
    assert.equal(await closed(remote), true);
  },
);

test(
  'graceful upstream completion flushes a large CONNECT response to a slow browser',
  { timeout: 5000 },
  async (context) => {
    const payload = Buffer.alloc(4 * 1024 * 1024, 90);
    const upstream = await target(context, (socket) => socket.end(payload));
    const { endpoint } = await proxy(context);
    const { socket, head } = await tunnel(context, endpoint, upstream.port);
    socket.pause();
    const received = new Promise<Buffer>((resolve, reject) => {
      const chunks = [head];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('error', reject);
      socket.once('end', () => resolve(Buffer.concat(chunks)));
    });
    setTimeout(() => socket.resume(), 40);
    assert.deepEqual(await received, payload);
    assert.equal(await closed(socket), true);
  },
);

test(
  'idle CONNECT timeout also closes a tunnel through the fixture proxy',
  { timeout: 5000 },
  async (context) => {
    const timedOut = fastIdleTimeout(context);
    const upstream = await target(context);
    const { endpoint } = await proxy(context);
    const chain = await fixture(context, endpoint);
    const { socket } = await tunnel(context, chain.proxyUrl, upstream.port);
    socket.resume();
    assert.equal(await closed(socket), true);
    assert.equal(timedOut(), true);
    assert.equal(await closed(await upstream.connected), true);
  },
);

test('fixture shutdown closes established upstream tunnels', { timeout: 5000 }, async (context) => {
  const upstream = await target(context);
  const { endpoint } = await proxy(context);
  const chain = await fixture(context, endpoint);
  const { socket } = await tunnel(context, chain.proxyUrl, upstream.port);
  const remote = await upstream.connected;
  socket.resume();
  await chain.close();
  assert.equal(await closed(socket), true);
  assert.equal(await closed(remote), true);
});

test(
  'fixture shutdown cancels an upstream CONNECT that has not replied',
  { timeout: 5000 },
  async (context) => {
    const peers = new Set<Socket>();
    let accepted: (socket: Socket) => void;
    const connected = new Promise<Socket>((resolve) => {
      accepted = resolve;
    });
    const server = createHttpServer();
    server.on('connect', (request, socket) => {
      peers.add(socket as Socket);
      socket.on('error', () => {});
      socket.on('end', () => socket.end());
      socket.resume();
      accepted(socket as Socket);
    });
    const port = await listen(server);
    context.after(async () => {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const chain = await fixture(context, `http://127.0.0.1:${port}`);
    const endpoint = new URL(chain.proxyUrl);
    const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) });
    socket.on('error', () => {});
    context.after(() => socket.destroy());
    socket.once('connect', () =>
      socket.write(
        'CONNECT synthetic.example.test:443 HTTP/1.1\r\nHost: synthetic.example.test:443\r\n\r\n',
      ),
    );
    const remote = await connected;
    await chain.close();
    socket.resume();
    assert.equal(await closed(socket), true);
    assert.equal(await closed(remote), true);
  },
);
