import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { z } from 'zod';
import {
  deploymentHeader,
  deploymentPath,
  signDeploymentRequest,
  deploymentRequestSchema,
} from '../../../src/server/deployment-auth.ts';
import { parseCredentialKey } from '../../../src/providers/environment/key-store.ts';

const unavailable = () =>
  new Error('Deployment safety checks did not pass; admission remains unchanged or closed.');

const stateSchema = deploymentRequestSchema.omit({ action: true }).extend({
  phase: z.enum([
    'draining',
    'prepared',
    'activating',
    'aborting',
    'failed',
    'complete',
    'aborted',
  ]),
  receipts: z
    .array(
      z.object({ ownerId: z.uuid(), generation: z.string().regex(/^[1-9]\d{0,19}$/) }).strict(),
    )
    .max(1024),
});

async function boundedJson(response, maximum = 1024 * 1024) {
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw unavailable();
      chunks.push(next.value);
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)),
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function inspectImageDigest(image, environment = process.env) {
  if (
    !/^registry\.cloudflare\.com\/[a-f0-9]{32}\/sidekick-(development|production)(-browser|-workspace)?:[a-f0-9]{40}$/.test(
      image,
    )
  )
    return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['manifest', 'inspect', '-v', image], {
      env: environment,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let invalid = false;
    const timer = setTimeout(() => {
      invalid = true;
      child.kill('SIGKILL');
    }, 60_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 1024 * 1024) {
        invalid = true;
        child.kill('SIGKILL');
      }
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(unavailable());
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        if (invalid || code !== 0) throw unavailable();
        const manifest = JSON.parse(output);
        const digest = manifest?.Descriptor?.digest;
        if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) throw unavailable();
        resolve(`${image.slice(0, image.lastIndexOf(':'))}@${digest}`);
      } catch {
        reject(unavailable());
      }
    });
  });
}

export async function pinDeploymentImages(
  plan,
  environment,
  variables,
  inspect = inspectImageDigest,
) {
  const references = new Map();
  for (const container of plan.config.env[environment].containers) {
    if (!references.has(container.image))
      references.set(container.image, await inspect(container.image, variables));
    const reference = references.get(container.image);
    if (
      typeof reference !== 'string' ||
      !reference.startsWith(
        `${container.image.slice(0, container.image.lastIndexOf(':'))}@sha256:`,
      ) ||
      !/@sha256:[a-f0-9]{64}$/.test(reference)
    )
      throw unavailable();
    container.image = reference;
  }
}

async function emptyTenantRegistry(databaseUrl) {
  if (typeof databaseUrl !== 'string' || !databaseUrl) throw unavailable();
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  });
  try {
    await client.connect();
    const relation = await client.query(
      "SELECT to_regclass('sidekick_control.tenants') AS relation",
    );
    if (!relation.rows[0]?.relation) return true;
    const result = await client.query(
      'SELECT EXISTS(SELECT 1 FROM sidekick_control.tenants) AS occupied',
    );
    return result.rows[0]?.occupied === false;
  } catch {
    throw unavailable();
  } finally {
    await client.end().catch(() => {});
  }
}

export function createDeploymentClient({
  environment,
  plan,
  variables,
  fetcher = fetch,
  now = Date.now,
  wait = sleep,
  emptyRegistry = emptyTenantRegistry,
  attempts = 60,
  intervalMs = 5000,
}) {
  const gateway = JSON.parse(variables.GATEWAY_ENV);
  const masterKey = parseCredentialKey(gateway.SIDEKICK_MASTER_KEY || '');
  const selected = plan.config.env[environment];
  const worker = selected.name || `${plan.config.name}-${environment}`;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(worker)) throw unavailable();
  let input;
  let bootstrap = false;
  let prepared = false;
  let activated = false;
  let verified = false;
  let initialized = false;

  async function api(path, allowMissing = false) {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${variables.CLOUDFLARE_ACCOUNT_ID}/${path}`,
      {
        headers: { authorization: `Bearer ${variables.CLOUDFLARE_API_TOKEN}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    );
    const result = await boundedJson(response);
    if (
      allowMissing &&
      response.status === 404 &&
      result.success === false &&
      result.errors?.some((error) => error.code === 10007)
    )
      return null;
    if (!response.ok || result.success !== true) throw unavailable();
    return result.result;
  }

  async function applications() {
    return Promise.all(
      selected.containers.map(async (container) => {
        const name = container.name;
        if (typeof name !== 'string' || !/^[a-z0-9-]{1,128}$/.test(name)) throw unavailable();
        const values = await api(`containers/applications?name=${encodeURIComponent(name)}`);
        if (!Array.isArray(values) || values.length > 1024) throw unavailable();
        const matches = values.filter((value) => value.name === name);
        if (matches.length > 1) throw unavailable();
        return { expected: container.image, application: matches[0] };
      }),
    );
  }

  async function control(action) {
    const body = Buffer.from(JSON.stringify({ ...input, action }));
    const token = signDeploymentRequest({ masterKey, environment, body, now: now() });
    const response = await fetcher(new URL(deploymentPath, plan.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [deploymentHeader]: token },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(
        action === 'prepare' ? Math.max(1, input.deadline - now() + 1000) : 30_000,
      ),
    });
    const result = await boundedJson(response, 128 * 1024);
    if (!response.ok || result.ok !== true) throw unavailable();
    const parsed = stateSchema.safeParse(result.state);
    if (!parsed.success) throw unavailable();
    const state = parsed.data;
    if (
      action !== 'status' &&
      (state.nonce !== input.nonce ||
        state.targetRelease !== input.targetRelease ||
        state.previousRelease !== input.previousRelease ||
        state.deadline !== input.deadline)
    )
      throw unavailable();
    const expected = {
      prepare: 'prepared',
      activate: 'activating',
      complete: 'complete',
      abort: 'aborted',
    }[action];
    if (expected && state.phase !== expected) throw unavailable();
    return state;
  }

  return {
    async recover() {
      if (input || prepared || activated) throw unavailable();
      input = {
        nonce: randomUUID(),
        targetRelease: plan.release,
        previousRelease: plan.release,
        deadline: now() + 300_000,
      };
      const state = await control('status');
      if (state.targetRelease !== plan.release) throw unavailable();
      const { phase, receipts: _receipts, ...identity } = state;
      input = identity;
      prepared = ['prepared', 'activating', 'complete'].includes(phase);
      activated = ['activating', 'complete'].includes(phase);
      initialized = true;
      return { ...identity, phase };
    },
    async prepare() {
      const existing = await api(`workers/scripts/${worker}/settings`, true);
      if (existing === null) {
        if (
          (await applications()).some(({ application }) => application) ||
          !(await emptyRegistry(gateway.DATABASE_URL))
        )
          throw unavailable();
        bootstrap = true;
        prepared = true;
        return;
      }
      const health = await fetcher(new URL('/api/health', plan.origin), {
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      const status = await boundedJson(health, 4096);
      if (!health.ok || status.ok !== true || !/^[a-f0-9]{40}$/.test(status.release ?? ''))
        throw unavailable();
      input = {
        nonce: randomUUID(),
        targetRelease: plan.release,
        previousRelease: status.release,
        deadline: now() + 300_000,
      };
      await control('prepare');
      prepared = true;
    },
    async activate() {
      if (!prepared) throw unavailable();
      if (!bootstrap) await control('activate');
      activated = true;
    },
    async initialize() {
      if (!activated || !verified) throw unavailable();
      if (!bootstrap) return;
      input = {
        nonce: randomUUID(),
        targetRelease: plan.release,
        previousRelease: plan.release,
        deadline: now() + 300_000,
      };
      await control('prepare');
      await control('activate');
      initialized = true;
    },
    async verifyRollouts() {
      if (!activated) throw unavailable();
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const entries = await applications();
        if (
          entries.every(
            ({ expected, application }) =>
              application &&
              application.configuration?.image === expected &&
              !application.active_rollout_id &&
              (!application.scheduling_hint?.target?.configuration?.image ||
                application.scheduling_hint.target.configuration.image === expected),
          )
        ) {
          verified = true;
          return;
        }
        if (attempt + 1 < attempts) await wait(intervalMs);
      }
      throw unavailable();
    },
    async complete() {
      if (!activated || !verified || (bootstrap && !initialized)) throw unavailable();
      await control('complete');
    },
    async abort() {
      if (activated || !input) throw unavailable();
      await control('abort');
    },
  };
}
