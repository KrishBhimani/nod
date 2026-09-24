import { EventEmitter } from 'node:events';

export const events = new EventEmitter();
events.setMaxListeners(50);
export function refresh() { events.emit('event', { type: 'refresh' }); }
export function delta(taskId: string, text: string) { events.emit('event', { type: 'delta', taskId, text }); }
