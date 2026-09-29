import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { provisionStorage } from '../scripts/provision-storage.mjs';

const accountId = 'a'.repeat(32);
const variables = {
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_R2_OPERATOR_TOKEN: 'synthetic-operator-token',
};
const bucket = 'otto-production-files';
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`;
const config = {
  env: {
    production: {
      r2_buckets: [{ binding: 'TENANT_FILES', bucket_name: bucket, jurisdiction: 'eu' }],
    },
    development: {
      r2_buckets: [
        { binding: 'TENANT_FILES', bucket_name: 'otto-development-files', jurisdiction: 'eu' },
      ],
    },
  },
};
const success = (result) => Response.json({ success: true, errors: [], result });
const metadata = (name = bucket) => ({ name, jurisdiction: 'eu' });
const missing = () => Response.json({ success: false, errors: [{ code: 10006 }] }, { status: 404 });

function fixture(responses) {
  const calls = [];
  return {
    calls,
    request: async (url, options) => {
      calls.push({ url, options });
      assert.ok(responses.length > 0, 'Unexpected provider request.');
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function verification(name = bucket, domains = []) {
  return [
    success(metadata(name)),
    success({ enabled: false }),
    success({ domains }),
    success(metadata(name)),
  ];
}

test('existing exact EU storage is verified using metadata only and the separate operator token', async () => {
  const f = fixture(verification(bucket, [{ domain: 'disabled.example.test', enabled: false }]));
  const result = await provisionStorage('production', variables, { config, request: f.request });
  assert.deepEqual(result, {
    environment: 'production',
    bucket,
    jurisdiction: 'eu',
    created: false,
    publicAccess: false,
  });
  assert.deepEqual(
    f.calls.map((call) => [call.options.method, call.url]),
    ['', '/domains/managed', '/domains/custom', ''].map((suffix) => [
      'GET',
      `${endpoint}/${bucket}${suffix}`,
    ]),
  );
  for (const { options } of f.calls) {
    assert.equal(options.headers.authorization, 'Bearer synthetic-operator-token');
    assert.equal(options.headers['cf-r2-jurisdiction'], 'eu');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body, undefined);
  }
});

test('only explicit missing storage permits one exact EU bucket creation followed by full verification', async () => {
  const f = fixture([missing(), success(metadata()), ...verification()]);
  const result = await provisionStorage('production', variables, { config, request: f.request });
  assert.equal(result.created, true);
  assert.equal(f.calls.length, 6);
  const mutations = f.calls.filter((call) => call.options.method !== 'GET');
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].url, endpoint);
  assert.equal(mutations[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(mutations[0].options.body), { name: bucket });
  assert.equal(mutations[0].options.headers['cf-r2-jurisdiction'], 'eu');
});

test('development selects only its configured bucket', async () => {
  const name = 'otto-development-files';
  const f = fixture(verification(name));
  const result = await provisionStorage('development', variables, { config, request: f.request });
  assert.equal(result.bucket, name);
  assert.ok(f.calls.every((call) => call.url.startsWith(`${endpoint}/${name}`)));
});

test('invalid environment, credentials and ambiguous bindings fail before any request', async () => {
  const cases = [
    ['staging', variables, config],
    ['production', { ...variables, CLOUDFLARE_ACCOUNT_ID: '../foreign' }, config],
    [
      'production',
      { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: 'deployment-token' },
      config,
    ],
    ['production', { ...variables, CLOUDFLARE_R2_OPERATOR_TOKEN: 'bad\ntoken' }, config],
    ['production', variables, { env: { production: {} } }],
    ['production', variables, { env: { production: { r2_buckets: [] } } }],
    [
      'production',
      variables,
      {
        env: {
          production: {
            r2_buckets: [...config.env.production.r2_buckets, ...config.env.production.r2_buckets],
          },
        },
      },
    ],
    [
      'production',
      variables,
      {
        env: {
          production: {
            r2_buckets: [
              { binding: 'TENANT_FILES', bucket_name: '../foreign', jurisdiction: 'eu' },
            ],
          },
        },
      },
    ],
    [
      'production',
      variables,
      {
        env: {
          production: {
            r2_buckets: [{ binding: 'TENANT_FILES', bucket_name: bucket, jurisdiction: 'default' }],
          },
        },
      },
    ],
  ];
  for (const [environment, values, configuration] of cases) {
    let calls = 0;
    await assert.rejects(
      provisionStorage(environment, values, {
        config: configuration,
        request: async () => {
          calls += 1;
        },
      }),
      /Storage provisioning failed\./,
    );
    assert.equal(calls, 0);
  }
});

test('denied, ambiguous missing and malformed API responses never authorize creation', async () => {
  const responses = [
    Response.json(
      { success: false, errors: [{ code: 10000, message: 'private detail' }] },
      { status: 403 },
    ),
    new Response(null, { status: 404 }),
    Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 404 }),
    Response.json({ success: false, errors: [{ code: 10006 }, { code: 10000 }] }, { status: 404 }),
    Response.json({ success: true, errors: [{ code: 10006 }] }, { status: 404 }),
    Response.json({ result: metadata() }),
    Response.json({ success: true, errors: [{ code: 10000 }], result: metadata() }),
    success({ name: 'foreign-bucket', jurisdiction: 'eu' }),
    success({ name: bucket, jurisdiction: 'default' }),
    success({ name: bucket }),
    new Response('private malformed body'),
    new Error('private transport detail'),
  ];
  for (const response of responses) {
    const f = fixture([response]);
    await assert.rejects(
      provisionStorage('production', variables, { config, request: f.request }),
      { message: 'Storage provisioning failed.' },
    );
    assert.equal(f.calls.length, 1);
  }
});

test('unknown create outcomes stop without retry or privacy changes', async () => {
  for (const response of [
    new Error('private failure'),
    new Response(null, { status: 403 }),
    new Response(null, { status: 409 }),
    success({ name: 'foreign', jurisdiction: 'eu' }),
  ]) {
    const f = fixture([missing(), response]);
    await assert.rejects(
      provisionStorage('production', variables, { config, request: f.request }),
      { message: 'Storage provisioning failed.' },
    );
    assert.equal(f.calls.length, 2);
  }
});

test('public access and unknown privacy responses refuse success without changing settings', async () => {
  const cases = [
    [success(metadata()), success({ enabled: true })],
    [success(metadata()), success({})],
    [success(metadata()), new Response(null, { status: 403 })],
    [
      success(metadata()),
      success({ enabled: false }),
      success({ domains: [{ domain: 'public.example.test', enabled: true }] }),
    ],
    [success(metadata()), success({ enabled: false }), success({ domains: [{}] })],
    [success(metadata()), success({ enabled: false }), success({})],
    [
      success(metadata()),
      success({ enabled: false }),
      Response.json({
        success: true,
        errors: [],
        result: { domains: [] },
        result_info: { cursor: 'more' },
      }),
    ],
    [
      success(metadata()),
      success({ enabled: false }),
      success({ domains: [] }),
      success({ name: bucket, jurisdiction: 'default' }),
    ],
  ];
  for (const responses of cases) {
    const f = fixture(responses);
    await assert.rejects(
      provisionStorage('production', variables, { config, request: f.request }),
      { message: 'Storage provisioning failed.' },
    );
    assert.ok(f.calls.every((call) => call.options.method === 'GET'));
  }
});

test('metadata bodies are bounded before parsing and transport errors remain fixed', async () => {
  for (const response of [
    new Response('x', { headers: { 'content-length': '65537' } }),
    new Response('x'.repeat(65537)),
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('private stream failure'));
        },
      }),
    ),
  ]) {
    const f = fixture([response]);
    await assert.rejects(
      provisionStorage('production', variables, { config, request: f.request }),
      { message: 'Storage provisioning failed.' },
    );
    assert.equal(f.calls.length, 1);
  }
});

test('an unanswered request is aborted at its deadline without retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let signal;
  const pending = provisionStorage('production', variables, {
    config,
    request: async (_url, options) => {
      calls += 1;
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('private timeout detail')), {
          once: true,
        });
      });
    },
  });
  const refused = assert.rejects(pending, { message: 'Storage provisioning failed.' });
  assert.equal(calls, 1);
  t.mock.timers.tick(9999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await refused;
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
});

test('failed privacy verification after creation never attempts repair or rollback', async () => {
  const f = fixture([
    missing(),
    success(metadata()),
    success(metadata()),
    success({ enabled: true }),
  ]);
  await assert.rejects(provisionStorage('production', variables, { config, request: f.request }), {
    message: 'Storage provisioning failed.',
  });
  assert.deepEqual(
    f.calls.map((call) => call.options.method),
    ['GET', 'POST', 'GET', 'GET'],
  );
});

test('the CLI requires one environment and does not fall back to deployment credentials', async () => {
  for (const args of [[], ['production', 'unexpected'], ['production']]) {
    const result = spawnSync(process.execPath, ['scripts/provision-storage.mjs', ...args], {
      cwd: new URL('..', import.meta.url),
      env: {
        PATH: process.env.PATH,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: 'synthetic-deployment-token',
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Storage provisioning failed.\n');
  }
});
