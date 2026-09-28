import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTenantChannelRegistry, createTenantControl } from '../src/server/tenant-control.ts';
import { ChannelAccountRegistryError } from '../src/server/channel-account-registry.ts';
import {
  deriveRuntimeSecret,
  runtimeHeader,
  signRuntimeRequest,
} from '../src/server/runtime-auth.ts';
import type { ChannelAccountIdentity } from '../src/ports/channel-settings.ts';
import type { TenantLease } from '../src/server/tenants.ts';

function fixture() {
  const masterKey = randomBytes(32);
  const environment = 'development';
  const leases = new Map<string, TenantLease>();
  let leaseReads = 0;
  const writes: { action: string; input: ChannelAccountIdentity; lease: TenantLease }[] = [];
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  for (const ownerId of [ownerA, ownerB])
    leases.set(ownerId, {
      ownerId,
      environment,
      holderId: randomUUID(),
      generation: '1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  function guard(lease: TenantLease) {
    const current = leases.get(lease.ownerId);
    if (
      !current ||
      current.generation !== lease.generation ||
      current.holderId !== lease.holderId ||
      Date.parse(current.expiresAt) <= Date.now()
    )
      throw new ChannelAccountRegistryError('invalid_lease');
  }
  const handle = createTenantControl({
    masterKey,
    environment,
    currentLease: async (owner) => {
      leaseReads++;
      return leases.get(owner);
    },
    accounts: {
      async claimWithLease(input, lease) {
        guard(lease);
        writes.push({ action: 'claim', input, lease });
        return true;
      },
      async releaseWithLease(input, lease) {
        guard(lease);
        writes.push({ action: 'release', input, lease });
      },
    },
  });
  function request(
    ownerId = ownerA,
    options: {
      path?: string;
      method?: string;
      payload?: unknown;
      body?: string;
      headerOwner?: string;
      generation?: string;
      kind?: 'user' | 'wake' | 'webhook';
      developer?: boolean;
    } = {},
  ) {
    const method = options.method ?? 'POST';
    const path = options.path ?? '/api/internal/channels/claim';
    const bytes = Buffer.from(
      JSON.stringify(
        options.payload ?? { provider: 'telegram', accountId: '12345', revision: '1' },
      ),
    );
    const token = signRuntimeRequest({
      secret: deriveRuntimeSecret(masterKey, environment, ownerId),
      ownerId,
      environment,
      generation: options.generation ?? leases.get(ownerId)!.generation,
      method,
      target: path,
      body: bytes,
      developer: options.developer ?? false,
      kind: options.kind ?? 'wake',
    });
    return new Request(`http://otto.control${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-otto-owner': options.headerOwner ?? ownerId,
        [runtimeHeader]: token,
      },
      ...(!['GET', 'HEAD'].includes(method) ? { body: options.body ?? bytes } : {}),
    });
  }
  return {
    handle,
    request,
    leases,
    writes,
    ownerA,
    ownerB,
    masterKey,
    environment,
    leaseReads: () => leaseReads,
  };
}

test('control signatures bind the owner and lease while account bodies cannot select an owner', async () => {
  const f = fixture();
  const first = await f.handle(f.request());
  const second = await f.handle(f.request(f.ownerB, { path: '/api/internal/channels/release' }));
  assert.deepEqual(await first.json(), { claimed: true });
  assert.deepEqual(await second.json(), { ok: true });
  assert.deepEqual(
    f.writes.map((write) => [write.action, write.input.ownerId, write.lease.ownerId]),
    [
      ['claim', f.ownerA, f.ownerA],
      ['release', f.ownerB, f.ownerB],
    ],
  );
  assert.equal((await f.handle(f.request(f.ownerA, { headerOwner: f.ownerB }))).status, 401);
  assert.equal(
    (
      await f.handle(
        f.request(f.ownerA, {
          payload: { provider: 'telegram', accountId: '12345', ownerId: f.ownerB },
        }),
      )
    ).status,
    400,
  );
  assert.equal(f.writes.length, 2);
});

test('control denies changed bodies, replay, wrong capabilities and nonexact routes', async () => {
  const f = fixture();
  const request = f.request();
  assert.equal((await f.handle(request.clone())).status, 200);
  assert.equal((await f.handle(request.clone())).status, 401);
  for (const options of [
    { body: '{"provider":"telegram","accountId":"changed"}' },
    { kind: 'user' as const },
    { kind: 'webhook' as const },
    { developer: true },
    { method: 'GET' },
    { path: '/api/internal/channels/claim?owner=other' },
    { path: '/api/internal/channels/%63laim' },
    { path: '/api/internal/channels/claim/' },
    { path: '/api/internal/channels//claim' },
    { path: '/api/internal/channels/unknown' },
    { payload: { provider: 'telegram', accountId: 'x'.repeat(5000) } },
  ])
    assert.equal((await f.handle(f.request(f.ownerA, options))).status, 401);
  const unsigned = f.request();
  unsigned.headers.delete(runtimeHeader);
  assert.equal((await f.handle(unsigned)).status, 401);
  assert.equal(f.writes.length, 1);
});

test('control rejects old generations and passes the exact lease to the atomic mutation guard', async () => {
  const f = fixture();
  const old = f.request();
  f.leases.set(f.ownerA, { ...f.leases.get(f.ownerA)!, holderId: randomUUID(), generation: '2' });
  assert.equal((await f.handle(old)).status, 401);
  assert.equal((await f.handle(f.request())).status, 200);
  assert.equal(f.writes[0].lease.generation, '2');
  const signed = f.request();
  const bytes = new Uint8Array(await signed.arrayBuffer());
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let complete!: () => void;
  const ready = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const slow = new Request(signed.url, {
    method: 'POST',
    headers: signed.headers,
    body: new ReadableStream(
      {
        async pull(controller) {
          entered();
          await ready;
          controller.enqueue(bytes);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
    duplex: 'half',
  } as RequestInit);
  const rejected = assert.rejects(f.handle(slow), { code: 'invalid_lease', statusCode: 401 });
  try {
    await Promise.race([
      reading,
      rejected.then(() => assert.fail('Control did not read the body.')),
    ]);
    f.leases.set(f.ownerA, { ...f.leases.get(f.ownerA)!, holderId: randomUUID(), generation: '3' });
  } finally {
    complete();
  }
  await rejected;
  assert.equal(f.writes.length, 1);
  f.leases.get(f.ownerA)!.expiresAt = new Date(0).toISOString();
  assert.equal((await f.handle(f.request())).status, 401);
  f.leases.delete(f.ownerB);
  assert.equal((await f.handle(f.request(f.ownerB, { generation: '1' }))).status, 401);
});

test('tenant channel clients sign exact control requests and cannot delegate another owner', async () => {
  const f = fixture();
  const requests: Request[] = [];
  const registry = createTenantChannelRegistry({
    origin: 'http://otto.control',
    ownerId: f.ownerA,
    environment: f.environment,
    generation: '1',
    secret: deriveRuntimeSecret(f.masterKey, f.environment, f.ownerA),
    fetch: async (input, init) => {
      assert.equal(init?.redirect, 'manual');
      assert.ok(init?.signal);
      const request = new Request(input, init);
      requests.push(request.clone());
      return f.handle(request);
    },
  });
  const input = {
    ownerId: f.ownerA,
    provider: 'telegram' as const,
    accountId: '12345',
    revision: '1',
  };
  assert.equal(await registry.claim(input), true);
  await registry.release(input);
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    ['/api/internal/channels/claim', '/api/internal/channels/release'],
  );
  for (const request of requests) {
    assert.equal(request.headers.get('cookie'), null);
    assert.equal(request.headers.get('authorization'), null);
    assert.deepEqual(await request.json(), {
      provider: 'telegram',
      accountId: '12345',
      revision: '1',
    });
  }
  await assert.rejects(registry.claim({ ...input, ownerId: f.ownerB }), /owner is invalid/);
  await assert.rejects(registry.release({ ...input, ownerId: f.ownerB }), /owner is invalid/);
  assert.equal(requests.length, 2);
});

test('control client failures do not expose redirect targets or provider responses', async () => {
  const f = fixture();
  const registry = createTenantChannelRegistry({
    origin: 'http://otto.control',
    ownerId: f.ownerA,
    environment: f.environment,
    generation: '1',
    secret: deriveRuntimeSecret(f.masterKey, f.environment, f.ownerA),
    fetch: async () =>
      new Response('synthetic private provider detail', {
        status: 302,
        headers: { location: 'https://private.example.test/secret' },
      }),
  });
  await assert.rejects(
    registry.claim({ ownerId: f.ownerA, provider: 'telegram', accountId: '12345', revision: '1' }),
    (error) => {
      assert.equal((error as Error).message, 'Channel ownership could not be checked.');
      return true;
    },
  );
});

test('unsigned and altered control signatures cannot query lease state', async () => {
  const f = fixture();
  for (const token of [null, 'forged', f.request(f.ownerB).headers.get(runtimeHeader)]) {
    const request = f.request();
    if (token === null) request.headers.delete(runtimeHeader);
    else request.headers.set(runtimeHeader, token);
    assert.equal((await f.handle(request)).status, 401);
  }
  assert.equal(f.leaseReads(), 0);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.handle(f.request())).status, 200);
  assert.equal(f.leaseReads(), 1);
});

test('control reads stop when streamed input exceeds the authenticated body limit', async () => {
  const f = fixture();
  const signed = f.request();
  let reads = 0;
  let cancelled = false;
  const request = new Request(signed.url, {
    method: 'POST',
    headers: signed.headers,
    body: new ReadableStream(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(4097));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    duplex: 'half',
  } as RequestInit);
  assert.equal((await f.handle(request)).status, 401);
  assert.equal(reads, 1);
  assert.equal(cancelled, true);
  assert.equal(f.writes.length, 0);
});

test('control rejects missing and out-of-range channel revisions without a registry mutation', async () => {
  const f = fixture();
  for (const revision of [undefined, '', '-1', '1.5', '9223372036854775808']) {
    const response = await f.handle(
      f.request(f.ownerA, {
        payload: { provider: 'telegram', accountId: '12345', revision },
      }),
    );
    assert.equal(response.status, 400);
  }
  assert.equal(f.writes.length, 0);
});
