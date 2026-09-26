import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createTenantRuntimeHost } from '../src/server/runtime-host.ts';
import {
  createRuntimeVerifier,
  runtimeBodyHash,
  runtimeHeader,
} from '../src/server/runtime-auth.ts';
import type { RuntimeConfiguration } from '../src/ports/runtime-transport.ts';
import type { TenantLease } from '../src/server/tenants.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Fixture did not reach the expected boundary.')),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fixture(
  t: TestContext,
  heartbeatMs = 15_000,
  diagnostics: { enabled?: boolean; developers?: ReadonlySet<string> } = {},
) {
  const masterKey = randomBytes(32);
  const leases = new Map<string, TenantLease>();
  const generations = new Map<string, number>();
  const actors = new Map<string, string>();
  const starts: RuntimeConfiguration[] = [];
  const stops: { ownerId: string; generation: string }[] = [];
  const releases: TenantLease[] = [];
  const requests: { ownerId: string; request: Request }[] = [];
  const hooks: {
    start?: (configuration: RuntimeConfiguration) => Promise<void>;
    stop?: (ownerId: string, generation: string) => Promise<void>;
    renew?: (lease: TenantLease) => Promise<TenantLease | undefined>;
    denyLease?: boolean;
  } = {};
  let closes = 0;
  const record = (ownerId: string) => ({
    ownerId,
    environment: 'development',
    role: `role_${ownerId}`,
    appSchema: 'app',
    jobsSchema: 'jobs',
    credentialVersion: 1,
  });
  const host = createTenantRuntimeHost({
    masterKey,
    environment: 'development',
    heartbeatMs,
    developerIds: diagnostics.developers,
    operatorEnvironment: {
      DEV_INSPECTOR: String(diagnostics.enabled ?? false),
      SIDEKICK_PUBLIC_URL: 'https://sidekick.example.test',
      SIDEKICK_RUNTIME_URL: 'http://sidekick.runtime',
      SIDEKICK_MASTER_KEY: 'synthetic-master-key',
      AUTH_SECRET: 'synthetic-auth-secret',
      GOOGLE_CLIENT_SECRET: 'synthetic-google-secret',
      DATABASE_URL: 'postgresql://operator:private@db.example.test/control',
      OPENAI_API_KEY: 'synthetic-server-provider-key',
      COMPUTER_PROVIDER: 'e2b',
      OBJECT_STORAGE_ROOT: '/private/sidekick-files',
    },
    tenants: {
      async provision(ownerId) {
        return record(ownerId);
      },
      async runtimeConfiguration(ownerId) {
        return {
          ...record(ownerId),
          databaseUrl: `postgresql://${ownerId}:synthetic@db.example.test/tenant`,
          poolMax: 4,
        };
      },
      async acquireLease(ownerId, holderId, duration = 60_000) {
        if (
          hooks.denyLease ||
          (leases.has(ownerId) && Date.parse(leases.get(ownerId)!.expiresAt) > Date.now())
        )
          return undefined;
        const generation = (generations.get(ownerId) ?? 0) + 1;
        generations.set(ownerId, generation);
        const lease = {
          ownerId,
          holderId,
          environment: 'development',
          generation: String(generation),
          expiresAt: new Date(Date.now() + duration).toISOString(),
        };
        leases.set(ownerId, lease);
        return lease;
      },
      async renewLease(lease) {
        if (hooks.renew) return hooks.renew(lease);
        return { ...lease, expiresAt: new Date(Date.now() + 60_000).toISOString() };
      },
      async releaseLease(lease) {
        releases.push(lease);
        if (leases.get(lease.ownerId)?.generation !== lease.generation) return false;
        leases.delete(lease.ownerId);
        return true;
      },
    },
    transport: {
      async status(ownerId) {
        return { generation: actors.get(ownerId) ?? null, stopped: !actors.has(ownerId) };
      },
      async start(configuration) {
        starts.push(configuration);
        actors.set(configuration.ownerId, configuration.generation);
        await hooks.start?.(configuration);
      },
      async stop(ownerId, generation) {
        stops.push({ ownerId, generation });
        await hooks.stop?.(ownerId, generation);
        if (actors.get(ownerId) === generation) actors.delete(ownerId);
      },
      async fetch(ownerId, request) {
        requests.push({ ownerId, request });
        return Response.json({ ownerId });
      },
      async close() {
        closes++;
      },
    },
  });
  t.after(() => host.close().catch(() => {}));
  const request = (ownerId: string) =>
    host.fetch(ownerId, new Request('https://sidekick.example.test/api/state'), {
      developer: false,
    });
  return {
    host,
    leases,
    actors,
    starts,
    stops,
    releases,
    requests,
    hooks,
    request,
    closes: () => closes,
  };
}

test('runtime diagnostics require both operator capture and an assigned developer owner', async (t) => {
  const developer = randomUUID();
  const ordinaryUser = randomUUID();
  const enabled = fixture(t, 15_000, { enabled: true, developers: new Set([developer]) });
  await enabled.request(developer);
  await enabled.request(ordinaryUser);
  assert.equal(enabled.starts[0].environment.DEV_INSPECTOR, 'true');
  assert.equal(enabled.starts[1].environment.DEV_INSPECTOR, 'false');
  const disabled = fixture(t, 15_000, { enabled: false, developers: new Set([developer]) });
  await disabled.request(developer);
  assert.equal(disabled.starts[0].environment.DEV_INSPECTOR, 'false');
});

test('runtime startup is shared per owner while different owners retain separate credentials and signatures', async (t) => {
  const f = fixture(t);
  const first = randomUUID();
  const second = randomUUID();
  const entered = deferred();
  const ready = deferred();
  f.hooks.start = async (configuration) => {
    if (configuration.ownerId === first) {
      entered.resolve();
      await ready.promise;
    }
  };
  const waiting = Array.from({ length: 8 }, () => f.request(first));
  try {
    await bounded(entered.promise);
    assert.equal((await f.request(second)).status, 200);
    assert.equal(f.starts.length, 2);
  } finally {
    ready.resolve();
  }
  assert.equal(
    (await Promise.all(waiting)).every((response) => response.status === 200),
    true,
  );
  assert.equal(f.starts.filter((start) => start.ownerId === first).length, 1);
  const [a, b] = f.starts;
  for (const key of [
    'SIDEKICK_RUNTIME_SECRET',
    'SIDEKICK_VAULT_KEY',
    'DATABASE_URL',
    'SIDEKICK_TELEGRAM_WEBHOOK_URL',
  ])
    assert.notEqual(a.environment[key], b.environment[key]);
  for (const configuration of f.starts) {
    assert.equal(configuration.environment.SIDEKICK_OWNER_ID, configuration.ownerId);
    assert.equal(configuration.environment.SIDEKICK_CONTROL_URL, 'http://sidekick.control');
    assert.equal(configuration.environment.OPENAI_API_KEY, 'synthetic-server-provider-key');
    assert.equal(configuration.environment.DEV_INSPECTOR, 'false');
    assert.equal(
      configuration.environment.OBJECT_STORAGE_ROOT,
      `/private/sidekick-files/${configuration.ownerId}`,
    );
    for (const key of ['SIDEKICK_MASTER_KEY', 'AUTH_SECRET', 'GOOGLE_CLIENT_SECRET'])
      assert.equal(configuration.environment[key], undefined);
    assert.ok(configuration.environment.DATABASE_URL.includes(configuration.ownerId));
  }
  const body = JSON.stringify({ text: 'synthetic task' });
  await f.host.fetch(
    first,
    new Request('https://sidekick.example.test/api/messages?cursor=one%2Ftwo', {
      method: 'POST',
      body,
      headers: {
        cookie: 'private-cookie',
        authorization: 'Bearer private',
        host: 'untrusted.test',
        'x-sidekick-account': second,
        [runtimeHeader]: 'forged',
        'content-type': 'application/json',
      },
    }),
    { developer: true },
  );
  const forwarded = f.requests.at(-1)!;
  for (const name of ['cookie', 'authorization', 'host', 'x-sidekick-account'])
    assert.equal(forwarded.request.headers.get(name), null);
  const context = {
    secret: a.environment.SIDEKICK_RUNTIME_SECRET,
    ownerId: first,
    environment: 'development',
    generation: a.generation,
  };
  const claims = createRuntimeVerifier(context).verify(
    forwarded.request.headers.get(runtimeHeader),
    'POST',
    '/api/messages?cursor=one%2Ftwo',
  );
  assert.equal(claims?.bodyHash, runtimeBodyHash(Buffer.from(body)));
  assert.equal(claims?.developer, true);
  assert.equal(claims?.kind, 'user');
  assert.equal(await forwarded.request.text(), body);
  assert.equal(
    createRuntimeVerifier({
      ...context,
      ownerId: second,
      secret: b.environment.SIDEKICK_RUNTIME_SECRET,
    }).verify(
      forwarded.request.headers.get(runtimeHeader),
      'POST',
      '/api/messages?cursor=one%2Ftwo',
    ),
    null,
  );
});

test('an unavailable lease never starts or addresses an actor', async (t) => {
  const f = fixture(t);
  f.hooks.denyLease = true;
  await assert.rejects(f.request(randomUUID()), /restarting/);
  assert.equal(f.starts.length, 0);
  assert.equal(f.requests.length, 0);
});

test('failed startup cleans up only its generation and a retry obtains a new lease', async (t) => {
  const f = fixture(t);
  const owner = randomUUID();
  f.actors.set(owner, 'previous');
  f.hooks.start = async () => {
    throw new Error('private transport detail');
  };
  await assert.rejects(f.request(owner), (error) => {
    assert.equal(
      (error as Error).message,
      'The account runtime could not start. Try again shortly.',
    );
    return true;
  });
  assert.deepEqual(
    f.stops.map((stop) => stop.generation),
    ['previous', '1'],
  );
  assert.equal(f.releases.length, 1);
  assert.equal(f.leases.has(owner), false);
  f.hooks.start = undefined;
  assert.equal((await f.request(owner)).status, 200);
  assert.equal(f.starts.at(-1)!.generation, '2');
});

test('shutdown waits for startup, rejects late readiness and closes once', async (t) => {
  const f = fixture(t);
  const owner = randomUUID();
  const entered = deferred();
  const ready = deferred();
  f.hooks.start = async () => {
    entered.resolve();
    await ready.promise;
  };
  const request = assert.rejects(f.request(owner), /could not start/);
  await bounded(entered.promise);
  const closing = f.host.close();
  const again = f.host.close();
  await setImmediate();
  assert.equal(f.closes(), 0);
  ready.resolve();
  await Promise.all([request, closing, again]);
  assert.equal(f.requests.length, 0);
  assert.equal(f.stops.length, 1);
  assert.equal(f.releases.length, 1);
  assert.equal(f.closes(), 1);
  await assert.rejects(f.request(owner), /unavailable/);
});

test('a request body that finishes after shutdown cannot reach a stopped actor', async (t) => {
  const f = fixture(t);
  const owner = randomUUID();
  await f.request(owner);
  const entered = deferred();
  const body = deferred<ArrayBuffer>();
  const request = new Request('https://sidekick.example.test/api/messages', {
    method: 'POST',
    body: '{}',
  });
  request.arrayBuffer = () => {
    entered.resolve();
    return body.promise;
  };
  const result = assert.rejects(f.host.fetch(owner, request, { developer: false }), /unavailable/);
  await bounded(entered.promise);
  await f.host.close();
  body.resolve(new ArrayBuffer(0));
  await result;
  assert.equal(f.requests.length, 1);
  assert.equal(f.closes(), 1);
});

test('shutdown drains in-flight renewal and never sends a lease heartbeat after transport closes', async (t) => {
  const f = fixture(t, 100);
  const owner = randomUUID();
  const entered = deferred();
  const renewal = deferred<TenantLease>();
  f.hooks.renew = async () => {
    entered.resolve();
    return renewal.promise;
  };
  await f.request(owner);
  await bounded(entered.promise);
  const closing = f.host.close();
  await setImmediate();
  assert.equal(f.closes(), 0);
  renewal.resolve({
    ...f.leases.get(owner)!,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await closing;
  assert.equal(f.requests.length, 1);
  assert.equal(f.releases.length, 1);
  assert.equal(f.stops.length, 1);
  assert.equal(f.closes(), 1);
});

test('lease loss retains ownership until stop succeeds and concurrent retries create one replacement', async (t) => {
  const f = fixture(t, 100);
  const owner = randomUUID();
  const failedStop = deferred();
  f.hooks.renew = async () => undefined;
  f.hooks.stop = async () => {
    failedStop.resolve();
    throw new Error('private stop detail');
  };
  await f.request(owner);
  await bounded(failedStop.promise);
  await setImmediate();
  assert.equal(f.releases.length, 0);
  assert.ok(f.leases.has(owner));
  f.hooks.stop = undefined;
  f.hooks.renew = undefined;
  assert.ok(
    (await Promise.all(Array.from({ length: 8 }, () => f.request(owner)))).every(
      (response) => response.ok,
    ),
  );
  assert.equal(f.starts.length, 2);
  assert.equal(f.releases.length, 1);
  assert.equal(f.starts[1].generation, '2');
});
