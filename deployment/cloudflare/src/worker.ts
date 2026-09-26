import { Container, ContainerProxy, type OutboundHandler } from '@cloudflare/containers';
import { createTenantLifecycle } from './lifecycle.ts';
import {
  controlBody,
  environmentName,
  environmentValues,
  failure,
  ownerIdentity,
  RuntimeControlError,
  type TenantIdentity,
} from './protocol.ts';
import { storageRequest } from './storage.ts';

export { ContainerProxy };

export interface Bindings {
  GATEWAY: DurableObjectNamespace<GatewayContainer>;
  TENANTS: DurableObjectNamespace<TenantContainer>;
  TENANT_FILES: R2Bucket;
  ASSETS: Fetcher;
  GATEWAY_ENV: string;
  SIDEKICK_ENVIRONMENT: string;
  SIDEKICK_PUBLIC_URL: string;
}

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {}
  }
}

function gatewayName(env: Bindings) {
  return `gateway:${environmentName(env.SIDEKICK_ENVIRONMENT)}`;
}

function tenantName(env: Bindings, ownerId: string) {
  return `tenant:${environmentName(env.SIDEKICK_ENVIRONMENT)}:${ownerIdentity(ownerId)}`;
}

function publicOrigin(env: Bindings) {
  const url = new URL(env.SIDEKICK_PUBLIC_URL);
  if (
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new RuntimeControlError(503);
  return url.origin;
}

const runtimeOutbound: OutboundHandler<Bindings> = async (request, env, context) => {
  try {
    if (
      context.className !== 'GatewayContainer' ||
      context.containerId !== env.GATEWAY.idFromName(gatewayName(env)).toString()
    )
      throw new RuntimeControlError(403);
    const url = new URL(request.url);
    if (url.pathname === '/runtime/start' && request.method === 'POST') {
      const input = await controlBody(request);
      const ownerId = ownerIdentity((input as { ownerId?: unknown } | null)?.ownerId);
      const tenant = env.TENANTS.getByName(tenantName(env, ownerId));
      return Response.json(await tenant.startRuntime(input), {
        headers: { 'cache-control': 'no-store' },
      });
    }
    if (url.pathname === '/runtime/stop' && request.method === 'POST') {
      const input = (await controlBody(request)) as { ownerId?: unknown; generation?: unknown };
      const ownerId = ownerIdentity(input?.ownerId);
      const tenant = env.TENANTS.getByName(tenantName(env, ownerId));
      return Response.json(await tenant.stopRuntime(ownerId, input.generation), {
        headers: { 'cache-control': 'no-store' },
      });
    }
    if (url.pathname === '/runtime/status' && request.method === 'POST') {
      const input = (await controlBody(request)) as { ownerId?: unknown };
      const ownerId = ownerIdentity(input?.ownerId);
      const tenant = env.TENANTS.getByName(tenantName(env, ownerId));
      return Response.json(await tenant.runtimeStatus(), {
        headers: { 'cache-control': 'no-store' },
      });
    }
    const match = /^\/([^/]+)(\/api\/.*)$/.exec(url.pathname);
    if (!match) throw new RuntimeControlError(404);
    const ownerId = ownerIdentity(match[1]);
    if (!request.headers.has('x-sidekick-runtime')) throw new RuntimeControlError(401);
    const target = new URL(publicOrigin(env));
    target.pathname = match[2];
    target.search = url.search;
    const forwarded = new Request(target, request);
    forwarded.headers.set('host', target.host);
    return await env.TENANTS.getByName(tenantName(env, ownerId)).fetch(forwarded);
  } catch (error) {
    return failure(error);
  }
};

const storageOutbound: OutboundHandler<Bindings> = async (request, env, context) => {
  try {
    if (context.className !== 'TenantContainer') throw new RuntimeControlError(403);
    const tenant = env.TENANTS.get(env.TENANTS.idFromString(context.containerId));
    const identity = await tenant.storageIdentity();
    if (
      identity.environment !== env.SIDEKICK_ENVIRONMENT ||
      context.containerId !== env.TENANTS.idFromName(tenantName(env, identity.ownerId)).toString()
    )
      throw new RuntimeControlError(403);
    return await storageRequest(request, identity, env.TENANT_FILES);
  } catch (error) {
    return failure(error);
  }
};

const controlOutbound: OutboundHandler<Bindings> = async (request, env, context) => {
  try {
    const url = new URL(request.url);
    if (
      context.className !== 'TenantContainer' ||
      request.method !== 'POST' ||
      url.search ||
      !['/api/internal/channels/claim', '/api/internal/channels/release'].includes(url.pathname)
    )
      throw new RuntimeControlError(403);
    const tenant = env.TENANTS.get(env.TENANTS.idFromString(context.containerId));
    const identity = await tenant.storageIdentity();
    if (
      identity.environment !== env.SIDEKICK_ENVIRONMENT ||
      context.containerId !==
        env.TENANTS.idFromName(tenantName(env, identity.ownerId)).toString() ||
      request.headers.get('x-sidekick-owner') !== identity.ownerId ||
      !request.headers.has('x-sidekick-runtime')
    )
      throw new RuntimeControlError(403);
    const target = new URL(url.pathname, publicOrigin(env));
    const headers = new Headers({ host: target.host, 'x-sidekick-owner': identity.ownerId });
    for (const name of ['content-type', 'x-sidekick-runtime']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    return await env.GATEWAY.getByName(gatewayName(env)).fetch(
      new Request(target, {
        method: 'POST',
        headers,
        body: request.body,
      }),
    );
  } catch (error) {
    return failure(error);
  }
};

export class GatewayContainer extends Container<Bindings> {
  defaultPort = 4310;
  sleepAfter = '10m';
  enableInternet = true;
  private ready: Promise<void> | undefined;

  override async onActivityExpired() {}

  async wake() {
    const response = await this.fetch(
      new Request(`${publicOrigin(this.env)}/api/health`, {
        headers: { host: new URL(publicOrigin(this.env)).host },
      }),
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error('The gateway recovery check failed.');
  }

  override async fetch(request: Request) {
    try {
      this.ready ??= this.configure().catch((error) => {
        this.ready = undefined;
        throw error;
      });
      await this.ready;
      return await this.containerFetch(request);
    } catch (error) {
      return failure(error);
    }
  }

  private async configure() {
    const configured = environmentValues(JSON.parse(this.env.GATEWAY_ENV));
    this.envVars = {
      ...configured,
      SIDEKICK_MODE: 'gateway',
      SIDEKICK_ENVIRONMENT: environmentName(this.env.SIDEKICK_ENVIRONMENT),
      SIDEKICK_PUBLIC_URL: publicOrigin(this.env),
      SIDEKICK_RUNTIME_URL: 'http://sidekick.runtime',
      SIDEKICK_DATA_ROOT: '/data',
      NODE_ENV: 'production',
      PORT: '4310',
      HOST: '0.0.0.0',
    };
    await this.startAndWaitForPorts();
  }

  override onError() {
    throw new Error('The gateway is temporarily unavailable.');
  }
}

export class TenantContainer extends Container<Bindings> {
  defaultPort = 4310;
  sleepAfter = '10m';
  enableInternet = true;
  envVars = { SIDEKICK_MODE: 'tenant', NODE_ENV: 'production' };

  override async onActivityExpired() {}
  private lifecycle = createTenantLifecycle({
    environment: environmentName(this.env.SIDEKICK_ENVIRONMENT),
    read: () => this.ctx.storage.get<TenantIdentity>('identity'),
    write: (identity) => this.ctx.storage.put('identity', identity),
    status: async () => (await this.getState()).status,
    start: (envVars) => this.startAndWaitForPorts({ startOptions: { envVars } }),
    stop: async () => {
      await this.stop();
    },
  });

  async startRuntime(input: unknown) {
    const ownerId = ownerIdentity((input as { ownerId?: unknown } | null)?.ownerId);
    if (
      this.ctx.id.toString() !==
      this.env.TENANTS.idFromName(tenantName(this.env, ownerId)).toString()
    )
      throw new RuntimeControlError(403);
    return this.lifecycle.start(input);
  }

  stopRuntime(ownerId: unknown, generation: unknown) {
    return this.lifecycle.stop(ownerId, generation);
  }

  storageIdentity() {
    return this.lifecycle.identity();
  }

  async runtimeStatus() {
    const identity = await this.ctx.storage.get<TenantIdentity>('identity');
    const state = await this.getState();
    return {
      generation: identity?.generation ?? null,
      stopped: ['stopped', 'stopped_with_code'].includes(state.status),
      status: state.status,
    };
  }

  override async fetch(request: Request) {
    try {
      await this.lifecycle.identity();
      const state = await this.getState();
      if (!['running', 'healthy'].includes(state.status)) throw new RuntimeControlError(503);
      return await this.containerFetch(request);
    } catch (error) {
      return failure(error);
    }
  }

  override onError() {
    throw new Error('The account runtime is temporarily unavailable.');
  }
}

GatewayContainer.outboundByHost = { 'sidekick.runtime': runtimeOutbound };
TenantContainer.outboundByHost = {
  'sidekick.storage': storageOutbound,
  'sidekick.control': controlOutbound,
};

export default {
  async scheduled(_event: ScheduledController, env: Bindings) {
    await env.GATEWAY.getByName(gatewayName(env)).wake();
  },
  async fetch(request: Request, env: Bindings) {
    try {
      const url = new URL(request.url);
      if (url.origin !== publicOrigin(env)) throw new RuntimeControlError(403);
      if (url.pathname.startsWith('/runtime/') || url.pathname.startsWith('/__sidekick/'))
        throw new RuntimeControlError(404);
      if (url.pathname.startsWith('/api/internal/')) throw new RuntimeControlError(404);
      if (url.pathname.startsWith('/api/')) {
        const forwarded = new Request(request);
        for (const name of [...forwarded.headers.keys()])
          if (name.toLowerCase().startsWith('x-sidekick-runtime')) forwarded.headers.delete(name);
        forwarded.headers.set('host', url.host);
        return await env.GATEWAY.getByName(gatewayName(env)).fetch(forwarded);
      }
      return await env.ASSETS.fetch(request);
    } catch (error) {
      return failure(error);
    }
  },
} satisfies ExportedHandler<Bindings>;
