export async function readRequestBody(request: Request, maximum: number) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await request.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return new Uint8Array(Buffer.concat(chunks, size));
      size += result.value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(result.value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return undefined;
  } finally {
    reader.releaseLock();
  }
}
