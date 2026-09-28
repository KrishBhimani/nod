import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { verifyDeployment } from './smoke.mjs';
import { createDeploymentClient, inspectImageDigest, pinDeploymentImages } from './drain.mjs';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function renameGatewayEnvironment(source, publicUrl) {
  let values;
  try {
    values = JSON.parse(source);
  } catch {
    return source;
  }
  if (!values || Array.isArray(values) || typeof values !== 'object') return source;
  const oldKeys = Object.keys(values).filter((key) => key.startsWith('SIDEKICK_'));
  if (oldKeys.length === 0) return source;
  for (const key of oldKeys) {
    const replacement = `OTTO_${key.slice('SIDEKICK_'.length)}`;
    if (replacement in values) throw new Error('The gateway environment mixes old and new names.');
    values[replacement] = values[key];
    delete values[key];
  }
  values.OTTO_PUBLIC_URL = publicUrl;
  if (values.OBJECT_STORAGE_ENDPOINT === 'http://sidekick.storage/v1/objects/')
    values.OBJECT_STORAGE_ENDPOINT = 'http://otto.storage/v1/objects/';
  return JSON.stringify(values);
}

export async function ensureStorageBucket(accountId, token, bucket, request = fetch) {
  const collection = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`;
  const endpoint = `${collection}/${bucket}`;
  const headers = { authorization: `Bearer ${token}`, 'cf-r2-jurisdiction': 'eu' };
  const read = () => request(endpoint, { headers, signal: AbortSignal.timeout(10_000) });
  let response = await read();
  if (response.status === 404) {
    const created = await request(collection, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: bucket }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!created.ok) throw new Error('The private object bucket could not be created.');
    response = await read();
  }
  if (!response.ok || (await response.json()).result?.jurisdiction !== 'eu')
    throw new Error('The private object bucket is unavailable or has the wrong jurisdiction.');
}

export function deploymentPlan({ environment, release, accountId, publicUrl, gatewayEnv, config }) {
  if (!['development', 'production'].includes(environment))
    throw new Error('Choose the development or production deployment environment.');
  if (!/^[a-f0-9]{40}$/.test(release ?? ''))
    throw new Error('Set OTTO_RELEASE to the tested Git commit.');
  if (!/^[a-f0-9]{32}$/.test(accountId ?? ''))
    throw new Error('Set CLOUDFLARE_ACCOUNT_ID to the selected account.');
  let origin;
  let values;
  try {
    origin = new URL(publicUrl);
    values = JSON.parse(gatewayEnv);
  } catch {
    throw new Error('Configure the application origin and gateway environment.');
  }
  if (
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    origin.hostname.includes('.example.')
  )
    throw new Error('Set OTTO_PUBLIC_URL to the canonical production HTTPS origin.');
  if (
    !values ||
    Array.isArray(values) ||
    typeof values !== 'object' ||
    Object.keys(values).length === 0 ||
    Object.keys(values).length > 100 ||
    Buffer.byteLength(gatewayEnv) > 48 * 1024 ||
    Object.entries(values).some(
      ([key, value]) =>
        !/^[A-Z][A-Z0-9_]*$/.test(key) ||
        key === 'OTTO_IMAGE_RELEASE' ||
        typeof value !== 'string' ||
        value.includes('\0') ||
        value.length > 32768,
    )
  )
    throw new Error('GATEWAY_ENV must contain bounded server environment strings.');
  if (values.OTTO_ENVIRONMENT && values.OTTO_ENVIRONMENT !== environment)
    throw new Error('The gateway configuration belongs to another environment.');
  if (values.OTTO_PUBLIC_URL && values.OTTO_PUBLIC_URL !== origin.origin)
    throw new Error('The gateway configuration uses another application origin.');
  if (!['cloudflare', 'e2b'].includes(values.COMPUTER_PROVIDER))
    throw new Error('Set COMPUTER_PROVIDER to cloudflare or e2b for this deployment.');
  if (
    values.COMPUTER_PROVIDER === 'e2b' &&
    ['E2B_API_KEY', 'E2B_COMPUTER_TEMPLATE'].some((key) => !values[key]?.trim())
  )
    throw new Error('Configure the E2B API key and computer template.');
  if (
    values.COMPUTER_PROVIDER === 'e2b' &&
    (values.E2B_BROWSER_TEMPLATE || values.E2B_WORKSPACE_TEMPLATE)
  )
    throw new Error('Migrate the separate E2B templates to E2B_COMPUTER_TEMPLATE.');
  if (
    values.OBJECT_STORAGE_PROVIDER !== 'http' ||
    values.OBJECT_STORAGE_ENDPOINT !== 'http://otto.storage/v1/objects/'
  )
    throw new Error(
      'Set OBJECT_STORAGE_PROVIDER to http and OBJECT_STORAGE_ENDPOINT to http://otto.storage/v1/objects/.',
    );
  const selected = config.env?.[environment];
  if (!selected?.containers?.length)
    throw new Error('The selected environment has no container configuration.');
  const classes = selected.containers.map((container) => container.class_name);
  if (
    classes.some(
      (name) =>
        ![
          'GatewayContainer',
          'TenantContainer',
          'BrowserComputerContainer',
          'WorkspaceComputerContainer',
        ].includes(name),
    )
  )
    throw new Error('The deployment has an unsupported container class.');
  const requiredClasses = ['GatewayContainer', 'TenantContainer'];
  if (values.COMPUTER_PROVIDER === 'cloudflare')
    requiredClasses.push('BrowserComputerContainer', 'WorkspaceComputerContainer');
  if (
    new Set(classes).size !== classes.length ||
    requiredClasses.some((name) => !classes.includes(name))
  )
    throw new Error('The deployment is missing a required container class or repeats one.');
  const localImage = `otto-${environment}:${release}`;
  const classImages = new Map([
    ['GatewayContainer', localImage],
    ['TenantContainer', localImage],
    ['BrowserComputerContainer', `otto-${environment}-browser:${release}`],
    ['WorkspaceComputerContainer', `otto-${environment}-workspace:${release}`],
  ]);
  const localImages = new Set();
  const gatewaySecret = JSON.stringify({ ...values, OTTO_RELEASE: release });
  if (Buffer.byteLength(gatewaySecret) > 5 * 1024)
    throw new Error('The compact gateway configuration exceeds the Worker secret size limit.');
  const deployment = structuredClone(config);
  delete deployment.$schema;
  deployment.main = resolve(packageDirectory, deployment.main);
  deployment.assets.directory = resolve(packageDirectory, deployment.assets.directory);
  deployment.account_id = accountId;
  deployment.env = {
    [environment]: {
      ...selected,
      vars: {
        ...selected.vars,
        OTTO_ENVIRONMENT: environment,
        OTTO_PUBLIC_URL: origin.origin,
        OTTO_DEPLOYMENT_MANAGED: 'true',
      },
      containers: selected.containers.map((container) => {
        const selectedImage = classImages.get(container.class_name);
        if (!selectedImage) throw new Error('The deployment has an unsupported container class.');
        localImages.add(selectedImage);
        const result = {
          ...container,
          name:
            container.name ||
            `${selected.name || config.name}-${container.class_name}-${environment}`
              .toLowerCase()
              .replaceAll(' ', '-'),
          image: `registry.cloudflare.com/${accountId}/${selectedImage}`,
        };
        delete result.image_build_context;
        delete result.image_vars;
        return result;
      }),
    },
  };
  return {
    config: deployment,
    localImage,
    localImages: [...localImages],
    origin: origin.origin,
    release,
    secrets: { GATEWAY_ENV: gatewaySecret },
  };
}

function command(args, environment) {
  return new Promise((complete, reject) => {
    const child = spawn(
      process.execPath,
      [join(packageDirectory, 'node_modules/wrangler/bin/wrangler.js'), ...args],
      {
        cwd: packageDirectory,
        env: environment,
        stdio: 'ignore',
        timeout: 15 * 60 * 1000,
        killSignal: 'SIGTERM',
      },
    );
    child.once('error', () =>
      reject(new Error('The Cloudflare deployment command could not start.')),
    );
    child.once('exit', (code) => {
      if (code === 0) complete();
      else
        reject(
          new Error(
            'The Cloudflare deployment command failed. No automatic rollback was attempted.',
          ),
        );
    });
  });
}

export async function deploy(environment, variables = process.env, dependencies = {}) {
  const run = dependencies.command ?? command;
  const smoke = dependencies.smoke ?? verifyDeployment;
  const report = dependencies.report ?? ((message) => process.stdout.write(`${message}\n`));
  let configuration = dependencies.config;
  if (!configuration) {
    const parsed = ts.parseConfigFileTextToJson(
      'wrangler.jsonc',
      await readFile(join(packageDirectory, 'wrangler.jsonc'), 'utf8'),
    );
    if (parsed.error) throw new Error('The Cloudflare deployment configuration is invalid.');
    configuration = parsed.config;
  }
  if (!variables.CLOUDFLARE_API_TOKEN)
    throw new Error('Configure the Cloudflare deployment token.');
  const renamedVariables = {
    ...variables,
    GATEWAY_ENV: renameGatewayEnvironment(variables.GATEWAY_ENV, variables.OTTO_PUBLIC_URL),
  };
  const plan = deploymentPlan({
    environment,
    release: renamedVariables.OTTO_RELEASE,
    accountId: renamedVariables.CLOUDFLARE_ACCOUNT_ID,
    publicUrl: renamedVariables.OTTO_PUBLIC_URL,
    gatewayEnv: renamedVariables.GATEWAY_ENV,
    config: configuration,
  });
  const lifecycle =
    dependencies.deploymentControl ??
    createDeploymentClient({ environment, plan, variables: renamedVariables });
  const digest = dependencies.imageDigest ?? inspectImageDigest;
  const ensureBucket = dependencies.ensureBucket ?? ensureStorageBucket;
  const privateDirectory = await mkdtemp(join(tmpdir(), 'otto-deploy-'));
  await chmod(privateDirectory, 0o700);
  try {
    const configPath = join(privateDirectory, 'wrangler.json');
    const secretPath = join(privateDirectory, 'secrets.json');
    await writeFile(configPath, JSON.stringify(plan.config), { mode: 0o600 });
    await writeFile(secretPath, JSON.stringify(plan.secrets), { mode: 0o600 });
    const childEnvironment = Object.fromEntries(
      Object.entries(variables).filter(
        ([key, value]) =>
          value !== undefined &&
          /^(PATH|HOME|USERPROFILE|SYSTEMROOT|TEMP|TMP|TMPDIR|DOCKER_HOST|DOCKER_CONFIG|DOCKER_CONTEXT|XDG_CONFIG_HOME|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)$/.test(
            key,
          ),
      ),
    );
    childEnvironment.CI = 'true';
    childEnvironment.WRANGLER_SEND_METRICS = 'false';
    childEnvironment.WRANGLER_LOG_PATH = join(privateDirectory, 'wrangler.log');
    const storage = plan.config.env[environment].r2_buckets?.find(
      (binding) => binding.binding === 'TENANT_FILES',
    );
    if (!storage?.bucket_name || storage.jurisdiction !== 'eu')
      throw new Error('The deployment has no EU private object bucket.');
    report('Preparing the private object bucket.');
    await ensureBucket(
      variables.CLOUDFLARE_ACCOUNT_ID,
      variables.CLOUDFLARE_API_TOKEN,
      storage.bucket_name,
    );
    report('Publishing the verified container images.');
    for (const image of plan.localImages)
      await run(
        ['containers', 'push', image, '--env', environment, '--config', configPath],
        childEnvironment,
      );
    report('Verifying the published image digests.');
    await pinDeploymentImages(plan, environment, childEnvironment, digest);
    await writeFile(configPath, JSON.stringify(plan.config), { mode: 0o600 });
    report('Pausing admission and waiting for clean tenant checkpoints.');
    await lifecycle.prepare();
    await lifecycle.activate();
    report('Deploying Worker code, the image reference and gateway secrets.');
    await run(
      [
        'deploy',
        '--env',
        environment,
        '--config',
        configPath,
        '--secrets-file',
        secretPath,
        '--containers-rollout',
        'immediate',
        '--tag',
        plan.release,
        '--message',
        `Commit ${plan.release}`,
      ],
      childEnvironment,
    );
    report('Waiting for every container role to finish its image rollout.');
    await lifecycle.verifyRollouts();
    report('Waiting for the new release and checking public authorization.');
    await smoke({ origin: plan.origin, release: plan.release });
    await lifecycle.initialize();
    await lifecycle.complete();
    report('The deployed release passed health and unauthenticated boundary checks.');
  } catch (error) {
    await lifecycle.abort().catch(() => {});
    throw error;
  } finally {
    await rm(privateDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await deploy(process.argv[2]);
  } catch {
    process.stderr.write(
      'Deployment or verification failed. Inspect deployment status before a controlled retry; no rollback was attempted.\n',
    );
    process.exitCode = 1;
  }
}
