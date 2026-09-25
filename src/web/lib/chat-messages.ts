import type { Message, Task } from '../../shared/contracts';

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

export function messagesAreGrouped(previous: Message | undefined, next: Message | undefined) {
  if (!previous || !next || previous.role !== next.role || next.replyToMessageId) return false;
  const before = new Date(previous.createdAt);
  const after = new Date(next.createdAt);
  const elapsed = after.getTime() - before.getTime();
  return before.toDateString() === after.toDateString() && elapsed >= 0 && elapsed < 5 * 60_000;
}
