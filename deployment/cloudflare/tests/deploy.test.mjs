import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { deploy, deploymentPlan } from '../scripts/deploy.mjs';
import { verifyDeployment } from '../scripts/smoke.mjs';
import { recoverDeployment } from '../scripts/recover.mjs';

const release = 'a'.repeat(40);
const accountId = 'b'.repeat(32);
const origin = 'https://otto.test.workers.dev';
const variables = {
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-credential',
  OTTO_RELEASE: release,
  OTTO_PUBLIC_URL: origin,
  GATEWAY_ENV: JSON.stringify({
    OTTO_ENVIRONMENT: 'production',
    OTTO_PUBLIC_URL: origin,
    AUTH_SECRET: 'synthetic-gateway-credential',
    OTTO_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
    DATABASE_URL: 'postgresql://synthetic:synthetic@db.example.test/otto',
    COMPUTER_PROVIDER: 'cloudflare',
    OBJECT_STORAGE_PROVIDER: 'http',
    OBJECT_STORAGE_ENDPOINT: 'http://otto.storage/v1/objects/',
  }),
};

function gatewayValues(changes) {
  return JSON.stringify({ ...JSON.parse(variables.GATEWAY_ENV), ...changes });
}

const e2bGateway = gatewayValues({
  COMPUTER_PROVIDER: 'e2b',
  E2B_API_KEY: 'synthetic-e2b-credential',
  E2B_COMPUTER_TEMPLATE: 'synthetic-computer-template',
});

function configuration(computers = true) {
  const classes = ['GatewayContainer', 'TenantContainer'];
  if (computers) classes.push('BrowserComputerContainer', 'WorkspaceComputerContainer');
  return {
    name: 'otto',
    main: 'src/worker.ts',
    assets: { directory: '../../dist/web' },
    env: {
      production: {
        name: 'otto',
        containers: classes.map((class_name) => ({
          class_name,
          image: './Dockerfile',
          image_build_context: '../..',
          image_vars: { SYNTHETIC_BUILD: 'unused' },
        })),
      },
    },
  };
}

function lifecycle(events = [], failures = {}) {
  return Object.fromEntries(
    ['prepare', 'activate', 'verifyRollouts', 'initialize', 'complete', 'abort'].map((action) => [
      action,
      async () => {
        events.push(action);
        if (failures[action]) throw new Error('Synthetic control failure.');
      },
    ]),
  );
}

function imageDigest(image) {
  return `${image.slice(0, image.lastIndexOf(':'))}@sha256:${'d'.repeat(64)}`;
}

function planInput(config = configuration()) {
  return {
    environment: 'production',
    release,
    accountId,
    publicUrl: origin,
    gatewayEnv: variables.GATEWAY_ENV,
    config,
  };
}

test('deployment validation rejects another environment, origin and invalid revision before publishing', () => {
  const input = planInput();
  for (const change of [
    { environment: 'unknown' },
    { release: 'main' },
    { publicUrl: 'http://otto.test' },
    { publicUrl: `${origin}/app` },
    { gatewayEnv: JSON.stringify({ OTTO_ENVIRONMENT: 'development' }) },
    { gatewayEnv: JSON.stringify({ OTTO_PUBLIC_URL: 'https://other.example' }) },
    { gatewayEnv: JSON.stringify({ AUTH_SECRET: 42 }) },
    { gatewayEnv: JSON.stringify({ OTTO_IMAGE_RELEASE: release }) },
    { gatewayEnv: JSON.stringify({ AUTH_SECRET: 'x'.repeat(6000) }) },
  ])
    assert.throws(() => deploymentPlan({ ...input, ...change }));
  const plan = deploymentPlan(input);
  assert.equal(
    plan.config.env.production.containers[0].image,
    `registry.cloudflare.com/${accountId}/otto-production:${release}`,
  );
  assert.equal(JSON.parse(plan.secrets.GATEWAY_ENV).OTTO_RELEASE, release);
  assert.equal(JSON.stringify(plan.config).includes('synthetic-gateway-credential'), false);
});

test('deployment assigns distinct computer images and deduplicates the shared runtime image', () => {
  const config = configuration();
  const plan = deploymentPlan(planInput(config));
  const images = [
    `otto-production:${release}`,
    `otto-production-browser:${release}`,
    `otto-production-workspace:${release}`,
  ];
  assert.deepEqual(plan.localImages, images);
  assert.deepEqual(
    plan.config.env.production.containers.map((container) => container.image),
    [images[0], ...images].map((image) => `registry.cloudflare.com/${accountId}/${image}`),
  );
  for (const container of plan.config.env.production.containers) {
    assert.equal(container.image_build_context, undefined);
    assert.equal(container.image_vars, undefined);
  }
  assert.equal(config.env.production.containers[0].image, './Dockerfile');
  assert.deepEqual(
    deploymentPlan({ ...planInput(configuration(false)), gatewayEnv: e2bGateway }).localImages,
    [images[0]],
  );
});

test('incomplete hosted computer and storage configuration is rejected before any publication', async (t) => {
  for (const [name, changes] of [
    ['missing computer', { COMPUTER_PROVIDER: undefined }],
    ['empty computer', { COMPUTER_PROVIDER: '' }],
    ['local computer', { COMPUTER_PROVIDER: 'docker' }],
    ['unknown computer', { COMPUTER_PROVIDER: 'synthetic-private-provider' }],
    ['missing storage', { OBJECT_STORAGE_PROVIDER: undefined }],
    ['process storage', { OBJECT_STORAGE_PROVIDER: 'postgres' }],
    ['filesystem storage', { OBJECT_STORAGE_PROVIDER: 'filesystem' }],
    ['missing endpoint', { OBJECT_STORAGE_ENDPOINT: undefined }],
    ['empty endpoint', { OBJECT_STORAGE_ENDPOINT: '' }],
    ['host-only endpoint', { OBJECT_STORAGE_ENDPOINT: 'http://otto.storage' }],
    ['foreign endpoint', { OBJECT_STORAGE_ENDPOINT: 'https://synthetic-private-host/v1/objects/' }],
    [
      'endpoint query',
      {
        OBJECT_STORAGE_ENDPOINT: 'http://otto.storage/v1/objects/?token=synthetic-private-token',
      },
    ],
    ['E2B missing key', { ...JSON.parse(e2bGateway), E2B_API_KEY: undefined }],
    ['E2B missing computer', { ...JSON.parse(e2bGateway), E2B_COMPUTER_TEMPLATE: undefined }],
    ['E2B empty computer', { ...JSON.parse(e2bGateway), E2B_COMPUTER_TEMPLATE: '  ' }],
    ['E2B legacy templates', { ...JSON.parse(e2bGateway), E2B_BROWSER_TEMPLATE: 'old-browser' }],
  ]) {
    await t.test(name, async () => {
      const reports = [];
      await assert.rejects(
        deploy(
          'production',
          { ...variables, GATEWAY_ENV: gatewayValues(changes) },
          {
            config: configuration(),
            command: () => assert.fail('Provider validation must happen before publication.'),
            smoke: () => assert.fail('Provider validation must happen before smoke checks.'),
            report: (message) => reports.push(message),
          },
        ),
        (error) => {
          assert.ok(error instanceof Error);
          assert.doesNotMatch(error.message, /synthetic|credential|token=/);
          return true;
        },
      );
      assert.deepEqual(reports, []);
    });
  }
});

test('explicit hosted providers remain supported in both deployment environments', () => {
  for (const environment of ['development', 'production']) {
    for (const computerProvider of ['cloudflare', 'e2b']) {
      const config = configuration(computerProvider === 'cloudflare');
      config.env[environment] = config.env.production;
      const gatewayEnv = gatewayValues({
        ...(computerProvider === 'e2b' ? JSON.parse(e2bGateway) : {}),
        OTTO_ENVIRONMENT: environment,
      });
      const plan = deploymentPlan({ ...planInput(config), environment, gatewayEnv });
      const values = JSON.parse(plan.secrets.GATEWAY_ENV);
      assert.equal(values.COMPUTER_PROVIDER, computerProvider);
      assert.equal(values.OBJECT_STORAGE_PROVIDER, 'http');
      assert.equal(values.OBJECT_STORAGE_ENDPOINT, 'http://otto.storage/v1/objects/');
      assert.equal(plan.localImages.length, computerProvider === 'cloudflare' ? 3 : 1);
    }
  }
});

test('unsupported container classes fail before publishing without echoing configuration', async () => {
  for (const className of ['UnknownContainer', '__proto__', undefined]) {
    const config = configuration(false);
    config.env.production.containers.push({ class_name: className });
    await assert.rejects(
      deploy('production', variables, {
        config,
        command: () => assert.fail('Invalid classes must not publish.'),
      }),
      { message: 'The deployment has an unsupported container class.' },
    );
  }
});

test('missing or repeated required classes fail before any image publication', () => {
  for (const missing of [
    'GatewayContainer',
    'TenantContainer',
    'BrowserComputerContainer',
    'WorkspaceComputerContainer',
  ]) {
    const config = configuration();
    config.env.production.containers = config.env.production.containers.filter(
      (container) => container.class_name !== missing,
    );
    assert.throws(() => deploymentPlan(planInput(config)));
  }
  const config = configuration();
  config.env.production.containers.push(config.env.production.containers[0]);
  assert.throws(() => deploymentPlan(planInput(config)));
});

test('deployment publishes all images before uploading code and secrets, cleans private files', async () => {
  const commands = [];
  const events = [];
  const reports = [];
  let temporaryConfig;
  let secretPath;
  let smoke;
  await deploy('production', variables, {
    config: configuration(),
    deploymentControl: lifecycle(events),
    imageDigest: async (image) => {
      events.push('digest');
      return imageDigest(image);
    },
    report: (message) => reports.push(message),
    command: async (args, env) => {
      commands.push(args);
      events.push(args[0] === 'deploy' ? 'deploy' : 'push');
      assert.equal(env.GATEWAY_ENV, undefined);
      assert.equal(env.AUTH_SECRET, undefined);
      assert.equal(env.CLOUDFLARE_API_TOKEN, variables.CLOUDFLARE_API_TOKEN);
      assert.equal(args.join(' ').includes('synthetic'), false);
      temporaryConfig = args[args.indexOf('--config') + 1];
      assert.equal((await stat(temporaryConfig)).mode & 0o777, 0o600);
      const configuration = JSON.parse(await readFile(temporaryConfig, 'utf8'));
      assert.equal(configuration.env.production.containers.length, 4);
      assert.equal(configuration.env.development, undefined);
      assert.ok(
        configuration.env.production.containers.every((value) =>
          value.image.endsWith(args[0] === 'deploy' ? `@sha256:${'d'.repeat(64)}` : `:${release}`),
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
      events.push('smoke');
      smoke = input;
    },
  });
  assert.deepEqual(
    commands.map((args) => args[0]),
    ['containers', 'containers', 'containers', 'deploy'],
  );
  assert.deepEqual(
    commands.slice(0, 3).map((args) => args[2]),
    [
      `otto-production:${release}`,
      `otto-production-browser:${release}`,
      `otto-production-workspace:${release}`,
    ],
  );
  assert.deepEqual(smoke, { origin, release });
  assert.deepEqual(events, [
    'push',
    'push',
    'push',
    'digest',
    'digest',
    'digest',
    'prepare',
    'activate',
    'deploy',
    'verifyRollouts',
    'smoke',
    'initialize',
    'complete',
  ]);
  assert.equal(reports.join(' ').includes('synthetic'), false);
  await assert.rejects(stat(temporaryConfig), { code: 'ENOENT' });
  await assert.rejects(stat(secretPath), { code: 'ENOENT' });
});

test('a failed publication of any image prevents Worker activation and smoke checks', async () => {
  for (const failure of [1, 2, 3]) {
    const commands = [];
    let temporaryConfig;
    await assert.rejects(
      deploy('production', variables, {
        config: configuration(),
        report() {},
        command: async (args) => {
          commands.push(args);
          temporaryConfig = args[args.indexOf('--config') + 1];
          if (commands.length === failure) throw new Error('Synthetic image failure.');
        },
        smoke: async () => assert.fail('Smoke must not run after a failed push.'),
      }),
    );
    assert.equal(commands.length, failure);
    assert.ok(commands.every((args) => args[0] === 'containers'));
    await assert.rejects(stat(temporaryConfig), { code: 'ENOENT' });
  }
});

test('an E2B deployment with two runtime classes still publishes one runtime image', async () => {
  const commands = [];
  await deploy(
    'production',
    { ...variables, GATEWAY_ENV: e2bGateway },
    {
      config: configuration(false),
      deploymentControl: lifecycle(),
      imageDigest,
      report() {},
      command: async (args) => commands.push(args),
      smoke: async () => {},
    },
  );
  assert.deepEqual(
    commands.map((args) => args[0]),
    ['containers', 'deploy'],
  );
  assert.equal(commands[0][2], `otto-production:${release}`);
});

test('failed drain, activation or verification cannot publish or reopen prematurely', async () => {
  for (const failure of ['prepare', 'activate', 'verifyRollouts', 'smoke', 'initialize']) {
    const events = [];
    const commands = [];
    await assert.rejects(
      deploy('production', variables, {
        config: configuration(),
        report() {},
        imageDigest,
        deploymentControl: lifecycle(events, { [failure]: true }),
        command: async (args) => commands.push(args[0]),
        smoke: async () => {
          if (failure === 'smoke') throw new Error('Synthetic smoke failure.');
        },
      }),
    );
    assert.equal(events.includes('complete'), false);
    assert.equal(commands.includes('deploy'), !['prepare', 'activate'].includes(failure));
  }
});

test('a manifest from another repository fails before maintenance or activation', async () => {
  const events = [];
  const commands = [];
  await assert.rejects(
    deploy('production', variables, {
      config: configuration(),
      report() {},
      deploymentControl: lifecycle(events),
      imageDigest: async () =>
        `registry.cloudflare.com/${accountId}/foreign@sha256:${'d'.repeat(64)}`,
      command: async (args) => commands.push(args[0]),
    }),
  );
  assert.equal(events.includes('prepare'), false);
  assert.equal(commands.includes('deploy'), false);
});

test('recovery completion never publishes images and verifies rollout then public smoke before reopening', async () => {
  const events = [];
  const control = lifecycle(events);
  control.recover = async () => {
    events.push('recover');
    return { phase: 'activating' };
  };
  await recoverDeployment('production', 'complete', variables, {
    config: configuration(),
    deploymentControl: control,
    imageDigest: async (image, environment) => {
      events.push('digest');
      assert.equal(environment.GATEWAY_ENV, undefined);
      assert.equal(environment.CLOUDFLARE_API_TOKEN, undefined);
      return imageDigest(image);
    },
    smoke: async () => events.push('smoke'),
    report: () => {},
  });
  assert.deepEqual(events, [
    'recover',
    'digest',
    'digest',
    'digest',
    'verifyRollouts',
    'smoke',
    'complete',
  ]);
});

test('recovery refuses completion before activation and abort after activation', async () => {
  for (const [action, phase] of [
    ['complete', 'prepared'],
    ['abort', 'activating'],
  ]) {
    const events = [];
    const control = lifecycle(events);
    control.recover = async () => ({ phase });
    await assert.rejects(
      recoverDeployment('production', action, variables, {
        config: configuration(),
        deploymentControl: control,
        imageDigest: () => assert.fail('Invalid recovery phase must not inspect images.'),
        report: () => {},
      }),
    );
    assert.deepEqual(events, []);
  }
});

test('recovery abort and status preserve the existing control identity without image or smoke operations', async () => {
  for (const action of ['abort', 'status']) {
    const events = [];
    const reports = [];
    const control = lifecycle(events);
    const state = { nonce: 'synthetic-metadata', phase: 'failed' };
    control.recover = async () => state;
    await recoverDeployment('production', action, variables, {
      config: configuration(),
      deploymentControl: control,
      imageDigest: () => assert.fail('Abort and status are independent of images.'),
      smoke: () => assert.fail('Abort and status must not run release smoke.'),
      report: (value) => reports.push(value),
    });
    assert.deepEqual(events, action === 'abort' ? ['abort'] : []);
    if (action === 'status') assert.deepEqual(JSON.parse(reports[0]), state);
  }
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
