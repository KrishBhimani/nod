import {
  previewableUrl,
  type LinkPreview,
  type LinkPreviewResponse,
} from '../../shared/link-preview';
import { post } from './api';

const previews = new Map<string, { expiresAt: number; value: Promise<LinkPreview | null> }>();

export function previewImageUrl(value?: string) {
  return value &&
    /^\/api\/link-preview\/image\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : undefined;
}

export function loadLinkPreview(value: string): Promise<LinkPreview | null> {
  const url = previewableUrl(value);
  if (!url) return Promise.resolve(null);
  const existing = previews.get(url);
  if (existing && existing.expiresAt > Date.now()) return existing.value;
  const request = post<LinkPreviewResponse>('/api/link-preview', { url })
    .then(({ preview }) => {
      if (!preview || typeof preview.title !== 'string' || !preview.title.trim()) return null;
      const destination = previewableUrl(preview.url);
      if (!destination) return null;
      return {
        url: destination,
        title: preview.title,
        ...(typeof preview.description === 'string' ? { description: preview.description } : {}),
        ...(typeof preview.siteName === 'string' ? { siteName: preview.siteName } : {}),
        imageUrl: previewImageUrl(preview.imageUrl),
      };
    })
    .catch(() => null);
  previews.delete(url);
  previews.set(url, { expiresAt: Date.now() + 5 * 60_000, value: request });
  while (previews.size > 64) previews.delete(previews.keys().next().value!);
  return request;
}
