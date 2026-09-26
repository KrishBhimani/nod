import assert from 'node:assert/strict';
import test from 'node:test';
import { speechParts } from '../src/web/lib/speech.ts';

test('long spoken replies retain all words in bounded sequential requests', () => {
  const text = 'A long but useful reply. '.repeat(450).trim();
  const parts = speechParts(text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 3000));
  assert.equal(parts.join(' '), text);
  assert.deepEqual(speechParts('A short reply.'), ['A short reply.']);
  assert.deepEqual(speechParts('  '), []);
});

test('speech boundaries preserve surrogate pairs when a long word has no split point', () => {
  const text = `${'a'.repeat(2999)}😀${'b'.repeat(3001)}`;
  const parts = speechParts(text);
  assert.ok(parts.every((part) => part.length <= 3000));
  assert.equal(parts.join(''), text);
  assert.ok(
    parts.every((part) => !/[\uD800-\uDBFF]$/.test(part) && !/^[\uDC00-\uDFFF]/.test(part)),
  );
});
