export function taskId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid task identifier.');
  return value;
}
