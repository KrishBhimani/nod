import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInspectorRedactor,
  inspectorPayloadLimit,
} from '../src/server/inspector-redaction.ts';

test('inspector masks nested credentials, headers and encoded JSON before persistence', () => {
  const secret = 'fixture-provider-secret-with/slash';
  const redact = createInspectorRedactor([secret]);
  const input = {
    query: 'messages after yesterday',
    password: 'private-password',
    customHeaders: { 'X-API-Key': 'custom-api-secret' },
    headers: [{ name: 'Authorization', value: 'header-private' }, ['Cookie', 'session-private']],
    result: JSON.stringify({
      password: 'nested-password',
      cookie: 'nested-cookie',
      nested: { api_key: 'nested-api-key' },
      title: 'Useful result',
    }),
    url: `https://example.com?key=${encodeURIComponent(secret)}&q=hello`,
    text: `An opaque value: ${secret}. Another one: ${encodeURIComponent(secret)}.`,
    otp: '834192',
    card_number: '4111111111111111',
    credentials: { username: 'private-login', password: 'private-pass' },
  };
  const encoded = JSON.stringify(redact(input));
  for (const value of [
    secret,
    encodeURIComponent(secret),
    'private-password',
    'header-private',
    'session-private',
    'nested-password',
    'nested-cookie',
    'nested-api-key',
    '834192',
    '4111111111111111',
    'private-login',
    'custom-api-secret',
  ])
    assert.ok(!encoded.includes(value), value);
  assert.ok(encoded.includes('Useful result'));
  assert.ok(encoded.includes('messages after yesterday'));
  assert.ok(encoded.includes('q=hello'));
});

test('inspector masks secure links, common token strings and secret assignments in tool text', () => {
  const redact = createInspectorRedactor();
  const values = [
    'opaque-form-token',
    'opaque-approval-id',
    'oauth-code-value',
    'oauth-state-value',
    'account-password',
    'cookie-value',
    'sk-proj-abcdefghijklmnopqrstuvwxyz',
    'eyJabc.eyJdef.signature-value',
    'BEGIN PRIVATE KEY',
    'nonstandard-auth-secret',
  ];
  const result = redact([
    'Open http://localhost:4310/credentials/opaque-form-token?x=2 or /approvals/opaque-approval-id',
    'https://example.com?code=oauth-code-value&state=oauth-state-value&safe=true',
    'https://user:account-password@example.com/',
    'Cookie: cookie-value',
    'Authorization: Token nonstandard-auth-secret',
    'sk-proj-abcdefghijklmnopqrstuvwxyz eyJabc.eyJdef.signature-value',
    '-----BEGIN PRIVATE KEY-----\nfixture-private\n-----END PRIVATE KEY-----',
  ]);
  for (const value of values) assert.ok(!JSON.stringify(result).includes(value), value);
  assert.ok(JSON.stringify(result).includes('safe=true'));
});

test('inspector excludes binary data and bounds hostile or oversized payloads without prototype pollution', () => {
  const redact = createInspectorRedactor();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const result = redact({
    bytes: Buffer.from('binary-private'),
    image: { type: 'image', data: 'image-private' },
    nestedImage: {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'nested-image-private' },
    },
    nested: JSON.parse('{"__proto__":{"password":"prototype-private"}}'),
    cycle,
    date: new Date('invalid'),
    fields: Array.from({ length: 110 }, () => 'é'.repeat(9000)),
  });
  const encoded = JSON.stringify(result);
  assert.ok(Buffer.byteLength(encoded) <= inspectorPayloadLimit);
  for (const secret of [
    'binary-private',
    'image-private',
    'nested-image-private',
    'prototype-private',
  ])
    assert.ok(!encoded.includes(secret));
  assert.equal(({} as Record<string, unknown>).password, undefined);
});

test('oversized JSON and text assignments retain the same secret-key masking rules', () => {
  const redact = createInspectorRedactor();
  for (const key of [
    'apiKey',
    'accessToken',
    'sessionToken',
    'privateKey',
    'otpCode',
    'pwd',
    'API_KEY',
  ]) {
    const value = 'fixture-sensitive-value';
    for (const payload of [
      JSON.stringify({ [key]: value, data: 'x'.repeat(64_000) }),
      `result: ${key}=${value}, title=useful`,
    ])
      assert.ok(!JSON.stringify(redact(payload)).includes(value), key);
  }
});

test('Vault bearer links are excluded from inspector payloads', () => {
  const redact = createInspectorRedactor();
  assert.equal(
    redact('Open /vault/private-bearer-token for login'),
    'Open /vault/[redacted] for login',
  );
});

test('framed prompt data and failure text mask nested serialized JSON credentials', () => {
  const redact = createInspectorRedactor();
  const secret = 'synthetic-nested-private-value';
  const currentInstruction = JSON.stringify({
    password: secret,
    apiKey: secret,
    metadata: { title: 'Keep the useful context' },
  });
  for (const value of [
    'Respond to currentInstruction.\nRequest data (JSON):\n' +
      JSON.stringify({ currentInstruction, recentConversation: [] }),
    {
      name: 'ProviderError',
      message: 'Provider rejected: ' + JSON.stringify({ response: currentInstruction }),
    },
    'An unmatched [ prefix before ' + JSON.stringify({ response: currentInstruction }),
  ]) {
    const safe = JSON.stringify(redact(value));
    assert.equal(safe.includes(secret), false);
    assert.ok(safe.includes('Keep the useful context'));
    assert.ok(safe.includes('[redacted]'));
  }
});

test('embedded JSON inspection is bounded and omits incomplete oversized data', () => {
  const redact = createInspectorRedactor();
  const secret = 'synthetic-truncated-private-value';
  for (const value of [
    'Request data (JSON):\n' +
      JSON.stringify({
        currentInstruction: JSON.stringify({ password: secret }),
        pad: 'x'.repeat(70_000),
      }),
    'Failure data: ' +
      Array.from({ length: 200 }, () => JSON.stringify({ apiKey: secret })).join(' '),
  ]) {
    const safe = JSON.stringify(redact(value));
    assert.equal(safe.includes(secret), false);
    assert.ok(Buffer.byteLength(safe) <= inspectorPayloadLimit);
  }
});

test('inspector masks complete escaped quoted secret assignments', () => {
  const redact = createInspectorRedactor();
  for (const text of [
    String.raw`password="prefix\"private-suffix" safe=visible`,
    String.raw`secret='prefix\'private-suffix' safe=visible`,
  ]) {
    const result = String(redact(text));
    assert.doesNotMatch(result, /prefix|private-suffix/);
    assert.match(result, /safe=visible/);
  }
});
