import { z } from 'zod';
import type { IntegrationFile } from '../../ports/integrations.ts';
import { publicUrl, type AddressResolver } from '../agent-browser/network.ts';
import { requestPublicPreview, type PreviewRequest } from '../public-web/link-preview.ts';

const maximumBytes = 15 * 1024 * 1024;
const mime = z
  .string()
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/);
const id = z
  .string()
  .min(1)
  .max(4000)
  .regex(/^[A-Za-z0-9_.-]+$/);
const schemas = {
  GMAIL_GET_ATTACHMENT: z
    .object({
      message_id: id,
      attachment_id: id,
      file_name: z.string().min(1).max(255),
      user_id: z.string().min(1).max(320).optional(),
    })
    .strict(),
  GOOGLEDRIVE_DOWNLOAD_FILE: z.object({ fileId: id, mime_type: mime.optional() }).strict(),
  GOOGLEDRIVE_DOWNLOAD_FILE_OPERATION: z
    .object({
      file_id: id,
      mime_type: mime.optional(),
      revision_id: id.optional(),
    })
    .strict(),
};

export function downloadArguments(action: string, args: Record<string, unknown>) {
  const schema = schemas[action as keyof typeof schemas];
  if (!schema) throw new Error('This file action is unavailable.');
  return schema.parse(args);
}

function fileDescriptor(action: string, value: unknown) {
  let current = value;
  const field = action === 'GMAIL_GET_ATTACHMENT' ? 'file' : 'downloaded_file_content';
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current === 'string' && current.length <= 65536) current = JSON.parse(current);
    const object = z.record(z.string(), z.unknown()).parse(current);
    if (object.error != null || object.successful === false || object.done === false)
      throw new Error('The file is not ready.');
    if (object[field]) {
      const file = z
        .object({
          name: z.string().min(1).max(1000),
          mimetype: mime,
          s3url: z.string().url().max(16384),
        })
        .parse(object[field]);
      const name = file.name
        .split(/[\\/]/)
        .at(-1)!
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .slice(0, 160)
        .trim();
      if (!name || name === '.' || name === '..') throw new Error('The file name is invalid.');
      return { name, mimeType: file.mimetype, url: file.s3url };
    }
    current = object.data;
  }
  throw new Error('The file is unavailable.');
}

async function interrupted<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        abort = () => reject(new DOMException('File download was cancelled.', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export function createIntegrationFileDownloader(
  options: {
    resolver?: AddressResolver;
    request?: PreviewRequest;
  } = {},
) {
  const request = options.request ?? requestPublicPreview;
  return async (action: string, result: unknown, signal: AbortSignal): Promise<IntegrationFile> => {
    const file = fileDescriptor(action, result);
    let current = file.url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      if (new URL(current).protocol !== 'https:') throw new Error('The file address is invalid.');
      const resolved = await interrupted(() => publicUrl(current, options.resolver), signal);
      signal.throwIfAborted();
      const response = await interrupted(
        () =>
          request({
            ...resolved,
            signal,
            maxBytes: maximumBytes,
            metadata: false,
            purpose: 'download',
          }),
        signal,
      );
      signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.headers.location) throw new Error('The file redirect is invalid.');
        current = new URL(response.headers.location, resolved.url).href;
        continue;
      }
      if (
        response.status !== 200 ||
        !response.body.byteLength ||
        response.body.byteLength > maximumBytes
      )
        throw new Error('The file response is unavailable.');
      return { name: file.name, mimeType: file.mimeType, bytes: response.body };
    }
    throw new Error('Too many file redirects.');
  };
}
