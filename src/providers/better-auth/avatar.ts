import type { AuthenticationAvatar } from '../../ports/authentication.ts';
import { rasterImageType } from '../raster-image.ts';

export function googleAvatarUrl(value: string | null | undefined) {
  try {
    if (!value) return null;
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com'))
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export async function loadGoogleAvatar(
  value: string | null,
  request: typeof fetch = fetch,
): Promise<AuthenticationAvatar | null> {
  const maxBytes = 2 * 1024 * 1024;
  const signal = AbortSignal.timeout(5000);
  let current = googleAvatarUrl(value);
  try {
    for (let redirects = 0; redirects <= 3 && current; redirects++) {
      const response = await request(current, {
        redirect: 'manual',
        signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        headers: { Accept: 'image/png,image/jpeg,image/webp' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        current = location ? googleAvatarUrl(new URL(location, current).href) : null;
        continue;
      }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      const length = response.headers.get('content-length');
      if (
        response.status !== 200 ||
        !response.body ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(type ?? '') ||
        (length !== null &&
          (!Number.isSafeInteger(Number(length)) ||
            Number(length) < 0 ||
            Number(length) > maxBytes))
      ) {
        await response.body?.cancel();
        return null;
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxBytes) return null;
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      signal.throwIfAborted();
      const bytes = Buffer.concat(chunks, size);
      const mimeType = rasterImageType(bytes);
      return mimeType === type ? { bytes, mimeType } : null;
    }
  } catch {}
  return null;
}
