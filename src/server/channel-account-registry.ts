import type { Pool } from 'pg';
import { z } from 'zod';
import type { ChannelAccountIdentity, ChannelAccountRegistry } from '../ports/channel-settings.ts';
import type { TenantLease } from './tenants.ts';

export class ChannelAccountRegistryError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: 'invalid_configuration' | 'invalid_identity' | 'invalid_lease' | 'unavailable',
  ) {
    super(
      code === 'invalid_lease'
        ? 'Runtime authentication failed.'
        : code === 'unavailable'
          ? 'Channel account ownership is temporarily unavailable.'
          : 'The channel account ownership configuration is invalid.',
    );
    this.name = 'ChannelAccountRegistryError';
    this.statusCode = code === 'invalid_lease' ? 401 : code === 'invalid_identity' ? 400 : 503;
  }
}

export function createChannelAccountRegistry(options: {
  admin: Pool;
  environment: string;
  controlSchema?: string;
}): ChannelAccountRegistry & {
  initialize(): Promise<void>;
  claimWithLease(input: ChannelAccountIdentity, lease: TenantLease): Promise<boolean>;
  releaseWithLease(input: ChannelAccountIdentity, lease: TenantLease): Promise<void>;
} {
  const schema = options.controlSchema ?? 'sidekick_control';
  if (
    !/^[a-z][a-z0-9-]{0,31}$/.test(options.environment) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(schema) ||
    schema === 'public' ||
    schema.startsWith('pg_')
  )
    throw new ChannelAccountRegistryError('invalid_configuration');
  const table = `"${schema}".channel_accounts`;
  const activeLease = `WITH locked_tenant AS MATERIALIZED (
    SELECT owner_id,lease_holder,lease_generation,lease_expires
    FROM "${schema}".tenants WHERE environment=$1 AND owner_id=$4 FOR UPDATE
  ), active_lease AS MATERIALIZED (
    SELECT owner_id FROM locked_tenant
    WHERE lease_holder=$5::uuid AND lease_generation=$6::bigint AND lease_expires>clock_timestamp()
  )`;

  function identity(input: ChannelAccountIdentity) {
    const ownerId = z.uuid().safeParse(input.ownerId);
    if (
      !ownerId.success ||
      !['telegram', 'whatsapp'].includes(input.provider) ||
      !/^[a-zA-Z0-9:_-]{1,200}$/.test(input.accountId)
    )
      throw new ChannelAccountRegistryError('invalid_identity');
    return [options.environment, input.provider, input.accountId, ownerId.data.toLowerCase()];
  }

  function leasedIdentity(input: ChannelAccountIdentity, lease: TenantLease) {
    const values = identity(input);
    const holder = z.uuid().safeParse(lease.holderId);
    if (
      lease.environment !== options.environment ||
      lease.ownerId.toLowerCase() !== values[3] ||
      !holder.success ||
      !/^[1-9][0-9]{0,18}$/.test(lease.generation) ||
      BigInt(lease.generation) > 9223372036854775807n
    )
      throw new ChannelAccountRegistryError('invalid_lease');
    return [...values, holder.data.toLowerCase(), lease.generation];
  }

  async function protect<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ChannelAccountRegistryError) throw error;
      throw new ChannelAccountRegistryError('unavailable');
    }
  }

  return {
    initialize: () =>
      protect(async () => {
        const client = await options.admin.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `sidekick:channel-account-registry:${schema}`,
          ]);
          await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
          environment text NOT NULL,
          provider text NOT NULL CHECK (provider IN ('telegram','whatsapp')),
          account_id text NOT NULL,
          owner_id uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (environment,provider,account_id)
        )`);
          await client.query(`REVOKE ALL ON TABLE ${table} FROM PUBLIC`);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      }),
    claim: (input) =>
      protect(async () => {
        const result = await options.admin.query(
          `INSERT INTO ${table} AS accounts (environment,provider,account_id,owner_id)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (environment,provider,account_id)
           DO UPDATE SET owner_id=EXCLUDED.owner_id
           WHERE accounts.owner_id=EXCLUDED.owner_id
           RETURNING owner_id`,
          identity(input),
        );
        return result.rowCount === 1;
      }),
    release: (input) =>
      protect(async () => {
        await options.admin.query(
          `DELETE FROM ${table}
           WHERE environment=$1 AND provider=$2 AND account_id=$3 AND owner_id=$4`,
          identity(input),
        );
      }),
    claimWithLease: (input, lease) =>
      protect(async () => {
        const result = await options.admin.query<{ valid: boolean; claimed: boolean }>(
          `${activeLease}, changed AS (
            INSERT INTO ${table} AS accounts (environment,provider,account_id,owner_id)
            SELECT $1,$2,$3,owner_id FROM active_lease
            ON CONFLICT (environment,provider,account_id)
            DO UPDATE SET owner_id=EXCLUDED.owner_id
            WHERE accounts.owner_id=EXCLUDED.owner_id
            RETURNING owner_id
          ) SELECT EXISTS(SELECT 1 FROM active_lease) AS valid,
                   EXISTS(SELECT 1 FROM changed) AS claimed`,
          leasedIdentity(input, lease),
        );
        if (!result.rows[0]?.valid) throw new ChannelAccountRegistryError('invalid_lease');
        return result.rows[0].claimed;
      }),
    releaseWithLease: (input, lease) =>
      protect(async () => {
        const result = await options.admin.query<{ valid: boolean }>(
          `${activeLease}, changed AS (
            DELETE FROM ${table} AS accounts USING active_lease
            WHERE accounts.environment=$1 AND accounts.provider=$2 AND accounts.account_id=$3
              AND accounts.owner_id=active_lease.owner_id
            RETURNING accounts.owner_id
          ) SELECT EXISTS(SELECT 1 FROM active_lease) AS valid`,
          leasedIdentity(input, lease),
        );
        if (!result.rows[0]?.valid) throw new ChannelAccountRegistryError('invalid_lease');
      }),
  };
}
