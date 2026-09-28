import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { createTenantStore, tenantIdentifiers, TenantError } from '../src/server/tenants.ts';

test('tenant namespaces are opaque, deterministic, environment-bound and restricted to UUID owners', () => {
  const ownerId = randomUUID();
  const names = tenantIdentifiers(ownerId, 'development');
  assert.deepEqual(names, tenantIdentifiers(ownerId.toUpperCase(), 'development'));
  assert.notDeepEqual(names, tenantIdentifiers(ownerId, 'production'));
  assert.notDeepEqual(names, tenantIdentifiers(randomUUID(), 'development'));
  for (const value of Object.values(names)) {
    assert.match(value, /^sk_(user|app|jobs)_[a-f0-9]{32}$/);
    assert.ok(!value.includes(ownerId));
  }
  for (const value of ['local-development', 'alice@example.test', "'; DROP SCHEMA public; --"])
    assert.throws(() => tenantIdentifiers(value, 'development'), TenantError);
  assert.throws(() => tenantIdentifiers(ownerId, '../production'), TenantError);
});

test('tenant provisioning validates deployment options before opening a database connection', async () => {
  let opened = false;
  const admin = {
    connect: async () => {
      opened = true;
      throw new Error('Fixture connection must not open.');
    },
  } as unknown as pg.Pool;
  const options = {
    admin,
    databaseUrl: 'postgresql://fixture:fixture@localhost/fixture',
    environment: 'development',
    getSecret: () => randomBytes(32),
  };
  for (const change of [
    { environment: 'production; DROP ROLE fixture' },
    { controlSchema: 'public' },
    { controlSchema: 'pg_fixture' },
    { controlSchema: 'unsafe.name' },
    { maxTenants: 401 },
    { maxTenants: 0 },
    { credentialVersion: 0 },
    { databaseUrl: 'https://fixture.test/database' },
  ])
    assert.throws(() => createTenantStore({ ...options, ...change }), TenantError);
  const store = createTenantStore(options);
  await assert.rejects(store.provision('fixture'), TenantError);
  await assert.rejects(store.acquireLease(randomUUID(), 'fixture'), TenantError);
  await assert.rejects(store.acquireLease(randomUUID(), randomUUID(), 1), TenantError);
  assert.equal(opened, false);
});

test(
  'dedicated tenant logins isolate schemas, queues, provisioning, credentials and runtime leases',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60_000 },
  async (t) => {
    const fixtureId = randomUUID().replaceAll('-', '').slice(0, 20);
    const databaseName = `test_tenants_${fixtureId}`;
    const provisionerRole = `test_provisioner_${fixtureId}`;
    const provisionerPassword = randomBytes(32).toString('base64url');
    const root = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 5_000,
    });
    const runtimePools: pg.Pool[] = [];
    const queues: PgBoss[] = [];
    const tenantRoles = new Set<string>();
    let created = false;
    let provisionerCreated = false;
    let admin: pg.Pool | undefined;
    t.after(async () => {
      try {
        for (const queue of queues)
          await queue.stop({ graceful: true, timeout: 1000 }).catch(() => {});
        await Promise.all(runtimePools.map((pool) => pool.end()));
        await admin?.end();
        if (created) {
          const deadline = Date.now() + 5_000;
          while (
            (
              await root.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1 LIMIT 1', [
                databaseName,
              ])
            ).rowCount
          ) {
            assert.ok(Date.now() < deadline, 'Fixture database connections did not close.');
            await delay(10);
          }
          await root.query(`DROP DATABASE "${databaseName}"`);
        }
        for (const role of tenantRoles) await root.query(`DROP ROLE IF EXISTS "${role}"`);
        if (provisionerCreated) await root.query(`DROP ROLE "${provisionerRole}"`);
      } finally {
        await root.end();
      }
    });
    await root.query(
      `CREATE ROLE "${provisionerRole}" LOGIN CREATEROLE NOCREATEDB NOSUPERUSER NOBYPASSRLS PASSWORD '${provisionerPassword}'`,
    );
    provisionerCreated = true;
    await root.query(`CREATE DATABASE "${databaseName}" OWNER "${provisionerRole}"`);
    created = true;
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.username = provisionerRole;
    url.password = provisionerPassword;
    url.pathname = `/${databaseName}`;
    url.searchParams.delete('options');
    admin = new pg.Pool({ connectionString: url.href, max: 4 });
    await admin.query('CREATE SCHEMA auth_fixture');
    await admin.query('CREATE TABLE auth_fixture.sessions(secret text)');
    await admin.query('CREATE TABLE public.fixture_shared(secret text)');
    await admin.query('GRANT SELECT ON public.fixture_shared TO PUBLIC');
    const secret = randomBytes(32);
    const options = {
      admin,
      databaseUrl: url.href,
      environment: `test-${fixtureId}`,
      getSecret: () => secret,
      maxTenants: 3,
    };
    const store = createTenantStore(options);
    await Promise.all([store.initialize(), store.initialize()]);
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    for (const ownerId of [ownerA, ownerB])
      tenantRoles.add(tenantIdentifiers(ownerId, options.environment).role);
    tenantRoles.add(tenantIdentifiers(ownerA, `other-${fixtureId}`).role);
    const results = await Promise.all([
      store.provision(ownerA),
      store.provision(ownerA.toUpperCase()),
      store.provision(ownerB),
    ]);
    assert.deepEqual(results[0], results[1]);
    const [tenantA, , tenantB] = results;
    const otherEnvironment = createTenantStore({ ...options, environment: `other-${fixtureId}` });
    const tenantOther = await otherEnvironment.provision(ownerA);
    assert.notEqual(tenantA.role, tenantOther.role);
    assert.deepEqual((await store.listOwners()).sort(), [ownerA, ownerB].sort());
    assert.deepEqual(await otherEnvironment.listOwners(), [ownerA]);
    assert.equal(await store.get(randomUUID()), undefined);
    await assert.rejects(store.runtimeConfiguration(randomUUID()), { code: 'not_found' });
    const overflowOwner = randomUUID();
    await assert.rejects(store.provision(overflowOwner), { code: 'capacity_reached' });
    const overflowNames = tenantIdentifiers(overflowOwner, options.environment);
    assert.equal(
      (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [overflowNames.role])).rowCount,
      0,
    );
    const [configA, configB, configOther] = await Promise.all([
      store.runtimeConfiguration(ownerA),
      store.runtimeConfiguration(ownerB),
      otherEnvironment.runtimeConfiguration(ownerA),
    ]);
    assert.equal(configA.poolMax, 4);
    const passwordA = new URL(configA.databaseUrl).password;
    assert.equal(passwordA.length, 43);
    assert.ok(passwordA !== new URL(configB.databaseUrl).password);
    assert.ok(passwordA !== new URL(configOther.databaseUrl).password);
    assert.ok(
      passwordA === new URL((await store.runtimeConfiguration(ownerA)).databaseUrl).password,
    );
    assert.ok(!JSON.stringify(tenantA).includes(passwordA));
    const poolA = new pg.Pool({ connectionString: configA.databaseUrl, max: 2 });
    const poolB = new pg.Pool({ connectionString: configB.databaseUrl, max: 2 });
    runtimePools.push(poolA, poolB);

    await t.test(
      'roles can migrate only their own schema and cannot select a different owner or auth registry',
      async () => {
        for (const [pool, tenant] of [
          [poolA, tenantA],
          [poolB, tenantB],
        ] as const) {
          const current = await pool.query(
            'SELECT current_user AS role,current_schema() AS schema',
          );
          assert.equal(current.rows[0].role, tenant.role);
          assert.equal(current.rows[0].schema, tenant.appSchema);
          await pool.query(
            'CREATE TABLE fixture_records(id integer PRIMARY KEY,content text NOT NULL)',
          );
          await pool.query('INSERT INTO fixture_records VALUES(1,$1)', [
            `Fixture for ${tenant.ownerId}`,
          ]);
        }
        const denied = (action: () => Promise<unknown>) =>
          assert.rejects(action, { code: '42501' });
        await denied(() => poolA.query(`SELECT * FROM "${tenantB.appSchema}".fixture_records`));
        await denied(() => poolB.query(`SELECT * FROM "${tenantA.appSchema}".fixture_records`));
        await denied(() => poolA.query(`SET ROLE "${tenantB.role}"`));
        await denied(() => poolA.query(`SET ROLE "${decodeURIComponent(url.username)}"`));
        await denied(() => poolA.query('SELECT * FROM otto_control.tenants'));
        await denied(() => poolA.query('SELECT * FROM auth_fixture.sessions'));
        await denied(() => poolA.query('SELECT * FROM public.fixture_shared'));
        await denied(() => poolA.query('CREATE SCHEMA fixture_escape'));
        await denied(() => poolA.query('CREATE ROLE fixture_escape'));
        await denied(() => poolA.query('CREATE TEMP TABLE fixture_escape(id integer)'));
        await denied(() => poolA.query(`GRANT "${tenantB.role}" TO "${tenantA.role}"`));
        await denied(() =>
          poolA.query(`GRANT USAGE ON SCHEMA "${tenantB.appSchema}" TO "${tenantA.role}"`),
        );
        await denied(() =>
          poolA.query(
            `GRANT SELECT ON "${tenantB.appSchema}".fixture_records TO "${tenantA.role}"`,
          ),
        );
        await denied(() =>
          poolA.query(
            `ALTER DEFAULT PRIVILEGES FOR ROLE "${tenantB.role}" GRANT SELECT ON TABLES TO PUBLIC`,
          ),
        );
        await poolA.query(`CREATE FUNCTION fixture_attempt() RETURNS text
          LANGUAGE plpgsql SECURITY DEFINER SET search_path TO "${tenantB.appSchema}"
          AS $body$ BEGIN RETURN (SELECT content FROM fixture_records LIMIT 1); END $body$`);
        await assert.rejects(() => poolA.query('SELECT fixture_attempt()'), {
          code: '42P01',
        });
        await poolA.query('DROP FUNCTION fixture_attempt()');
        await denied(() =>
          poolA.query(
            `CREATE TABLE fixture_reference(id integer REFERENCES "${tenantB.appSchema}".fixture_records(id))`,
          ),
        );
        const connection = await poolA.connect();
        try {
          await connection.query(`SET search_path TO "${tenantB.appSchema}"`);
          await denied(() =>
            connection.query(`SELECT * FROM "${tenantB.appSchema}".fixture_records`),
          );
          await connection.query('RESET search_path');
        } finally {
          connection.release();
        }
        assert.equal(
          (await poolA.query('SELECT content FROM fixture_records')).rows[0].content,
          `Fixture for ${ownerA}`,
        );
        assert.equal(
          (await poolB.query('SELECT content FROM fixture_records')).rows[0].content,
          `Fixture for ${ownerB}`,
        );
      },
    );

    await t.test(
      'identically named pg-boss queues stay inside each login’s private jobs schema',
      async () => {
        for (const config of [configA, configB]) {
          const queue = new PgBoss({
            connectionString: config.databaseUrl,
            schema: config.jobsSchema,
            createSchema: false,
            max: 2,
            schedule: false,
            supervise: false,
          });
          queues.push(queue);
          await queue.start();
          await queue.createQueue('fixture-task');
          await queue.send('fixture-task', { owner: config.ownerId });
        }
        for (const [index, owner] of [ownerA, ownerB].entries()) {
          const jobs = await queues[index].fetch<{ owner: string }>('fixture-task');
          assert.equal(jobs.length, 1);
          assert.equal(jobs[0].data.owner, owner);
        }
        await assert.rejects(poolA.query(`SELECT * FROM "${tenantB.jobsSchema}".job`), {
          code: '42501',
        });
      },
    );

    await t.test(
      'leases serialize runtimes and fence expired owners and stale cleanup',
      async () => {
        assert.equal(await store.currentLease(ownerA), undefined);
        const first = await store.acquireLease(ownerA, randomUUID());
        assert.ok(first);
        assert.deepEqual(await store.currentLease(ownerA), first);
        assert.equal(await otherEnvironment.currentLease(ownerA), undefined);
        assert.equal(await store.acquireLease(ownerA, randomUUID()), undefined);
        const renewed = await store.renewLease(first);
        assert.equal(renewed?.generation, first.generation);
        assert.equal(await store.releaseLease({ ...first, holderId: randomUUID() }), false);
        await admin!.query(
          "UPDATE otto_control.tenants SET lease_expires=clock_timestamp()-interval '1 second' WHERE owner_id=$1 AND environment=$2",
          [ownerA, options.environment],
        );
        assert.equal(await store.renewLease(first), undefined);
        assert.equal(await store.currentLease(ownerA), undefined);
        const contenders = await Promise.all([
          store.acquireLease(ownerA, randomUUID()),
          store.acquireLease(ownerA, randomUUID()),
        ]);
        assert.equal(contenders.filter(Boolean).length, 1);
        const second = contenders.find(Boolean)!;
        assert.equal(BigInt(second.generation), BigInt(first.generation) + 1n);
        assert.equal(await store.releaseLease(first), false);
        assert.equal(await store.renewLease(first), undefined);
        await assert.rejects(otherEnvironment.renewLease(second), { code: 'invalid_identity' });
        assert.equal(await store.releaseLease(second), true);
        const third = await store.acquireLease(ownerA, second.holderId);
        assert.ok(third);
        assert.equal(BigInt(third.generation), BigInt(second.generation) + 1n);
        assert.equal(await store.releaseLease(second), false);
        assert.equal(await store.releaseLease(third), true);
        assert.equal(await store.currentLease(ownerA), undefined);
      },
    );

    await t.test(
      'unsafe role changes fail closed without returning runtime credentials',
      async () => {
        await root.query(`ALTER ROLE "${tenantA.role}" CREATEDB`);
        try {
          await assert.rejects(store.runtimeConfiguration(ownerA), { code: 'isolation_failed' });
          await assert.rejects(store.provision(ownerA), { code: 'isolation_failed' });
        } finally {
          await root.query(`ALTER ROLE "${tenantA.role}" NOCREATEDB`);
        }
        assert.equal((await store.runtimeConfiguration(ownerA)).ownerId, ownerA);
      },
    );
    const closingConnection = await admin.connect();
    closingConnection.release();
    const closeConnection = closingConnection.end.bind(closingConnection);
    t.mock.method(closingConnection, 'end', (callback?: () => void) => {
      setTimeout(() => closeConnection(callback ?? (() => {})), 100);
    });
  },
);
