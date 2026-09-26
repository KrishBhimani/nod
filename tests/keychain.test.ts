import assert from 'node:assert/strict';
import test from 'node:test';
import { createKeychainKeyStore } from '../src/providers/keychain/key-store.ts';

test('concurrent first key requests create one key and return independent buffers', async () => {
  let saved: string | undefined;
  let adds = 0;
  const store = createKeychainKeyStore({
    platform: 'darwin',
    run: async (_command, args) => {
      await Promise.resolve();
      if (args[0] === 'find-generic-password') {
        if (!saved) throw Object.assign(new Error('not found'), { code: 44 });
        return { stdout: saved };
      }
      adds++;
      if (saved) throw Object.assign(new Error('duplicate'), { code: 45 });
      saved = args.at(-1)!;
      return { stdout: '' };
    },
  });
  const keys = await Promise.all(Array.from({ length: 10 }, () => store.getKey()));
  assert.equal(adds, 1);
  for (const key of keys) assert.equal(key.toString('base64'), saved);
  keys[0].fill(0);
  assert.equal(keys[1].toString('base64'), saved);
  assert.equal((await store.getKey()).toString('base64'), saved);
});

test('a competing process winning key creation is reread, while failed reads remain retryable', async () => {
  const winner = Buffer.alloc(32, 7).toString('base64');
  let reads = 0;
  let unavailable = true;
  const store = createKeychainKeyStore({
    platform: 'darwin',
    run: async (_command, args) => {
      if (unavailable) throw Object.assign(new Error('private service detail'), { code: 36 });
      if (args[0] === 'find-generic-password') {
        if (++reads === 1) throw Object.assign(new Error('missing'), { code: 44 });
        return { stdout: winner };
      }
      throw Object.assign(new Error('duplicate'), { code: 45 });
    },
  });
  await assert.rejects(store.getKey(), /^Error: The macOS Keychain could not be opened\.$/);
  unavailable = false;
  assert.equal((await store.getKey()).toString('base64'), winner);
});
