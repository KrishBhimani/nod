import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestLoginName } from '../src/web/lib/vault-name.ts';

test('login names use the observed website without paths, private URL values or brand guesses', () => {
  assert.equal(suggestLoginName('https://x.com'), 'X.com');
  assert.equal(
    suggestLoginName('https://www.example.com/login?token=synthetic#form'),
    'Example.com',
  );
  assert.equal(suggestLoginName('https://accounts.example.com:8443'), 'Accounts.example.com:8443');
  assert.equal(suggestLoginName('https://username:password@example.com'), 'Website login');
  assert.equal(suggestLoginName('javascript:alert(1)'), 'Website login');
  assert.equal(suggestLoginName('not a website'), 'Website login');
});

test('additional logins receive the first available readable name within the name limit', () => {
  assert.equal(suggestLoginName('https://x.com', ['X.com', ' x.COM 2 ', 'X.com 4']), 'X.com 3');
  assert.equal(suggestLoginName('https://x.com', ['Personal account', 'Work account']), 'X.com');
  const origin = `https://${'a'.repeat(60)}.${'b'.repeat(60)}.example.com`;
  const first = suggestLoginName(origin);
  const second = suggestLoginName(origin, [first]);
  assert.equal(first.length, 100);
  assert.equal(second.length, 100);
  assert.equal(second, `${first.slice(0, 98)} 2`);
});
