import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { CredentialKeyStore } from '../../ports/key-store.ts';
import { parseCredentialKey } from '../environment/key-store.ts';

const run = promisify(execFile);

export function createKeychainKeyStore(): CredentialKeyStore {
  const service = 'dev.sidekick.vault';
  const account = 'master-key-v1';
  return {
    id: 'keychain',
    configured: process.platform === 'darwin',
    async getKey() {
      if (process.platform !== 'darwin') throw new Error('macOS Keychain is unavailable.');
      try {
        const { stdout } = await run(
          '/usr/bin/security',
          ['find-generic-password', '-s', service, '-a', account, '-w'],
          { timeout: 15_000, maxBuffer: 4096 },
        );
        return parseCredentialKey(stdout.trim());
      } catch (error) {
        if ((error as { code?: number }).code !== 44)
          throw new Error('The macOS Keychain could not be opened.');
      }
      const key = randomBytes(32);
      try {
        await run(
          '/usr/bin/security',
          ['add-generic-password', '-s', service, '-a', account, '-w', key.toString('base64')],
          { timeout: 15_000, maxBuffer: 4096 },
        );
        return key;
      } catch {
        key.fill(0);
        throw new Error('The macOS Keychain could not save the credential key.');
      }
    },
  };
}
