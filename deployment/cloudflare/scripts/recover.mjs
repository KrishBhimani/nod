import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { deploymentPlan, verifyStorageBinding } from './deploy.mjs';
import { createDeploymentClient, pinDeploymentImages } from './drain.mjs';
import { verifyDeployment } from './smoke.mjs';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function recoverDeployment(
  environment,
  action,
  variables = process.env,
  dependencies = {},
) {
  if (!['status', 'abort', 'complete'].includes(action))
    throw new Error('Choose status, abort or complete for the existing deployment.');
  if (!variables.CLOUDFLARE_API_TOKEN)
    throw new Error('Configure the Cloudflare deployment token.');
  let configuration = dependencies.config;
  if (!configuration) {
    const parsed = ts.parseConfigFileTextToJson(
      'wrangler.jsonc',
      await readFile(join(packageDirectory, 'wrangler.jsonc'), 'utf8'),
    );
    if (parsed.error) throw new Error('The Cloudflare deployment configuration is invalid.');
    configuration = parsed.config;
  }
  const plan = deploymentPlan({
    environment,
    release: variables.OTTO_RELEASE,
    accountId: variables.CLOUDFLARE_ACCOUNT_ID,
    publicUrl: variables.OTTO_PUBLIC_URL,
    gatewayEnv: variables.GATEWAY_ENV,
    config: configuration,
  });
  const lifecycle =
    dependencies.deploymentControl ?? createDeploymentClient({ environment, plan, variables });
  const report = dependencies.report ?? ((message) => process.stdout.write(`${message}\n`));
  const state = await lifecycle.recover();
  if (action === 'status') {
    report(JSON.stringify(state));
    return state;
  }
  if (action === 'abort') {
    if (!['draining', 'prepared', 'aborting', 'failed', 'aborted'].includes(state.phase))
      throw new Error('An activated deployment cannot be aborted.');
    await lifecycle.abort();
    report('The existing deployment was safely aborted.');
    return;
  }
  if (!['activating', 'complete'].includes(state.phase))
    throw new Error('Only an activated deployment can be completed.');
  const childEnvironment = Object.fromEntries(
    Object.entries(variables).filter(
      ([key, value]) =>
        value !== undefined &&
        /^(PATH|HOME|USERPROFILE|SYSTEMROOT|TEMP|TMP|TMPDIR|DOCKER_HOST|DOCKER_CONFIG|DOCKER_CONTEXT|XDG_CONFIG_HOME)$/.test(
          key,
        ),
    ),
  );
  await pinDeploymentImages(plan, environment, childEnvironment, dependencies.imageDigest);
  await verifyStorageBinding(
    plan,
    environment,
    variables.CLOUDFLARE_API_TOKEN,
    dependencies.request,
  );
  await lifecycle.verifyRollouts();
  await (dependencies.smoke ?? verifyDeployment)({ origin: plan.origin, release: plan.release });
  await lifecycle.complete();
  report('The existing deployment passed verification and reopened admission.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await recoverDeployment(process.argv[2], process.argv[3]);
  } catch {
    process.stderr.write(
      'Deployment recovery did not pass safety checks; admission remains unchanged or closed.\n',
    );
    process.exitCode = 1;
  }
}
