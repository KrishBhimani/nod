import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Composio } from '@composio/core';
import { createComposioProvider } from '../src/providers/composio/integrations.ts';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const webhookUrl = 'https://otto.example.test/api/webhooks/composio';
const toolkitVersions = { gmail: '20260915_00', googlecalendar: '20260915_00' };

for (const destination of [undefined, webhookUrl]) {
  test(`Composio subscriptions preserve exact owner, account and versions with ${destination ? 'hosted' : 'project'} routing`, async (t) => {
    const client = new Composio({
      apiKey: 'fixture-key-never-live',
      allowTracking: false,
      disableVersionCheck: true,
      fileUploadDirs: false,
      toolkitVersions,
    });
    const calls: unknown[] = [];
    t.mock.method(client.triggers, 'getType', async () => ({}));
    t.mock.method(
      client.getClient().triggerInstances,
      'upsert',
      async (slug: string, input: unknown) => {
        calls.push({ slug, input });
        return { trigger_id: 'ti-fixture' };
      },
    );
    t.mock.method(client.getClient().webhookSubscriptions, 'create', async () => {
      assert.fail('Watch creation cannot change a project subscription.');
    });
    t.mock.method(client.getClient().webhookSubscriptions, 'update', async () => {
      assert.fail('Watch creation cannot change a project subscription.');
    });
    const provider = createComposioProvider({
      client,
      webhookSecret: 'fixture-signature',
      webhookUrl: destination,
    });
    assert.deepEqual(await provider.subscribe(owner, 'gmail', 'ca-gmail-fixture'), {
      id: 'ti-fixture',
    });
    assert.deepEqual(await provider.subscribe(owner, 'googlecalendar', 'ca-calendar-fixture'), {
      id: 'ti-fixture',
    });
    assert.deepEqual(calls, [
      {
        slug: 'GMAIL_NEW_GMAIL_MESSAGE',
        input: {
          connected_account_id: 'ca-gmail-fixture',
          user_id: owner,
          trigger_config: { interval: 15, query: 'in:inbox', userId: 'me' },
          toolkit_versions: toolkitVersions,
          ...(destination ? { egress_url: destination } : {}),
        },
      },
      {
        slug: 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER',
        input: {
          connected_account_id: 'ca-calendar-fixture',
          user_id: owner,
          trigger_config: { interval: 15, calendarId: 'primary', showDeleted: true },
          toolkit_versions: toolkitVersions,
          ...(destination ? { egress_url: destination } : {}),
        },
      },
    ]);
    t.mock.method(client.getClient().triggerInstances, 'upsert', async () => {
      throw new Error('Fixture subscription is unavailable.');
    });
    await assert.rejects(provider.subscribe(owner, 'gmail', 'ca-gmail-fixture'));
  });
}

test('Composio rejects malformed configured webhook destinations before creating a provider client', () => {
  for (const destination of [
    '',
    'not-a-url',
    'http://otto.example.test/api/webhooks/composio',
    'https://otto.example.test/api/webhooks/other',
    'https://private@otto.example.test/api/webhooks/composio',
    webhookUrl + '?secret=private',
    webhookUrl + '#private',
  ]) {
    assert.throws(() => createComposioProvider({ webhookUrl: destination }), {
      message: 'The Composio webhook URL is invalid.',
    });
  }
});

test('composition passes only the configured tenant webhook URL to the Composio adapter', () => {
  const base = new URL('../src/', import.meta.url).href;
  for (const mode of ['local', 'tenant'] as const) {
    const script = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      const modules = new Map([
        [${JSON.stringify(base + 'providers/e2b/index.ts')}, 'export const createE2BAdapters=()=>({computer:{},workspace:{}})'],
        [${JSON.stringify(base + 'server/computer-allocations.ts')}, 'export const createComputerAllocationStore=()=>({})'],
        [${JSON.stringify(base + 'server/object-storage.ts')}, 'export const createPostgresObjectStore=()=>({})'],
        [${JSON.stringify(base + 'providers/composio/integrations.ts')}, 'export const createComposioProvider=(options)=>{globalThis.integrationOptions=options;return {}}'],
      ]);
      registerHooks({load(url,context,next){const source=modules.get(url);return source===undefined?next(url,context):{format:'module',source,shortCircuit:true}}});
      globalThis.fetch=()=>{throw new Error('Unexpected provider request')};
      const {createDefaultAdapters}=await import(${JSON.stringify(base + 'server/composition.ts')});
      const destination=${JSON.stringify(mode === 'tenant' ? webhookUrl : null)} ?? undefined;
      createDefaultAdapters({...process.env,COMPUTER_PROVIDER:'e2b',E2B_API_KEY:'synthetic-unused',E2B_COMPUTER_TEMPLATE:'combined-template',OTTO_CONTROL_URL:'http://otto.control',OBJECT_STORAGE_PROVIDER:'postgres',COMPOSIO_API_KEY:'fixture-provider-key',COMPOSIO_WEBHOOK_SECRET:'fixture-signature',OTTO_COMPOSIO_WEBHOOK_URL:destination});
      assert.equal(globalThis.integrationOptions.webhookUrl,destination);
      assert.equal(globalThis.integrationOptions.webhookSecret,'fixture-signature');
      assert.equal(globalThis.integrationOptions.apiKey,'fixture-provider-key');
      process.stdout.write('composition passed');
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          DOTENV_CONFIG_PATH: '/tmp/otto-synthetic-missing-env',
          OTTO_MODE: mode,
          OTTO_OWNER_ID: owner,
          OTTO_RUNTIME_GENERATION: '17',
          OTTO_RUNTIME_SECRET: Buffer.alloc(32, 1).toString('base64url'),
          OTTO_VAULT_KEY: Buffer.alloc(32, 2).toString('base64'),
          OTTO_DATA_ROOT: '/tmp/otto-synthetic-composio-composition',
          DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
          PGBOSS_SCHEMA: 'sk_jobs_' + 'a'.repeat(32),
        },
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'composition passed');
  }
});
