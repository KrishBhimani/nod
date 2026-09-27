import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDeploymentClient } from '../scripts/drain.mjs';
import { createDeploymentVerifier, deploymentHeader } from '../../../src/server/deployment-auth.ts';

function fixture(overrides = {}) {
  const masterKey = randomBytes(32);
  const origin = 'https://sidekick-production.test.workers.dev';
  const release = 'b'.repeat(40);
  const account = 'c'.repeat(32);
  const classes = [
    'GatewayContainer',
    'TenantContainer',
    'BrowserComputerContainer',
    'WorkspaceComputerContainer',
  ];
  const containers = classes.map((name, index) => ({
    name: `sidekick-${name.toLowerCase()}-production`,
    image: `registry.cloudflare.com/${account}/sidekick-production-${index}@sha256:${'d'.repeat(64)}`,
  }));
  const plan = {
    origin,
    release,
    config: { env: { production: { name: 'sidekick-production', containers } } },
  };
  const variables = {
    CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_API_TOKEN: 'synthetic-api-key',
    GATEWAY_ENV: JSON.stringify({
      SIDEKICK_MASTER_KEY: masterKey.toString('base64'),
      DATABASE_URL: 'synthetic-db',
    }),
  };
  const requests = [];
  const controls = [];
  let registryReads = 0;
  let applicationReads = 0;
  const state = {
    missing: false,
    missingCode: 10007,
    denied: false,
    published: false,
    occupied: false,
    rollout: false,
    wrongImage: false,
    control: null,
    ...overrides,
  };
  const verify = createDeploymentVerifier({ masterKey, environment: 'production' });
  const api = (result) => Response.json({ success: true, result });
  const client = createDeploymentClient({
    environment: 'production',
    plan,
    variables,
    attempts: 2,
    intervalMs: 0,
    wait: async () => {},
    emptyRegistry: async () => {
      registryReads += 1;
      return !state.occupied;
    },
    fetcher: async (raw, options) => {
      const url = new URL(raw);
      requests.push({ url, options });
      assert.equal(options.redirect, 'error');
      if (url.hostname === 'api.cloudflare.com') {
        assert.equal(options.headers.authorization, 'Bearer synthetic-api-key');
        if (url.pathname.endsWith('/settings')) {
          if (state.denied) return Response.json({ success: false }, { status: 403 });
          if (state.missing)
            return Response.json(
              { success: false, errors: [{ code: state.missingCode }] },
              { status: 404 },
            );
          return api({ bindings: [] });
        }
        applicationReads += 1;
        const name = url.searchParams.get('name');
        const expected = containers.find((container) => container.name === name);
        assert.ok(expected);
        return api(
          state.missing && !state.published
            ? []
            : [
                {
                  name,
                  configuration: { image: state.wrongImage ? 'wrong' : expected.image },
                  ...(state.rollout ? { active_rollout_id: 'still-running' } : {}),
                },
              ],
        );
      }
      assert.equal(options.headers?.authorization, undefined);
      if (url.pathname === '/api/health')
        return Response.json({ ok: true, release: state.published ? release : 'a'.repeat(40) });
      assert.equal(url.pathname, '/api/deployment');
      const input = await verify(
        options.headers[deploymentHeader],
        options.method,
        url.pathname,
        options.body,
      );
      controls.push(input);
      assert.equal(Buffer.from(options.body).includes(masterKey), false);
      if (input.action === 'status') return Response.json({ ok: true, state: state.control });
      const phase = {
        prepare: 'prepared',
        activate: 'activating',
        complete: 'complete',
        abort: 'aborted',
      }[input.action];
      const { action: _action, ...identity } = input;
      state.control = { ...identity, phase, receipts: [] };
      return Response.json({ ok: true, state: state.control });
    },
  });
  return {
    client,
    controls,
    requests,
    state,
    registryReads: () => registryReads,
    applicationReads: () => applicationReads,
  };
}

test('existing deployment requires signed drain and all four exact image rollouts before reopening', async () => {
  const f = fixture();
  await assert.rejects(f.client.activate());
  await f.client.prepare();
  await f.client.activate();
  await assert.rejects(f.client.complete());
  f.state.rollout = true;
  await assert.rejects(f.client.verifyRollouts());
  await assert.rejects(f.client.abort());
  f.state.rollout = false;
  f.state.wrongImage = true;
  await assert.rejects(f.client.verifyRollouts());
  f.state.wrongImage = false;
  await f.client.verifyRollouts();
  await f.client.initialize();
  await f.client.complete();
  assert.deepEqual(
    f.controls.map((input) => input.action),
    ['prepare', 'activate', 'complete'],
  );
  assert.equal(new Set(f.controls.map((input) => input.nonce)).size, 1);
  assert.equal(f.registryReads(), 0);
  assert.equal(f.applicationReads(), 20);
});

test('initial deployment requires confirmed absent Worker, absent applications and empty database registry', async () => {
  const f = fixture({ missing: true });
  await f.client.prepare();
  assert.equal(f.registryReads(), 1);
  assert.equal(f.controls.length, 0);
  await f.client.activate();
  f.state.published = true;
  await f.client.verifyRollouts();
  await assert.rejects(f.client.complete());
  await f.client.initialize();
  await f.client.complete();
  assert.deepEqual(
    f.controls.map((input) => input.action),
    ['prepare', 'activate', 'complete'],
  );
  assert.equal(f.controls[0].previousRelease, f.controls[0].targetRelease);
});

test('API denial, unknown404, occupied registry or existing application never count as empty bootstrap', async () => {
  for (const changes of [
    { denied: true },
    { missing: true, missingCode: 99999 },
    { missing: true, occupied: true },
    { missing: true, published: true },
  ]) {
    const f = fixture(changes);
    await assert.rejects(f.client.prepare());
    await assert.rejects(f.client.activate());
    assert.equal(f.controls.length, 0);
  }
});

test('pre-activation abort is explicitly signed against the same deployment identity', async () => {
  const f = fixture();
  await f.client.prepare();
  await f.client.abort();
  assert.deepEqual(
    f.controls.map((input) => input.action),
    ['prepare', 'abort'],
  );
  assert.equal(f.controls[0].nonce, f.controls[1].nonce);
});

function interrupted(phase = 'activating', changes = {}) {
  return {
    nonce: randomUUID(),
    targetRelease: 'b'.repeat(40),
    previousRelease: 'a'.repeat(40),
    deadline: Date.now() - 1_000,
    phase,
    receipts: [],
    ...changes,
  };
}

test('recovery retains the exact interrupted deployment identity and re-verifies every image before complete', async () => {
  const original = interrupted();
  const f = fixture({ control: original, published: true });
  const status = await f.client.recover();
  assert.equal(status.nonce, original.nonce);
  assert.equal(status.phase, 'activating');
  assert.equal('receipts' in status, false);
  await assert.rejects(f.client.complete());
  f.state.rollout = true;
  await assert.rejects(f.client.verifyRollouts());
  f.state.rollout = false;
  await f.client.verifyRollouts();
  await f.client.complete();
  assert.deepEqual(
    f.controls.map((input) => input.action),
    ['status', 'complete'],
  );
  assert.equal(f.controls[1].nonce, original.nonce);
  assert.equal(f.controls[1].deadline, original.deadline);
});

test('recovery rejects absent, malformed or foreign-release barriers and cannot abort after activation', async () => {
  for (const control of [
    null,
    interrupted('unknown'),
    interrupted('failed', { targetRelease: 'c'.repeat(40) }),
    interrupted('failed', { nonce: 'invalid' }),
  ]) {
    const f = fixture({ control });
    await assert.rejects(f.client.recover());
    assert.deepEqual(
      f.controls.map((input) => input.action),
      ['status'],
    );
  }
  const f = fixture({ control: interrupted() });
  await f.client.recover();
  await assert.rejects(f.client.abort());
  assert.equal(f.controls.length, 1);
});

test('pre-activation recovery can request abort with the original expired deadline without preparing again', async () => {
  const original = interrupted('failed');
  const f = fixture({ control: original });
  await f.client.recover();
  await f.client.abort();
  assert.deepEqual(
    f.controls.map((input) => input.action),
    ['status', 'abort'],
  );
  assert.equal(f.controls[1].nonce, original.nonce);
  assert.equal(f.controls[1].deadline, original.deadline);
});
