import { open } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { PrivacyNoticeResponse } from '../shared/privacy.ts';

export function parsePrivacyNotice(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('Configure a valid public privacy notice.');
  const content = value.trim();
  if (content.length > 32_000) throw new Error('Configure a valid public privacy notice.');
  return content || undefined;
}

export async function loadPrivacyNoticeFile(path?: string): Promise<string | undefined> {
  if (path === undefined) return undefined;
  try {
    if (typeof path !== 'string') throw new Error();
    if (!path.trim()) return undefined;
    const file = await open(path, 'r');
    try {
      if (!(await file.stat()).isFile()) throw new Error();
      const buffer = Buffer.alloc(131_073);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 131_072) throw new Error();
      const content = parsePrivacyNotice(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)),
      );
      if (!content) throw new Error();
      return content;
    } finally {
      await file.close();
    }
  } catch {
    throw new Error('Configure a valid public privacy notice.');
  }
}

export function registerPrivacyNotice(app: FastifyInstance, notice?: string) {
  const content = parsePrivacyNotice(notice) ?? null;
  app.get('/api/privacy', async (_request, reply): Promise<PrivacyNoticeResponse> => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    return { content };
  });
}
