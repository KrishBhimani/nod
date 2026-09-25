const legacyReactions: Record<string, string> = { like: '👍', dislike: '👎', heart: '❤️' };
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const emojiSequence = new RegExp('^\\p{RGI_Emoji}$', 'v');

export function isMessageReaction(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  if (Object.hasOwn(legacyReactions, value)) return true;
  if ([...segmenter.segment(value)].length !== 1 || /^\p{Emoji_Modifier}$/u.test(value))
    return false;
  return emojiSequence.test(value) || /^\p{Extended_Pictographic}\uFE0F?$/u.test(value);
}

export function reactionEmoji(value: string): string {
  return Object.hasOwn(legacyReactions, value)
    ? legacyReactions[value]
    : isMessageReaction(value)
      ? value
      : '';
}
