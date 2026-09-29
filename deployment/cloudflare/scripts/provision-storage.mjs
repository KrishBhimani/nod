import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const failureMessage = 'Storage provisioning failed.';
const responseBytes = 64 * 1024;
const bucketName = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readResponse(response) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > responseBytes))
    throw new Error(failureMessage);
  if (!response.body) throw new Error(failureMessage);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > responseBytes) throw new Error(failureMessage);
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  if (!record(value) || !Array.isArray(value.errors) || value.result_info != null)
    throw new Error(failureMessage);
  return value;
}

function requireSuccess(response) {
  if (
    response.status !== 200 ||
    response.data.success !== true ||
    response.data.errors.length !== 0 ||
    !record(response.data.result)
  )
    throw new Error(failureMessage);
  return response.data.result;
}

function requireBucket(response, name) {
  const result = requireSuccess(response);
  if (result.name !== name || result.jurisdiction !== 'eu') throw new Error(failureMessage);
}

export async function provisionStorage(environment, variables, dependencies = {}) {
  try {
    if (!['development', 'production'].includes(environment)) throw new Error(failureMessage);
    const accountId = variables.CLOUDFLARE_ACCOUNT_ID;
    const token = variables.CLOUDFLARE_R2_OPERATOR_TOKEN;
    if (
      typeof accountId !== 'string' ||
      !/^[a-f0-9]{32}$/.test(accountId) ||
      typeof token !== 'string' ||
      !/^[\x21-\x7e]{1,4096}$/.test(token)
    )
      throw new Error(failureMessage);
    const parsed = dependencies.config
      ? { config: dependencies.config }
      : ts.parseConfigFileTextToJson(
          'wrangler.jsonc',
          await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
        );
    if (parsed.error) throw new Error(failureMessage);
    const bindings = parsed.config?.env?.[environment]?.r2_buckets;
    if (
      !Array.isArray(bindings) ||
      bindings.length !== 1 ||
      bindings[0]?.binding !== 'TENANT_FILES' ||
      typeof bindings[0]?.bucket_name !== 'string' ||
      !bucketName.test(bindings[0].bucket_name) ||
      bindings[0].jurisdiction !== 'eu'
    )
      throw new Error(failureMessage);
    const bucket = bindings[0].bucket_name;
    const collection = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`;
    const endpoint = `${collection}/${bucket}`;
    const request = dependencies.request ?? fetch;
    const send = async (url, method = 'GET', body) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      timer.unref();
      try {
        const response = await request(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            'cf-r2-jurisdiction': 'eu',
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          redirect: 'error',
          cache: 'no-store',
        });
        return { status: response.status, data: await readResponse(response) };
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    };
    let current = await send(endpoint);
    let created = false;
    if (
      current.status === 404 &&
      current.data.success === false &&
      current.data.errors.length === 1 &&
      current.data.errors[0]?.code === 10006
    ) {
      requireBucket(await send(collection, 'POST', { name: bucket }), bucket);
      created = true;
      current = await send(endpoint);
    }
    requireBucket(current, bucket);
    const managed = requireSuccess(await send(`${endpoint}/domains/managed`));
    if (managed.enabled !== false) throw new Error(failureMessage);
    const custom = requireSuccess(await send(`${endpoint}/domains/custom`));
    if (
      !Array.isArray(custom.domains) ||
      custom.domains.length > 100 ||
      custom.domains.some(
        (domain) =>
          !record(domain) ||
          typeof domain.domain !== 'string' ||
          domain.domain.length === 0 ||
          domain.domain.length > 253 ||
          domain.enabled !== false,
      )
    )
      throw new Error(failureMessage);
    requireBucket(await send(endpoint), bucket);
    return { environment, bucket, jurisdiction: 'eu', created, publicAccess: false };
  } catch {
    throw new Error(failureMessage);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error(failureMessage);
    const result = await provisionStorage(process.argv[2], process.env);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write(`${failureMessage}\n`);
    process.exitCode = 1;
  }
}
