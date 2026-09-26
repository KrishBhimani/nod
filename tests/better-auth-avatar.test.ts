import assert from 'node:assert/strict';
import test from 'node:test';
import { googleAvatarUrl, loadGoogleAvatar } from '../src/providers/better-auth/avatar.ts';

const source = 'https://lh3.googleusercontent.com/synthetic-avatar';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZgYQAAAAASUVORK5CYII=',
  'base64',
);

test('Google avatar destinations require HTTPS on the exact Googleusercontent host boundary', () => {
  assert.equal(googleAvatarUrl(source), source);
  for (const value of [
    null,
    undefined,
    'http://lh3.googleusercontent.com/image',
    'https://googleusercontent.com.attacker.test/image',
    'https://attacker.test/image',
    'https://127.0.0.1/image',
    'https://user:secret@lh3.googleusercontent.com/image',
    'https://lh3.googleusercontent.com:8443/image',
  ]) {
    assert.equal(googleAvatarUrl(value), null);
  }
});

test('avatar reads follow only checked redirects and forward no cookies or authentication headers', async () => {
  const urls: string[] = [];
  const image = await loadGoogleAvatar(source, async (url, options) => {
    urls.push(String(url));
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.redirect, 'manual');
    assert.equal(options?.referrerPolicy, 'no-referrer');
    assert.ok(options?.signal instanceof AbortSignal);
    assert.deepEqual([...new Headers(options.headers).keys()], ['accept']);
    return urls.length === 1
      ? new Response(null, {
          status: 302,
          headers: { location: 'https://lh4.googleusercontent.com/synthetic-next' },
        })
      : new Response(png, { headers: { 'content-type': 'image/png' } });
  });
  assert.equal(urls.length, 2);
  assert.equal(image?.mimeType, 'image/png');
  assert.deepEqual(image?.bytes, png);
  for (const location of [
    'https://attacker.test/image',
    'http://lh3.googleusercontent.com/image',
    'https://127.0.0.1/image',
  ]) {
    let calls = 0;
    assert.equal(
      await loadGoogleAvatar(source, async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location } });
      }),
      null,
    );
    assert.equal(calls, 1);
  }
});

test('avatar reads reject SVG, wrong image types, oversized bodies and redirect loops', async () => {
  for (const [bytes, type] of [
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png'],
    [png, 'image/svg+xml'],
    [png, 'image/jpeg'],
  ] as const) {
    assert.equal(
      await loadGoogleAvatar(
        source,
        async () => new Response(bytes, { headers: { 'content-type': type } }),
      ),
      null,
    );
  }
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.equal(
    await loadGoogleAvatar(
      source,
      async () => new Response(body, { headers: { 'content-type': 'image/png' } }),
    ),
    null,
  );
  assert.equal(cancelled, true);
  assert.equal(
    await loadGoogleAvatar(
      source,
      async () =>
        new Response(png, {
          headers: { 'content-type': 'image/png', 'content-length': '2097153' },
        }),
    ),
    null,
  );
  let redirects = 0;
  assert.equal(
    await loadGoogleAvatar(source, async () => {
      redirects++;
      return new Response(null, { status: 302, headers: { location: source } });
    }),
    null,
  );
  assert.equal(redirects, 4);
  assert.equal(
    await loadGoogleAvatar(source, async () => {
      throw new Error('Private provider error');
    }),
    null,
  );
});
