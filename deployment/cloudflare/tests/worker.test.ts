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

function processFixture(
  role: 'gateway' | 'tenant',
  respond: (url: URL, request: Request) => Promise<Response> = async () => new Response('ready'),
) {
  let status = 'healthy';
  let starts = 0;
  let forwards = 0;
  let startupError: Error | undefined;
  const container = {
    running: true,
    getTcpPort(port: number) {
      assert.equal(port, 4310);
      return {
        async fetch(url: URL, request: Request) {
          forwards++;
          return respond(url, request);
        },
      };
    },
  };
  const { env } = fixture();
  env.GATEWAY_ENV = JSON.stringify({ SIDEKICK_BIND_HOST: '127.0.0.1' });
  const instance = Object.assign(
    Object.create(role === 'gateway' ? GatewayContainer.prototype : TenantContainer.prototype),
    {
      ctx: { container },
      env,
      defaultPort: 4310,
      lifecycle: { async identity() {} },
      async getState() {
        return { status };
      },
      async startAndWaitForPorts() {
        starts++;
        if (startupError) throw startupError;
        container.running = true;
        status = 'healthy';
      },
      renewActivityTimeout() {},
      async containerFetch() {
        assert.fail('HTTP must not enter the SDK response-error conversion path');
      },
    },
  ) as InstanceType<typeof GatewayContainer> | InstanceType<typeof TenantContainer>;
  const publicEnv = {
    ...env,
    GATEWAY: { getByName: () => instance },
  } as unknown as Parameters<typeof worker.fetch>[1];
  return {
    instance,
    container,
    publicEnv,
    counts: () => ({ starts, forwards }),
    stop() {
      container.running = false;
      status = 'stopped';
    },
    failStartup() {
      startupError = new Error('synthetic private startup configuration');
    },
  };
}

test('gateway forces the actual Node bind setting and safely restarts after becoming ready', async () => {
  const current = processFixture('gateway');
  const request = () => new Request('https://sidekick.example.test/api/health');
  assert.equal((await worker.fetch(request(), current.publicEnv)).status, 200);
  assert.equal((current.instance.envVars as Record<string, string>).SIDEKICK_BIND_HOST, '0.0.0.0');
  assert.deepEqual(current.counts(), { starts: 1, forwards: 1 });
  current.stop();
  assert.equal((await worker.fetch(request(), current.publicEnv)).status, 200);
  assert.deepEqual(current.counts(), { starts: 2, forwards: 2 });
  current.stop();
  current.failStartup();
  const failed = await worker.fetch(request(), current.publicEnv);
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await failed.json(), {
    error: 'This request could not be completed. Try again.',
  });
  assert.deepEqual(current.counts(), { starts: 3, forwards: 2 });
});

test('anonymous gateway startup and both TCP proxy failures return fixed errors', async () => {
  const unavailable = processFixture('gateway');
  unavailable.failStartup();
  const initial = await worker.fetch(
    new Request('https://sidekick.example.test/api/session'),
    unavailable.publicEnv,
  );
  assert.equal(initial.status, 503);
  assert.doesNotMatch(await initial.text(), /synthetic|startup|configuration/);
  for (const role of ['gateway', 'tenant'] as const) {
    const current = processFixture(role, async () => {
      throw new Error('synthetic private upstream credential');
    });
    const response = await current.instance.fetch(
      new Request('https://sidekick.example.test/api/events'),
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      error: 'This request could not be completed. Try again.',
    });
  }
});

test('container forwarding preserves application status, body, cookies and streaming', async () => {
  for (const role of ['gateway', 'tenant'] as const)
    for (const status of [401, 429, 500, 503]) {
      const application = new Response(`application response ${status}`, {
        status,
        headers: { 'set-cookie': 'synthetic-session=accepted; HttpOnly', 'retry-after': '12' },
      });
      const current = processFixture(role, async (url, request) => {
        assert.equal(url.href, 'http://sidekick.example.test/api/session?fresh=true');
        assert.equal(request.headers.get('x-sidekick-account'), 'fixture-account');
        return application;
      });
      const response = await current.instance.fetch(
        new Request('https://sidekick.example.test/api/session?fresh=true', {
          headers: { 'x-sidekick-account': 'fixture-account' },
        }),
      );
      assert.equal(response, application);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('retry-after'), '12');
      assert.equal(response.headers.get('set-cookie'), 'synthetic-session=accepted; HttpOnly');
      assert.equal(await response.text(), `application response ${status}`);
    }
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const application = new Response(stream.readable, {
    headers: { 'content-type': 'text/event-stream' },
  });
  const current = processFixture('gateway', async () => application);
  const response = await current.instance.fetch(
    new Request('https://sidekick.example.test/api/events'),
  );
  assert.equal(response, application);
  const reader = response.body!.getReader();
  const writer = stream.writable.getWriter();
  const chunk = new TextEncoder().encode('data: fixture\n\n');
  const write = writer.write(chunk);
  assert.deepEqual((await reader.read()).value, chunk);
  await write;
  await reader.cancel();
  await writer.closed.catch(() => {});
});

test('tenant forwarding never starts a stopped actor or restarts one lost during dispatch', async () => {
  const stopped = processFixture('tenant');
  stopped.stop();
  assert.equal(
    (await stopped.instance.fetch(new Request('https://sidekick.example.test/api/state'))).status,
    503,
  );
  assert.deepEqual(stopped.counts(), { starts: 0, forwards: 0 });
  const lost = processFixture('tenant');
  Object.assign(lost.instance, {
    async getState() {
      lost.container.running = false;
      return { status: 'healthy' };
    },
  });
  assert.equal(
    (await lost.instance.fetch(new Request('https://sidekick.example.test/api/state'))).status,
    503,
  );
  assert.deepEqual(lost.counts(), { starts: 0, forwards: 0 });
});
