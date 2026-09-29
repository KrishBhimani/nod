export function threadIdentity(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid thread identifier.');
  return value;
}
