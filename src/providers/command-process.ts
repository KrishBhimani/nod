import type { Readable, Writable } from 'node:stream';

export interface CommandProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}
