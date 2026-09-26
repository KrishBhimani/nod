import { reactionEmoji } from '../../shared/emoji';

const names: Record<string, string> = {
  '👍': 'thumbs up',
  '👎': 'thumbs down',
  '❤️': 'red heart',
  '😂': 'face with tears of joy',
  '🎉': 'party popper',
  '😮': 'face with open mouth',
  '🙏': 'folded hands',
};

export function reactionName(value: string) {
  const emoji = reactionEmoji(value);
  return names[emoji] ?? emoji;
}

export function nextReaction(current: string | null, selected: string) {
  return current && reactionEmoji(current) === reactionEmoji(selected) ? null : selected;
}
