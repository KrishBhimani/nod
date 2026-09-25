export function ownedArtifactUrl(url: string) {
  return /^\/api\/artifacts\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
    url,
  );
}

export function localPreviewUrl(url: string) {
  return url.startsWith('blob:');
}
