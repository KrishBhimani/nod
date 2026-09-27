import { spawn } from 'node:child_process';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repository = fileURLToPath(new URL('..', import.meta.url));
const systemKeys =
  /^(PATH|HOME|USERPROFILE|SYSTEMROOT|TEMP|TMP|TMPDIR|SHELL|LANG|LC_ALL|TERM|COLORTERM)$/;

export function cloudflareLocalPlan(environment, config, root = repository) {
  if (
    environment.COMPUTER_PROVIDER !== 'cloudflare' ||
    environment.SIDEKICK_ENVIRONMENT === 'production' ||
    environment.SIDEKICK_PUBLIC_URL !== 'http://localhost:4330'
  )
    throw new Error('Configure an isolated local Cloudflare development environment.');
  const { env, $schema, ...common } = config;
  const selected = env?.development;
  if (!selected?.containers?.length)
    throw new Error('The development container configuration is missing.');
  const directory = resolve(root, 'deployment/cloudflare');
  const gateway = Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        value &&
        !systemKeys.test(key) &&
        ![
          'DOTENV_CONFIG_PATH',
          'SIDEKICK_DATA_ROOT',
          'SIDEKICK_BIND_HOST',
          'PORT',
          'NODE_ENV',
          'CLOUDFLARE_API_TOKEN',
          'CLOUDFLARE_ACCOUNT_ID',
        ].includes(key),
    ),
  );
  const secret = JSON.stringify({
    ...gateway,
    OBJECT_STORAGE_PROVIDER: 'http',
    OBJECT_STORAGE_ENDPOINT: 'http://sidekick.storage/v1/objects/',
  });
  if (Buffer.byteLength(secret) > 5 * 1024)
    throw new Error('The compact gateway configuration exceeds the Worker secret size limit.');
  const local = {
    ...common,
    ...selected,
    name: 'sidekick-development-local',
    main: resolve(directory, common.main),
    assets: { ...common.assets, directory: resolve(directory, common.assets.directory) },
    dev: { ip: '127.0.0.1', port: 4330, inspector_port: 9330 },
    vars: {
      SIDEKICK_ENVIRONMENT: environment.SIDEKICK_ENVIRONMENT,
      SIDEKICK_PUBLIC_URL: 'http://localhost:4330',
    },
    containers: selected.containers.map((container) => ({
      ...container,
      image: resolve(directory, container.image),
      image_build_context: resolve(directory, container.image_build_context),
    })),
  };
  delete local.triggers;
  delete local.account_id;
  return {
    config: local,
    secret,
    devVars: `GATEWAY_ENV='${secret.replace(/'/g, '\\u0027')}'\n`,
    environment: Object.fromEntries(
      Object.entries(environment).filter(([key]) => systemKeys.test(key)),
    ),
  };
}

export async function startCloudflareLocal(environment, { root = repository } = {}) {
  const packageDirectory = resolve(root, 'deployment/cloudflare');
  const wrangler = join(packageDirectory, 'node_modules/wrangler/bin/wrangler.js');
  try {
    await access(wrangler);
    await access(resolve(root, 'dist/web/index.html'));
  } catch {
    throw new Error('Run npm run build and npm --prefix deployment/cloudflare ci first.');
  }
  const parsed = ts.parseConfigFileTextToJson(
    'wrangler.jsonc',
    await readFile(join(packageDirectory, 'wrangler.jsonc'), 'utf8'),
  );
  if (parsed.error) throw new Error('The Cloudflare development configuration is invalid.');
  const plan = cloudflareLocalPlan(environment, parsed.config, root);
  const directory = resolve(root, '.local/cloudflare-development');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const configFile = join(directory, 'wrangler.json');
  const secretFile = join(directory, '.dev.vars');
  await writeFile(configFile, JSON.stringify(plan.config, null, 2), { mode: 0o600 });
  await writeFile(secretFile, plan.devVars, { mode: 0o600 });
  await chmod(secretFile, 0o600);
  const child = spawn(
    process.execPath,
    [wrangler, 'dev', '--config', configFile, '--local', '--show-interactive-dev-session=false'],
    {
      cwd: root,
      env: { ...plan.environment, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_LEVEL: 'warn' },
      stdio: 'inherit',
    },
  );
  console.log('Starting the local Cloudflare stack at http://localhost:4330.');
  const handlers = new Map(
    ['SIGINT', 'SIGTERM'].map((signal) => [signal, () => child.kill(signal)]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    await new Promise((complete, reject) => {
      child.once('error', () => reject(new Error('Local Cloudflare development could not start.')));
      child.once('exit', (code) => {
        process.exitCode = code ?? 1;
        complete();
      });
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    await rm(secretFile, { force: true });
  }
}
