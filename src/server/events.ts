import { EventEmitter } from 'node:events';

type DeltaEvent = {
  type: 'delta';
  ownerId: string;
  channel: string;
  taskId: string;
  text: string;
  streamId?: string;
  done?: boolean;
  conversationRevision?: number;
};
export type ServerEvent = { type: 'refresh' } | DeltaEvent;

export const events = new EventEmitter<{ event: [ServerEvent] }>();
events.setMaxListeners(50);
export function refresh() {
  events.emit('event', { type: 'refresh' });
}
export function delta(event: Omit<DeltaEvent, 'type'>) {
  events.emit('event', { type: 'delta', ...event });
}
