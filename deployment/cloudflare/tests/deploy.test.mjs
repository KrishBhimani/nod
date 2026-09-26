import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { deploy, deploymentPlan } from '../scripts/deploy.mjs';
import { verifyDeployment } from '../scripts/smoke.mjs';

const release = 'a'.repeat(40);
const accountId = 'b'.repeat(32);
const origin = 'https://sidekick-production.test.workers.dev';
const variables = {
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-credential',
  SIDEKICK_RELEASE: release,
  SIDEKICK_PUBLIC_URL: origin,
  GATEWAY_ENV: JSON.stringify({
    SIDEKICK_ENVIRONMENT: 'production',
    SIDEKICK_PUBLIC_URL: origin,
    AUTH_SECRET: 'synthetic-gateway-credential',
  }),
};

test('deployment validation rejects another environment, origin and invalid revision before publishing', () => {
  const input = {
    environment: 'production',
    release,
    accountId,
    publicUrl: origin,
    gatewayEnv: variables.GATEWAY_ENV,
    config: {
      env: { production: { containers: [{}] } },
      main: 'src/worker.ts',
      assets: { directory: '../../dist/web' },
    },
  };
  for (const change of [
    { environment: 'unknown' },
    { release: 'main' },
    { publicUrl: 'http://sidekick.test' },
    { publicUrl: `${origin}/app` },
    { gatewayEnv: JSON.stringify({ SIDEKICK_ENVIRONMENT: 'development' }) },
    { gatewayEnv: JSON.stringify({ SIDEKICK_PUBLIC_URL: 'https://other.example' }) },
    { gatewayEnv: JSON.stringify({ AUTH_SECRET: 42 }) },
    { gatewayEnv: JSON.stringify({ SIDEKICK_IMAGE_RELEASE: release }) },
    { gatewayEnv: JSON.stringify({ AUTH_SECRET: 'x'.repeat(6000) }) },
  ])
    assert.throws(() => deploymentPlan({ ...input, ...change }));
  const plan = deploymentPlan(input);
  assert.equal(
    plan.config.env.production.containers[0].image,
    `registry.cloudflare.com/${accountId}/sidekick-production:${release}`,
  );
  assert.equal(JSON.parse(plan.secrets.GATEWAY_ENV).SIDEKICK_RELEASE, release);
  assert.equal(JSON.stringify(plan.config).includes('synthetic-gateway-credential'), false);
});

test('deployment publishes the image before atomically uploading code and secrets, cleans private files', async () => {
  const commands = [];
  const reports = [];
  let temporaryConfig;
  let secretPath;
  let smoke;
  await deploy('production', variables, {
    report: (message) => reports.push(message),
    command: async (args, env) => {
      commands.push(args);
      assert.equal(env.GATEWAY_ENV, undefined);
      assert.equal(env.AUTH_SECRET, undefined);
      assert.equal(env.CLOUDFLARE_API_TOKEN, variables.CLOUDFLARE_API_TOKEN);
      assert.equal(args.join(' ').includes('synthetic'), false);
      temporaryConfig = args[args.indexOf('--config') + 1];
      assert.equal((await stat(temporaryConfig)).mode & 0o777, 0o600);
      const configuration = JSON.parse(await readFile(temporaryConfig, 'utf8'));
      assert.equal(configuration.env.production.containers.length, 2);
      assert.equal(configuration.env.development, undefined);
      assert.ok(
        configuration.env.production.containers.every((value) =>
          value.image.endsWith(`:${release}`),
        ),
      );
      if (args[0] === 'deploy') {
        secretPath = args[args.indexOf('--secrets-file') + 1];
        assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
        assert.equal(
          JSON.parse(JSON.parse(await readFile(secretPath, 'utf8')).GATEWAY_ENV).AUTH_SECRET,
          'synthetic-gateway-credential',
        );
      }
    },
    smoke: async (input) => {
      smoke = input;
    },
  });
  assert.deepEqual(
    commands.map((args) => args[0]),
    ['containers', 'deploy'],
  );
  assert.deepEqual(smoke, { origin, release });
  assert.equal(reports.join(' ').includes('synthetic'), false);
  await assert.rejects(stat(temporaryConfig), { code: 'ENOENT' });
  await assert.rejects(stat(secretPath), { code: 'ENOENT' });
});

test('a failed image publication never deploys the Worker or attempts smoke checks', async () => {
  const commands = [];
  let temporaryConfig;
  await assert.rejects(
    deploy('production', variables, {
      report() {},
      command: async (args) => {
        commands.push(args);
        temporaryConfig = args[args.indexOf('--config') + 1];
        throw new Error('Synthetic image failure.');
      },
      smoke: async () => assert.fail('Smoke must not run after a failed push.'),
    }),
  );
  assert.equal(commands.length, 1);
  await assert.rejects(stat(temporaryConfig), { code: 'ENOENT' });
});

function smokeFetch({ incorrectRelease = false, exposedState = false } = {}) {
  return async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers?.cookie, undefined);
    if (url.pathname === '/api/health')
      return Response.json({ ok: true, release: incorrectRelease ? 'old' : release });
    if (url.pathname === '/api/session')
      return Response.json({
        auth: { mode: 'google', googleAvailable: true },
        user: null,
        settings: null,
        capabilities: { developer: false },
      });
    return new Response(null, {
      status:
        url.pathname === '/api/state'
          ? exposedState
            ? 200
            : 401
          : url.pathname === '/api/login'
            ? 403
            : 404,
    });
  };
}

test('smoke checks require the new release and public authorization denials', async () => {
  await verifyDeployment({ origin, release, fetcher: smokeFetch(), attempts: 1 });
  await assert.rejects(
    verifyDeployment({
      origin,
      release,
      fetcher: smokeFetch({ incorrectRelease: true }),
      attempts: 1,
    }),
    /new gateway release/,
  );
  await assert.rejects(
    verifyDeployment({ origin, release, fetcher: smokeFetch({ exposedState: true }), attempts: 1 }),
    /authorization boundary/,
  );
});
