export interface Trash {
  ready(): Promise<boolean>;
  put(path: string, signal?: AbortSignal): Promise<void>;
}
