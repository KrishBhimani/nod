import type { CredentialKeyStore } from '../../ports/key-store.ts';

export function parseCredentialKey(value: string) {
  const key = Buffer.from(value.trim(), 'base64');
  if (key.length !== 32 || key.toString('base64') !== value.trim()) {
    throw new Error('The credential key must contain exactly 32 bytes encoded as base64.');
  }
  return key;
}

export function createEnvironmentKeyStore(value?: string): CredentialKeyStore {
  return {
    id: 'environment',
    configured: Boolean(value),
    async getKey() {
      if (!value) throw new Error('The credential key is not configured.');
      return parseCredentialKey(value);
    },
  };
}
