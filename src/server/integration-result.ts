export const appResultInlineChars = 40_000;

export async function inlineAppResult(result: unknown, save: (text: string) => Promise<string>) {
  const text = JSON.stringify(result ?? null);
  if (text.length <= appResultInlineChars) return result;
  return {
    workspaceFile: await save(text),
    bytes: Buffer.byteLength(text),
    preview: text.slice(0, 2000),
    message:
      'The full app result is saved in this workspace file. Inspect it with read or bash, for example jq, instead of repeating the request.',
  };
}
