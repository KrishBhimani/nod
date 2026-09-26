import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

const stub = `export class DurableObject { constructor(ctx,env) { this.ctx=ctx;this.env=env; } }
export class WorkerEntrypoint {}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers')
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const { default: worker, GatewayContainer, TenantContainer } = await import('../src/worker.ts');
const NativeRequest = Request;
Object.defineProperty(globalThis, 'Request', {
  configurable: true,
  value: class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init?.body ? ({ ...init, duplex: 'half' } as RequestInit) : init);
    }
  },
});

function fixture() {
  const ownerId = randomUUID();
  const calls: Array<{ target: string; request?: Request; input?: unknown }> = [];
  const identity = {
    ownerId,
    environment: 'development',
    generation: '1',
    configurationHash: 'fixture',
    stopped: false,
  };
  const id = (value: string) => ({ toString: () => value });
  const env = {
    SIDEKICK_ENVIRONMENT: 'development',
    SIDEKICK_PUBLIC_URL: 'https://sidekick.example.test',
    GATEWAY_ENV: '{}',
    GATEWAY: {
      idFromName: id,
      getByName(name: string) {
        assert.equal(name, 'gateway:development');
        return {
          async fetch(request: Request) {
            calls.push({ target: 'gateway', request });
            return new Response('gateway');
          },
          async wake() {
            calls.push({ target: 'wake' });
          },
        };
      },
    },
    TENANTS: {
      idFromName: id,
      idFromString: (value: string) => id(value),
      getByName(name: string) {
        return {
          async startRuntime(input: unknown) {
            calls.push({ target: name, input });
            return { ok: true, generation: '1' };
          },
          async stopRuntime(owner: string, generation: string) {
            calls.push({ target: name, input: { owner, generation } });
            return { ok: true, stopped: true };
          },
          async runtimeStatus() {
            return { generation: '1', stopped: false, status: 'healthy' };
          },
          async fetch(request: Request) {
            calls.push({ target: name, request });
            return new Response('tenant');
          },
        };
      },
      get() {
        return {
          async storageIdentity() {
            return identity;
          },
        };
      },
    },
    TENANT_FILES: {},
    ASSETS: {
      async fetch(request: Request) {
        calls.push({ target: 'assets', request });
        return new Response('assets');
      },
    },
  } as unknown as Parameters<typeof worker.fetch>[1];
  const gatewayContext = { containerId: 'gateway:development', className: 'GatewayContainer' };
  const tenantContext = {
    containerId: `tenant:development:${ownerId}`,
    className: 'TenantContainer',
  };
  return { env, calls, ownerId, gatewayContext, tenantContext };
}

test('public ingress removes actor credentials and never dispatches internal control or bootstrap', async () => {
  const { env, calls } = fixture();
  const ordinary = await worker.fetch(
    new Request('https://sidekick.example.test/api/state', {
      headers: {
        'x-sidekick-runtime': 'forged',
        'x-sidekick-runtime-extra': 'forged',
        cookie: 'session=fixture',
      },
    }),
    env,
  );
  assert.equal(await ordinary.text(), 'gateway');
  assert.equal(calls[0].request?.headers.has('x-sidekick-runtime'), false);
  assert.equal(calls[0].request?.headers.has('x-sidekick-runtime-extra'), false);
  assert.equal(calls[0].request?.headers.get('cookie'), 'session=fixture');
  for (const path of [
    '/runtime/start',
    '/runtime/stop',
    '/api/internal/channels/claim',
    '/__sidekick/start',
  ])
    assert.equal(
      (await worker.fetch(new Request(`https://sidekick.example.test${path}`), env)).status,
      404,
    );
  assert.equal(
    (await worker.fetch(new Request('https://foreign.example.test/api/state'), env)).status,
    403,
  );
  assert.equal(calls.length, 1);
});

test('runtime bootstrap requires the fixed trusted gateway and forwarding preserves signed targets', async () => {
  const { env, calls, ownerId, gatewayContext, tenantContext } = fixture();
  const outbound = GatewayContainer.outboundByHost!['sidekick.runtime'];
  for (const context of [tenantContext, { ...gatewayContext, containerId: 'other-gateway' }]) {
    const response = await outbound(
      new Request('http://sidekick.runtime/runtime/start', {
        method: 'POST',
        body: JSON.stringify({ ownerId, env: {} }),
      }),
      env,
      context,
    );
    assert.equal(response.status, 403);
  }
  assert.equal(calls.length, 0);
  const started = await outbound(
    new Request('http://sidekick.runtime/runtime/start', {
      method: 'POST',
      body: JSON.stringify({ ownerId, env: {} }),
    }),
    env,
    gatewayContext,
  );
  assert.equal(started.status, 200);
  const response = await outbound(
    new Request(`http://sidekick.runtime/${ownerId}/api/events?account=${ownerId}`, {
      headers: { 'x-sidekick-runtime': 'signed-fixture' },
    }),
    env,
    gatewayContext,
  );
  assert.equal(await response.text(), 'tenant');
  const forwarded = calls[1].request!;
  assert.equal(forwarded.url, `https://sidekick.example.test/api/events?account=${ownerId}`);
  assert.equal(forwarded.headers.get('host'), 'sidekick.example.test');
  assert.equal(forwarded.headers.get('x-sidekick-runtime'), 'signed-fixture');
});

test('tenant control permits only signed channel claims for the trusted owner', async () => {
  const { env, calls, ownerId, tenantContext } = fixture();
  const control = TenantContainer.outboundByHost!['sidekick.control'];
  const request = (path: string, owner = ownerId) =>
    new Request(`http://sidekick.control${path}`, {
      method: 'POST',
      body: '{"provider":"telegram","accountId":"123456"}',
      headers: {
        'content-type': 'application/json',
        'x-sidekick-owner': owner,
        'x-sidekick-runtime': 'signed-fixture',
        cookie: 'must-not-forward',
      },
    });
  assert.equal(
    (await control(request('/api/internal/channels/claim'), env, tenantContext)).status,
    200,
  );
  const forwarded = calls[0].request!;
  assert.equal(forwarded.headers.get('x-sidekick-owner'), ownerId);
  assert.equal(forwarded.headers.get('cookie'), null);
  assert.equal(forwarded.url, 'https://sidekick.example.test/api/internal/channels/claim');
  assert.equal(await forwarded.text(), '{"provider":"telegram","accountId":"123456"}');
  for (const path of [
    '/runtime/start',
    '/api/runtime/wake',
    '/api/internal/channels/claim?owner=other',
  ])
    assert.equal((await control(request(path), env, tenantContext)).status, 403);
  assert.equal(
    (await control(request('/api/internal/channels/claim', randomUUID()), env, tenantContext))
      .status,
    403,
  );
  assert.equal(calls.length, 1);
});

test('the scheduled wake targets only the configured gateway', async () => {
  const { env, calls } = fixture();
  await worker.scheduled({} as ScheduledController, env);
  assert.deepEqual(calls, [{ target: 'wake' }]);
});
