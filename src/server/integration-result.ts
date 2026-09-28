export const integrationResultBytes = 18_000;

export function integrationResultSnapshot(value: unknown) {
  const text = JSON.stringify(value ?? null);
  const originalBytes = Buffer.byteLength(text);
  if (originalBytes <= integrationResultBytes) return JSON.parse(text);
  return {
    truncated: true,
    resultOmitted: true,
    originalBytes,
    message:
      'The app response was too large and has been omitted. This is incomplete evidence, not a not-found result. Do not repeat a completed action. If the current request permits it, use a narrower read-only query with fewer results or fields; otherwise explain that the result could not be inspected.',
  };
}
