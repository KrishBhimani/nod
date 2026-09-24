import { z } from 'zod';

export async function synthesizeSpeech(input: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw Object.assign(new Error('OpenAI speech is not configured.'), { statusCode: 503 });
  const text = z.string().trim().min(1).max(3000).parse(input);
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.TTS_MODEL || 'gpt-4o-mini-tts', input: text, voice: 'coral', response_format: 'mp3' }),
  });
  if (!response.ok || !response.body) throw new Error('Speech generation failed.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 15 * 1024 * 1024) throw new Error('Generated audio is too large.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  signal?.throwIfAborted();
  if (!size) throw new Error('Speech generation returned no audio.');
  return Buffer.concat(chunks, size);
}
