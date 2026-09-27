export interface PrivateObject {
  bytes: Uint8Array;
  version: string;
}

export interface PrivateObjectStore {
  read(key: string, maxBytes: number): Promise<PrivateObject | undefined>;
  write(
    key: string,
    bytes: Uint8Array,
    options: { expectedVersion: string | null },
  ): Promise<string>;
  remove(key: string, options?: { expectedVersion?: string }): Promise<void>;
}

export class ObjectStoreConflict extends Error {
  constructor() {
    super('The private file changed. Reload its current state before continuing.');
  }
}
