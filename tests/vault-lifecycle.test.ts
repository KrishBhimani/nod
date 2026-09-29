import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { createVault } from '../src/server/vault.ts';

test('Vault shutdown drains the active resume and leaves later credentials pending', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resumed: string[] = [];
  const completed: string[] = [];
  const database = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('SELECT r.*'))
        return {
          rows: [
            { id: 'request-a', turn_id: 'turn-a' },
            { id: 'request-b', turn_id: 'turn-b' },
          ],
        };
      if (sql.startsWith('UPDATE credential_requests SET resume_pending'))
        completed.push(String(values?.[0]));
      return { rows: [] };
    },
  } as unknown as Pool;
  const vault = await createVault(database, {
    keyStore: { id: 'fixture', configured: true, getKey: async () => randomBytes(32) },
    inject: async () => {},
    retry: async () => {},
    resume: async (id) => {
      resumed.push(id);
      entered();
      await held;
    },
  });
  const app = Fastify();
  vault.registerRoutes(app);
  await app.ready();
  const pending = vault.resumePending();
  await started;
  let closed = false;
  const closing = app.close().then(() => {
    closed = true;
  });
  try {
    await setImmediate();
    assert.equal(closed, false);
    release();
    await Promise.all([pending, closing]);
    await vault.resumePending();
    assert.deepEqual(resumed, ['turn-a']);
    assert.deepEqual(completed, ['request-a']);
  } finally {
    release();
    await Promise.allSettled([pending, closing]);
  }
});
