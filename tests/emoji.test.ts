import assert from 'node:assert/strict';
import test from 'node:test';
import { isMessageReaction, reactionEmoji } from '../src/shared/emoji.ts';

test('reactions accept one emoji grapheme including joined people, skin tones, flags and keycaps', () => {
  for (const value of [
    '😀',
    '🧑🏽‍💻',
    '👨‍👩‍👧‍👦',
    '🇵🇹',
    '1️⃣',
    '❤️',
    '☀',
    '👍🏾',
    '🏳️‍🌈',
    'like',
    'dislike',
    'heart',
  ])
    assert.equal(isMessageReaction(value), true, value);
  for (const value of [
    '',
    'hello',
    'ok',
    '😀😀',
    '😀 text',
    'a',
    '1',
    '#',
    '🏻',
    '\u200d',
    '\ufe0f',
    '😀\n',
    '😀 '.repeat(100),
    '__proto__',
    '<script>',
    '😀\u0000',
  ])
    assert.equal(isMessageReaction(value), false, value);
  assert.equal(reactionEmoji('like'), '👍');
  assert.equal(reactionEmoji('dislike'), '👎');
  assert.equal(reactionEmoji('heart'), '❤️');
  assert.equal(reactionEmoji('🧑🏽‍💻'), '🧑🏽‍💻');
  assert.equal(reactionEmoji('__proto__'), '');
});
