import { hkdfSync, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { RuntimeTransport } from '../ports/runtime-transport.ts';
import type { TenantRuntimeHost } from '../ports/tenant-runtime.ts';
import type { createTenantStore, TenantLease } from './tenants.ts';
import { deriveRuntimeSecret, runtimeHeader, signRuntimeRequest } from './runtime-auth.ts';
import { channelWebhookToken } from './hosted-webhooks.ts';

const forwardedEnvironment = [
  'SIDEKICK_PUBLIC_URL',
  'SIDEKICK_RELEASE',
  'COMPUTER_PROVIDER',
  'E2B_API_KEY',
  'E2B_BROWSER_TEMPLATE',
  'E2B_WORKSPACE_TEMPLATE',
  'E2B_SANDBOX_TIMEOUT_MS',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'ROUTING_MODEL',
  'TRIAGE_MODEL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'TYPESAFE_API_KEY',
  'TYPESAFE_MODEL',
  'STT_MODEL',
  'TTS_MODEL',
  'TTS_VOICE',
  'COMPOSIO_API_KEY',
  'COMPOSIO_WEBHOOK_SECRET',
  'COMPOSIO_GMAIL_AUTH_CONFIG_ID',
  'COMPOSIO_CALENDAR_AUTH_CONFIG_ID',
  'COMPOSIO_DRIVE_AUTH_CONFIG_ID',
  'COMPOSIO_SHEETS_AUTH_CONFIG_ID',
  'COMPOSIO_DOCS_AUTH_CONFIG_ID',
  'COMPOSIO_SLACK_AUTH_CONFIG_ID',
  'COMPOSIO_NOTION_AUTH_CONFIG_ID',
  'OBJECT_STORAGE_PROVIDER',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_REGION',
] as const;

type Entry = { lease: TenantLease; secret: string; healthy: boolean; stopping?: Promise<void> };

export function createTenantRuntimeHost(options: {
  tenants: Pick<
    ReturnType<typeof createTenantStore>,
    'provision' | 'runtimeConfiguration' | 'acquireLease' | 'renewLease' | 'releaseLease'
  >;
  transport: RuntimeTransport;
  masterKey: Uint8Array;
  environment: string;
  operatorEnvironment: Record<string, string | undefined>;
  developerIds?: ReadonlySet<string>;
  leaseDurationMs?: number;
  heartbeatMs?: number;
}): TenantRuntimeHost {
  const duration = options.leaseDurationMs ?? 60_000;
  const heartbeat = options.heartbeatMs ?? 15_000;
  if (
    duration < 10_000 ||
    duration > 60_000 ||
    heartbeat < 100 ||
    heartbeat > duration / 3 ||
    options.masterKey.length !== 32
  )
    throw new Error('Runtime lease configuration is invalid.');
  const holderId = randomUUID();
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<Entry>>();
  let closed = false;
  let renewal: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  async function signedFetch(
    entry: Entry,
    request: Request,
    access: { developer: boolean; kind?: 'user' | 'webhook' | 'wake' },
  ) {
    if (!entry.healthy || Date.parse(entry.lease.expiresAt) <= Date.now())
      throw new Error('The account runtime is unavailable.');
    const url = new URL(request.url);
    const body = ['GET', 'HEAD'].includes(request.method)
      ? new Uint8Array()
      : new Uint8Array(await request.arrayBuffer());
    if (closed || !entry.healthy || Date.parse(entry.lease.expiresAt) <= Date.now())
      throw new Error('The account runtime is unavailable.');
    const headers = new Headers(request.headers);
    for (const name of ['cookie', 'authorization', 'host', 'x-sidekick-account', runtimeHeader])
      headers.delete(name);
    headers.set(
      runtimeHeader,
      signRuntimeRequest({
        secret: entry.secret,
        ownerId: entry.lease.ownerId,
        environment: options.environment,
        generation: entry.lease.generation,
        method: request.method,
        target: url.pathname + url.search,
        body,
        ...access,
      }),
    );
    return options.transport.fetch(
      entry.lease.ownerId,
      new Request(request.url, {
        method: request.method,
        headers,
        signal: request.signal,
        ...(!['GET', 'HEAD'].includes(request.method) ? { body } : {}),
      }),
    );
  }

  async function stop(entry: Entry) {
    entry.healthy = false;
    entry.stopping ??= (async () => {
      await options.transport.stop(entry.lease.ownerId, entry.lease.generation);
      await options.tenants.releaseLease(entry.lease);
      if (entries.get(entry.lease.ownerId) === entry) entries.delete(entry.lease.ownerId);
    })().finally(() => {
      entry.stopping = undefined;
    });
    return entry.stopping;
  }

  async function start(ownerId: string): Promise<Entry> {
    await options.tenants.provision(ownerId);
    const lease = await options.tenants.acquireLease(ownerId, holderId, duration);
    if (!lease) throw new Error('The account runtime is restarting. Try again shortly.');
    const secret = deriveRuntimeSecret(options.masterKey, options.environment, ownerId);
    const entry: Entry = { lease, secret, healthy: true };
    try {
      const previous = await options.transport.status(ownerId);
      if (previous.generation) await options.transport.stop(ownerId, previous.generation);
      const configuration = await options.tenants.runtimeConfiguration(ownerId);
      const environment: Record<string, string> = {};
      for (const key of forwardedEnvironment) {
        const value = options.operatorEnvironment[key];
        if (value) environment[key] = value;
      }
      if (options.operatorEnvironment.OBJECT_STORAGE_ROOT)
        environment.OBJECT_STORAGE_ROOT = join(
          options.operatorEnvironment.OBJECT_STORAGE_ROOT,
          ownerId,
        );
      Object.assign(environment, {
        SIDEKICK_MODE: 'tenant',
        SIDEKICK_OWNER_ID: ownerId,
        SIDEKICK_ENVIRONMENT: options.environment,
        SIDEKICK_RUNTIME_GENERATION: lease.generation,
        SIDEKICK_RUNTIME_SECRET: secret,
        SIDEKICK_RUNTIME_LEASE_EXPIRES: lease.expiresAt,
        SIDEKICK_DATA_ROOT: '/data',
        DATABASE_URL: configuration.databaseUrl,
        DATABASE_POOL_MAX: String(configuration.poolMax),
        INSPECTOR_DATABASE_POOL_MAX: '1',
        PGBOSS_SCHEMA: configuration.jobsSchema,
        PORT: '4310',
        NODE_ENV: 'production',
        DEV_INSPECTOR: String(
          options.operatorEnvironment.DEV_INSPECTOR === 'true' &&
            (options.developerIds?.has(ownerId) ?? false),
        ),
        SIDEKICK_VAULT_KEY: Buffer.from(
          hkdfSync(
            'sha256',
            options.masterKey,
            Buffer.from('sidekick-vault-v1'),
            Buffer.from(JSON.stringify([options.environment, ownerId])),
            32,
          ),
        ).toString('base64'),
      });
      if (environment.SIDEKICK_PUBLIC_URL)
        for (const provider of ['telegram', 'whatsapp'] as const) {
          environment[`SIDEKICK_${provider.toUpperCase()}_WEBHOOK_URL`] = new URL(
            `/api/webhooks/${provider}/${channelWebhookToken(options.masterKey, options.environment, ownerId, provider)}`,
            options.operatorEnvironment.SIDEKICK_WEBHOOK_ORIGIN || environment.SIDEKICK_PUBLIC_URL,
          ).href;
        }
      environment.SIDEKICK_CONTROL_URL =
        options.operatorEnvironment.SIDEKICK_RUNTIME_URL === 'http://sidekick.runtime'
          ? 'http://sidekick.control'
          : options.operatorEnvironment.SIDEKICK_CONTROL_ORIGIN ||
            options.operatorEnvironment.SIDEKICK_PUBLIC_URL ||
            '';
      await options.transport.start({ ownerId, generation: lease.generation, environment });
      if (closed || Date.parse(lease.expiresAt) <= Date.now())
        throw new Error('The account runtime did not become ready.');
      entries.set(ownerId, entry);
      return entry;
    } catch {
      entry.healthy = false;
      try {
        const current = await options.transport.status(ownerId);
        if (current.generation === lease.generation && !current.stopped)
          await options.transport.stop(ownerId, lease.generation);
        if (!current.generation || current.stopped || current.generation === lease.generation)
          await options.tenants.releaseLease(lease);
      } catch {}
      throw new Error('The account runtime could not start. Try again shortly.');
    }
  }

  async function ensure(owner: string) {
    if (closed) throw new Error('The account runtime is unavailable.');
    const ownerId = z.uuid().parse(owner).toLowerCase();
    const entry = entries.get(ownerId);
    if (entry?.healthy && Date.parse(entry.lease.expiresAt) > Date.now()) return entry;
    if (entry) await stop(entry);
    if (closed) throw new Error('The account runtime is unavailable.');
    let operation = pending.get(ownerId);
    if (!operation) {
      operation = start(ownerId);
      pending.set(ownerId, operation);
      void operation
        .finally(() => {
          if (pending.get(ownerId) === operation) pending.delete(ownerId);
        })
        .catch(() => {});
    }
    return operation;
  }

  const timer = setInterval(() => {
    if (closed || renewal) return;
    renewal = (async () => {
      await Promise.all(
        [...entries.values()].map(async (entry) => {
          if (!entry.healthy) return;
          try {
            const lease = await options.tenants.renewLease(entry.lease, duration);
            if (!lease) throw new Error('Runtime ownership expired.');
            entry.lease = lease;
            const response = await signedFetch(
              entry,
              new Request('http://sidekick.runtime/api/runtime/lease', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ expiresAt: lease.expiresAt }),
                signal: AbortSignal.timeout(Math.min(heartbeat, 10_000)),
              }),
              { developer: false, kind: 'wake' },
            );
            if (!response.ok) throw new Error('Runtime ownership could not be renewed.');
            await response.body?.cancel();
          } catch {
            await stop(entry).catch(() => {});
          }
        }),
      );
    })().finally(() => {
      renewal = undefined;
    });
    void renewal.catch(() => {});
  }, heartbeat);
  timer.unref();

  return {
    async fetch(ownerId, request, access) {
      const entry = await ensure(ownerId);
      return signedFetch(entry, request, access);
    },
    close() {
      closing ??= (async () => {
        closed = true;
        clearInterval(timer);
        for (const entry of entries.values()) entry.healthy = false;
        await renewal?.catch(() => {});
        await Promise.allSettled([...pending.values()]);
        const outcomes = await Promise.allSettled([...entries.values()].map(stop));
        await options.transport.close();
        if (outcomes.some((result) => result.status === 'rejected'))
          throw new Error('Some account runtimes could not stop.');
      })();
      return closing;
    },
  };
}
