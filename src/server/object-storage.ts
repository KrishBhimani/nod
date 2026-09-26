import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ObjectStoreConflict, type PrivateObjectStore } from '../ports/object-storage.ts';

const maximum = 16 * 1024 * 1024;
const unavailable = () => new Error('Private file storage is temporarily unavailable.');

function key(value: string) {
  if (
    !/^(?:artifacts\/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}|sessions\/[a-zA-Z0-9_-]{1,100}\.jsonl)$/.test(
      value,
    )
  )
    throw unavailable();
  return value;
}

export function createPostgresObjectStore(options: {
  database: Pool;
  ownerId: string;
}): PrivateObjectStore & { initialize(): Promise<void> } {
  if (!options.ownerId || options.ownerId.length > 200) throw unavailable();
  async function safe<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ObjectStoreConflict) throw error;
      throw unavailable();
    }
  }
  return {
    initialize: () =>
      safe(async () => {
        const client = await options.database.connect();
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL lock_timeout='5s'");
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended(current_database()||':'||current_schema()||':private_objects',0))",
          );
          await client.query(`CREATE TABLE IF NOT EXISTS private_objects (
        owner_id text NOT NULL, object_key text NOT NULL, version text NOT NULL,
        bytes bytea NOT NULL CHECK(octet_length(bytes)<=16777216),
        PRIMARY KEY(owner_id,object_key)
      )`);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      }),
    read: (value, maxBytes) =>
      safe(async () => {
        if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > maximum) throw unavailable();
        const result = await options.database.query(
          'SELECT version,CASE WHEN octet_length(bytes)<=$3 THEN bytes ELSE NULL END AS bytes FROM private_objects WHERE owner_id=$1 AND object_key=$2',
          [options.ownerId, key(value), maxBytes],
        );
        const row = result.rows[0];
        if (!row) return undefined;
        if (
          !Buffer.isBuffer(row.bytes) ||
          row.bytes.length > maxBytes ||
          !/^[a-f0-9-]{36}$/.test(row.version)
        )
          throw unavailable();
        return { bytes: row.bytes, version: row.version };
      }),
    write: (value, bytes, { expectedVersion }) =>
      safe(async () => {
        if (
          bytes.byteLength > maximum ||
          (expectedVersion !== null &&
            (typeof expectedVersion !== 'string' || expectedVersion.length > 200))
        )
          throw unavailable();
        const version = randomUUID();
        const result =
          expectedVersion === null
            ? await options.database.query(
                'INSERT INTO private_objects(owner_id,object_key,version,bytes) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,object_key) DO NOTHING RETURNING version',
                [options.ownerId, key(value), version, Buffer.from(bytes)],
              )
            : await options.database.query(
                'UPDATE private_objects SET version=$3,bytes=$4 WHERE owner_id=$1 AND object_key=$2 AND version=$5 RETURNING version',
                [options.ownerId, key(value), version, Buffer.from(bytes), expectedVersion],
              );
        if (result.rowCount !== 1) throw new ObjectStoreConflict();
        return version;
      }),
    remove: (value, condition) =>
      safe(async () => {
        const result =
          condition?.expectedVersion !== undefined
            ? await options.database.query(
                'DELETE FROM private_objects WHERE owner_id=$1 AND object_key=$2 AND version=$3',
                [options.ownerId, key(value), condition.expectedVersion],
              )
            : await options.database.query(
                'DELETE FROM private_objects WHERE owner_id=$1 AND object_key=$2',
                [options.ownerId, key(value)],
              );
        if (condition?.expectedVersion !== undefined && result.rowCount !== 1)
          throw new ObjectStoreConflict();
      }),
  };
}
