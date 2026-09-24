import { lookup } from 'node:dns/promises';
import { createServer, request, type OutgoingHttpHeaders } from 'node:http';
import { connect, isIP } from 'node:net';

export type AddressResolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) return /^[23][0-9a-f]{0,3}:/i.test(address) && !/^2002:/i.test(address) && !/^2001:(?:0{1,4}:|db8:|2:|10:|20:)/i.test(address);
  return false;
}

export async function publicUrl(value: string, resolver: AddressResolver = host => lookup(host, { all: true, verbatim: true })): Promise<{ url: URL; address: string }> {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('A valid public HTTP or HTTPS URL is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) throw new Error('Only public HTTP and HTTPS destinations on ports 80 or 443 are permitted.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || /\.(localhost|local|internal)$/i.test(host)) throw new Error('Private network destinations are blocked.');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolver(host);
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Private network destinations are blocked.');
  return { url, address: addresses[0].address };
}

let proxyPromise: Promise<string> | undefined;

export function browserProxy(): Promise<string> {
  proxyPromise ??= new Promise((resolve, reject) => {
    const server = createServer(async (incoming, outgoing) => {
      try {
        const { url, address } = await publicUrl(incoming.url ?? '');
        if (url.protocol !== 'http:') throw new Error('Invalid proxy request.');
        const headers: OutgoingHttpHeaders = { ...incoming.headers, host: url.host };
        delete headers['proxy-authorization'];
        delete headers['proxy-connection'];
        const upstream = request({ host: address, port: url.port || 80, method: incoming.method, path: url.pathname + url.search, headers, timeout: 30_000 }, response => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        });
        upstream.on('timeout', () => upstream.destroy());
        upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
        incoming.pipe(upstream);
      } catch { outgoing.writeHead(403); outgoing.end('Destination blocked.'); }
    });
    server.on('connect', async (incoming, socket, head) => {
      try {
        const { url, address } = await publicUrl(`https://${incoming.url}`);
        const upstream = connect({ host: address, port: Number(url.port || 443) });
        upstream.setTimeout(60_000, () => upstream.destroy());
        upstream.on('connect', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
        socket.on('close', () => upstream.destroy());
      } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
    });
    server.on('upgrade', (_request, socket) => socket.destroy());
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Browser proxy could not start.'));
      server.unref();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return proxyPromise;
}
