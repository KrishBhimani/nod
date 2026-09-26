import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { verifyDeployment } from './smoke.mjs';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function deploymentPlan({ environment, release, accountId, publicUrl, gatewayEnv, config }) {
  if (!['development', 'production'].includes(environment))
    throw new Error('Choose the development or production deployment environment.');
  if (!/^[a-f0-9]{40}$/.test(release ?? ''))
    throw new Error('Set SIDEKICK_RELEASE to the tested Git commit.');
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
    throw new Error('Set SIDEKICK_PUBLIC_URL to the canonical production HTTPS origin.');
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
        key === 'SIDEKICK_IMAGE_RELEASE' ||
        typeof value !== 'string' ||
        value.includes('\0') ||
        value.length > 32768,
    )
  )
    throw new Error('GATEWAY_ENV must contain bounded server environment strings.');
  if (values.SIDEKICK_ENVIRONMENT && values.SIDEKICK_ENVIRONMENT !== environment)
    throw new Error('The gateway configuration belongs to another environment.');
  if (values.SIDEKICK_PUBLIC_URL && values.SIDEKICK_PUBLIC_URL !== origin.origin)
    throw new Error('The gateway configuration uses another application origin.');
  const selected = config.env?.[environment];
  if (!selected?.containers?.length)
    throw new Error('The selected environment has no container configuration.');
  const localImage = `sidekick-${environment}:${release}`;
  const image = `registry.cloudflare.com/${accountId}/${localImage}`;
  const gatewaySecret = JSON.stringify({ ...values, SIDEKICK_RELEASE: release });
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
        SIDEKICK_ENVIRONMENT: environment,
        SIDEKICK_PUBLIC_URL: origin.origin,
      },
      containers: selected.containers.map((container) => {
        const result = { ...container, image };
        delete result.image_build_context;
        delete result.image_vars;
        return result;
      }),
    },
  };
  return {
    config: deployment,
    localImage,
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
  const parsed = ts.parseConfigFileTextToJson(
    'wrangler.jsonc',
    await readFile(join(packageDirectory, 'wrangler.jsonc'), 'utf8'),
  );
  if (parsed.error) throw new Error('The Cloudflare deployment configuration is invalid.');
  if (!variables.CLOUDFLARE_API_TOKEN)
    throw new Error('Configure the Cloudflare deployment token.');
  const plan = deploymentPlan({
    environment,
    release: variables.SIDEKICK_RELEASE,
    accountId: variables.CLOUDFLARE_ACCOUNT_ID,
    publicUrl: variables.SIDEKICK_PUBLIC_URL,
    gatewayEnv: variables.GATEWAY_ENV,
    config: parsed.config,
  });
  const privateDirectory = await mkdtemp(join(tmpdir(), 'sidekick-deploy-'));
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
    report('Publishing the verified container image.');
    await run(
      ['containers', 'push', plan.localImage, '--env', environment, '--config', configPath],
      childEnvironment,
    );
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
    report('Waiting for the new release and checking public authorization.');
    await smoke({ origin: plan.origin, release: plan.release });
    report('The deployed release passed health and unauthenticated boundary checks.');
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
