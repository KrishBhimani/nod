import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionUrl } from '../src/web/lib/connection-url.ts';

test('connection navigation permits secure providers and same-origin app consent only', () => {
  const origin = 'http://localhost:4320';
  assert.equal(
    connectionUrl('https://accounts.example.com/consent', origin),
    'https://accounts.example.com/consent',
  );
  assert.equal(connectionUrl('/e2e/connect/example', origin), origin + '/e2e/connect/example');
  for (const value of [
    'http://elsewhere.example/consent',
    'http://localhost:4310/consent',
    'javascript:alert(1)',
    'data:text/html,login',
    'https://user:password@example.com/consent',
    'http://localhost:4320@elsewhere.example/consent',
  ])
    assert.throws(() => connectionUrl(value, origin));
});
