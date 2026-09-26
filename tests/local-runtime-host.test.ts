import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createLocalRuntimeTransport } from '../src/providers/runtime-host/local.ts';
import { createTenantRuntimeHost } from '../src/server/runtime-host.ts';
import { createTenantStore, tenantIdentifiers } from '../src/server/tenants.ts';

test(
  'two real local tenant processes retain private settings across a graceful gateway restart',
  {
    skip: !process.env.TEST_DATABASE_URL,
    timeout: 90_000,
  },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
    const database = `test_runtime_${suffix}`;
    const directory = await mkdtemp(join(tmpdir(), 'sidekick-runtime-'));
    const root = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    const environment = 'fixture';
    const secret = randomBytes(32);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = `/${database}`;
    url.searchParams.delete('options');
    let admin: pg.Pool | undefined;
    let host: ReturnType<typeof createTenantRuntimeHost> | undefined;
    let created = false;
    t.after(async () => {
      await host?.close().catch(() => {});
      await admin?.end();
      if (created) await root.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      for (const owner of [ownerA, ownerB])
        await root.query(`DROP ROLE IF EXISTS "${tenantIdentifiers(owner, environment).role}"`);
      await root.end();
      await rm(directory, { recursive: true, force: true });
    });
    await root.query(`CREATE DATABASE "${database}"`);
    created = true;
    admin = new pg.Pool({ connectionString: url.href, max: 4 });
    const tenants = createTenantStore({
      admin,
      databaseUrl: url.href,
      environment,
      getSecret: () => secret,
    });
    await tenants.initialize();
    const create = () =>
      createTenantRuntimeHost({
        tenants,
        masterKey: secret,
        environment,
        transport: createLocalRuntimeTransport({
          root: directory,
          entrypoint: 'src/server/index.ts',
          cwd: resolve('.'),
        }),
        operatorEnvironment: {
          SIDEKICK_PUBLIC_URL: 'http://localhost:4330',
          COMPUTER_PROVIDER: 'e2b',
          E2B_API_KEY: 'synthetic-unused-key',
          E2B_BROWSER_TEMPLATE: 'synthetic-browser',
          E2B_WORKSPACE_TEMPLATE: 'synthetic-workspace',
        },
      });
    host = create();
    async function request(owner: string, method: string, body?: unknown) {
      const response = await host!.fetch(
        owner,
        new Request('http://sidekick.test/api/preferences', {
          method,
          headers: { 'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        { developer: false },
      );
      assert.equal(response.status, 200);
      return (await response.json()) as { notificationRule: string; quietHoursEnabled: boolean };
    }
    await Promise.all([
      request(ownerA, 'PATCH', { notificationRule: 'fixture A', quietHoursEnabled: false }),
      request(ownerB, 'PATCH', { notificationRule: 'fixture B', quietHoursEnabled: true }),
    ]);
    assert.equal((await request(ownerA, 'GET')).notificationRule, 'fixture A');
    assert.equal((await request(ownerB, 'GET')).notificationRule, 'fixture B');
    const previous = await tenants.currentLease(ownerA);
    await host.close();
    assert.equal(await tenants.currentLease(ownerA), undefined);
    host = create();
    const restored = await request(ownerA, 'GET');
    assert.equal(restored.notificationRule, 'fixture A');
    assert.equal(restored.quietHoursEnabled, false);
    assert.equal((await request(ownerB, 'GET')).notificationRule, 'fixture B');
    assert.ok(
      BigInt((await tenants.currentLease(ownerA))!.generation) > BigInt(previous!.generation),
    );
  },
);
