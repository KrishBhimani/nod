import { randomUUID } from 'node:crypto';
import type { Trash } from '../ports/trash.ts';

const answerMs = 60_000;

type Parent = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};

export function desktopTrash(): Trash {
  const parent = (process as NodeJS.Process & { parentPort?: Parent }).parentPort;
  const waiting = new Map<string, { resolve(): void; reject(error: Error): void }>();
  parent?.on('message', ({ data }) => {
    const message = data as { type?: unknown; id?: unknown; error?: unknown } | null;
    if (message?.type !== 'nod-trash-result' || typeof message.id !== 'string') return;
    const request = waiting.get(message.id);
    if (!request) return;
    waiting.delete(message.id);
    if (typeof message.error === 'string') request.reject(new Error(message.error));
    else request.resolve();
  });
  return {
    ready: async () => Boolean(parent),
    put: (path, signal) =>
      new Promise<void>((resolve, reject) => {
        if (!parent) return reject(new Error('The Trash needs Nod desktop.'));
        if (signal?.aborted) return reject(signal.reason);
        const id = randomUUID();
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error('The Trash did not answer.'));
        }, answerMs);
        waiting.set(id, {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        parent.postMessage({ type: 'nod-trash', id, path });
      }),
  };
}
