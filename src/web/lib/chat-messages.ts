import type { Message, Task } from '../../shared/contracts';
import { isSameDay, type DateFormat } from './date-format';

export function visibleConversationTurns(
  turns: Array<{ id: string; top: number }>,
  viewport: { top: number; bottom: number },
) {
  return turns
    .filter(
      (turn, index) =>
        turn.top < viewport.bottom && (turns[index + 1]?.top ?? Infinity) > viewport.top,
    )
    .map((turn) => turn.id);
}

export function hasVisibleChatActivity(tasks: Pick<Task, 'status' | 'showTyping'>[]) {
  return tasks.some(
    (task) => task.showTyping !== false && ['queued', 'running'].includes(task.status),
  );
}

export function messagesAreGrouped(
  previous: Message | undefined,
  next: Message | undefined,
  format?: DateFormat,
) {
  if (!previous || !next || previous.role !== next.role || next.replyToMessageId) return false;
  const elapsed = Date.parse(next.createdAt) - Date.parse(previous.createdAt);
  return (
    isSameDay(previous.createdAt, next.createdAt, format) && elapsed >= 0 && elapsed < 5 * 60_000
  );
}
