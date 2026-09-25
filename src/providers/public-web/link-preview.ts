import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { parse } from 'parse5';
import type {
  LinkPreviewProvider,
  PublicLinkMetadata,
  PreviewImage,
} from '../../ports/link-preview.ts';
import { previewableUrl } from '../../shared/link-preview.ts';
import { publicUrl, type AddressResolver } from '../agent-browser/network.ts';

interface PublicResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}
export type PreviewRequest = (input: {
  url: URL;
  address: string;
  signal: AbortSignal;
  maxBytes: number;
  metadata: boolean;
  purpose?: 'preview' | 'download';
}) => Promise<PublicResponse>;

export const requestPublicPreview: PreviewRequest = ({
  url,
  address,
  signal,
  maxBytes,
  metadata,
  purpose = 'preview',
}) =>
  new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = transport(
      url,
      {
        agent: false,
        signal,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address, family: isIP(address) }]);
          else callback(null, address, isIP(address));
        },
        headers: {
          'User-Agent':
            purpose === 'download' ? 'Sidekick-FileDownload/1.0' : 'Sidekick-LinkPreview/1.0',
          Accept:
            purpose === 'download'
              ? '*/*'
              : 'text/html,application/xhtml+xml,image/png,image/jpeg,image/webp,image/gif',
          'Accept-Encoding': 'identity',
        },
        maxHeaderSize: 16384,
      },
      (response) => {
        const headers = Object.fromEntries(
          ['content-type', 'content-length', 'content-encoding', 'location'].map((key) => [
            key,
            typeof response.headers[key] === 'string' ? response.headers[key] : undefined,
          ]),
        );
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          resolve({ status, headers, body: new Uint8Array() });
          return;
        }
        if (
          (headers['content-encoding'] && headers['content-encoding'] !== 'identity') ||
          (!metadata && Number(headers['content-length']) > maxBytes)
        ) {
          response.destroy();
          reject(new Error('Preview response is not supported.'));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          const remaining = maxBytes - length;
          length += chunk.length;
          if (length > maxBytes && !metadata) {
            response.destroy(new Error('Preview response is too large.'));
            return;
          }
          chunks.push(chunk.subarray(0, remaining));
          if (
            metadata &&
            (length >= maxBytes || Buffer.concat(chunks).includes(Buffer.from('</head>')))
          ) {
            response.destroy();
            resolve({ status, headers, body: Buffer.concat(chunks) });
          }
        });
        response.on('error', reject);
        response.on('end', () => resolve({ status, headers, body: Buffer.concat(chunks) }));
      },
    );
    request.on('error', reject);
    request.end();
  });

function clean(value: string | undefined, max: number) {
  return (
    value
      ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max) || undefined
  );
}

export function parseLinkMetadata(html: string, url: string): PublicLinkMetadata | null {
  const document = parse(html);
  const head = document.childNodes.find((node) => node.nodeName === 'html');
  const elements = head && 'childNodes' in head ? head.childNodes : [];
  const container = elements.find((node) => node.nodeName === 'head');
  const nodes = container && 'childNodes' in container ? container.childNodes : [];
  const meta = new Map<string, string>();
  let title = '';
  for (const node of nodes) {
    if (node.nodeName === 'meta' && 'attrs' in node) {
      const attrs = new Map(node.attrs.map((attr) => [attr.name.toLowerCase(), attr.value]));
      const key = (attrs.get('property') ?? attrs.get('name'))?.toLowerCase();
      if (key && attrs.has('content') && !meta.has(key)) meta.set(key, attrs.get('content')!);
    }
    if (node.nodeName === 'title' && 'childNodes' in node)
      title = node.childNodes.map((child) => ('value' in child ? child.value : '')).join('');
  }
  const resultTitle = clean(meta.get('og:title') ?? meta.get('twitter:title') ?? title, 200);
  if (!resultTitle) return null;
  const image =
    meta.get('og:image:secure_url') ?? meta.get('og:image') ?? meta.get('twitter:image');
  let imageUrl: string | null = null;
  try {
    if (image) imageUrl = previewableUrl(new URL(image, url).href);
  } catch {}
  return {
    url,
    title: resultTitle,
    description: clean(
      meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'),
      400,
    ),
    siteName: clean(meta.get('og:site_name'), 100),
    ...(imageUrl ? { image: imageUrl } : {}),
  };
}

function imageType(bytes: Uint8Array): PreviewImage['mimeType'] | null {
  const value = Buffer.from(bytes);
  const dimensions = (width: number, height: number) =>
    width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 16000000;
  if (
    value.length >= 24 &&
    value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return dimensions(value.readUInt32BE(16), value.readUInt32BE(20)) ? 'image/png' : null;
  if (value.length >= 4 && value[0] === 255 && value[1] === 216 && value[2] === 255) {
    let offset = 2;
    while (offset + 4 <= value.length) {
      if (value[offset++] !== 255) return null;
      while (value[offset] === 255) offset++;
      const marker = value[offset++];
      if (marker === 218 || marker === 217 || offset + 2 > value.length) return null;
      const length = value.readUInt16BE(offset);
      if (length < 2 || offset + length > value.length) return null;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker))
        return length >= 7 &&
          dimensions(value.readUInt16BE(offset + 5), value.readUInt16BE(offset + 3))
          ? 'image/jpeg'
          : null;
      offset += length;
    }
    return null;
  }
  if (
    value.length >= 30 &&
    value.toString('ascii', 0, 4) === 'RIFF' &&
    value.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const kind = value.toString('ascii', 12, 16);
    if (kind === 'VP8X' && !(value[20] & 2))
      return dimensions(value.readUIntLE(24, 3) + 1, value.readUIntLE(27, 3) + 1)
        ? 'image/webp'
        : null;
    if (kind === 'VP8 ')
      return dimensions(value.readUInt16LE(26) & 16383, value.readUInt16LE(28) & 16383)
        ? 'image/webp'
        : null;
    if (kind === 'VP8L' && value[20] === 47)
      return dimensions(
        ((value[21] | (value[22] << 8)) & 16383) + 1,
        (((value[22] >> 6) | (value[23] << 2) | (value[24] << 10)) & 16383) + 1,
      )
        ? 'image/webp'
        : null;
  }
  return null;
}

export function createPublicLinkPreviewProvider(
  options: { resolver?: AddressResolver; request?: PreviewRequest; timeoutMs?: number } = {},
): LinkPreviewProvider {
  const request = options.request ?? requestPublicPreview;
  async function fetchPublic(value: string, maxBytes: number) {
    const signal = AbortSignal.timeout(Math.min(5000, options.timeoutMs ?? 5000));
    let current = value;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const safe = previewableUrl(current);
      if (!safe) throw new Error('Preview destination is not supported.');
      const resolved = await Promise.race([
        publicUrl(safe, options.resolver),
        new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('Preview timed out.')), {
            once: true,
          }),
        ),
      ]);
      signal.throwIfAborted();
      const result = await request({
        ...resolved,
        signal,
        maxBytes,
        metadata: maxBytes < 1024 * 1024,
      });
      signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        if (!result.headers.location) throw new Error('Preview redirect is not supported.');
        current = new URL(result.headers.location, resolved.url).href;
        continue;
      }
      if (
        result.status !== 200 ||
        result.body.byteLength > maxBytes ||
        (result.headers['content-encoding'] && result.headers['content-encoding'] !== 'identity')
      )
        throw new Error('Preview response is not supported.');
      return { ...result, url: resolved.url.href };
    }
    throw new Error('Too many preview redirects.');
  }
  return {
    async metadata(url) {
      try {
        const result = await fetchPublic(url, 256 * 1024);
        if (
          !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
            result.headers['content-type'] ?? '',
          )
        )
          return null;
        return parseLinkMetadata(Buffer.from(result.body).toString('utf8'), result.url);
      } catch {
        return null;
      }
    },
    async image(url) {
      try {
        const result = await fetchPublic(url, 1024 * 1024);
        const mimeType = imageType(result.body);
        if (
          !mimeType ||
          result.headers['content-type']?.split(';')[0].trim().toLowerCase() !== mimeType
        )
          return null;
        return { bytes: result.body, mimeType };
      } catch {
        return null;
      }
    },
  };
}
