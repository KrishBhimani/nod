import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { createVault } from '../src/server/vault.ts';

type Vault = Awaited<ReturnType<typeof createVault>>;

export async function requestCredentials(
  vault: Pick<Vault, 'request'>,
  pool: Pick<Pool, 'query'>,
  ...input: Parameters<Vault['request']>
) {
  const request = await vault.request(...input);
  const waiting = await pool.query(
    "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1 AND status='running' RETURNING id",
    [input[0].turnId],
  );
  assert.equal(waiting.rowCount, 1);
  return request;
}
