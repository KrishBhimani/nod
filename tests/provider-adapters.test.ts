import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { Composio } from '@composio/core';
import { createComposioProvider } from '../src/providers/composio/integrations.ts';
import { createEnvironmentKeyStore } from '../src/providers/environment/key-store.ts';
import { createJevRelevanceClassifier } from '../src/providers/jev/relevance.ts';
import { createOpenAIRelevanceClassifier } from '../src/providers/openai/relevance.ts';
import { createOpenAISpeechProvider } from '../src/providers/openai/speech.ts';
import { createSpeech } from '../src/server/speech.ts';
import type { SpeechProvider } from '../src/ports/speech.ts';

const audio = Buffer.from('synthetic-audio');
const relevancePolicy = {
  instructions: 'Fixture relevance policy.',
  criteria: { ignore: 'Irrelevant', digest: 'Later', wake: 'Timely' },
  minWakeConfidence: 0.8,
};

test('speech policy works with a replacement provider and bounds input, output, cancellation, and errors', async () => {
  let calls = 0;
  const provider: SpeechProvider = {
    id: 'fixture',
    configured: true,
    transcribe: async () => {
      calls++;
      return 'Transcribed fixture.';
    },
    synthesize: async () => {
      calls++;
      return { bytes: audio, mimeType: 'audio/ogg', fileName: 'fixture.ogg' };
    },
  };
  const speech = createSpeech(provider);
  assert.equal(
    await speech.transcribe({ bytes: audio, mimeType: 'audio/webm', fileName: 'input.webm' }),
    'Transcribed fixture.',
  );
  assert.equal((await speech.synthesize('Hello fixture.')).mimeType, 'audio/ogg');
  await assert.rejects(speech.synthesize('x'.repeat(3001)));
  await assert.rejects(
    speech.transcribe({ bytes: audio, mimeType: 'text/plain', fileName: 'text.txt' }),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(speech.synthesize('Hello fixture.', controller.signal));
  assert.equal(calls, 2);
  provider.configured = false;
  await assert.rejects(
    speech.synthesize('Hello fixture.'),
    (error) => error instanceof Error && 'statusCode' in error && error.statusCode === 503,
  );
  assert.equal(calls, 2);
  provider.configured = true;
  provider.synthesize = async () => {
    throw new Error('raw-provider-secret');
  };
  await assert.rejects(speech.synthesize('Hello fixture.'), {
    message: 'Speech generation failed.',
  });
  provider.synthesize = async () => ({
    bytes: Buffer.alloc(15 * 1024 * 1024 + 1),
    mimeType: 'audio/mpeg',
    fileName: 'reply.mp3',
  });
  await assert.rejects(speech.synthesize('Hello fixture.'), {
    message: 'Speech generation failed.',
  });
});

test('OpenAI speech adapter preserves media metadata and validates transcription responses', async () => {
  let malformed = false;
  const provider = createOpenAISpeechProvider({
    apiKey: 'speech-fixture-key',
    transcriptionModel: 'fixture-stt',
    speechModel: 'fixture-tts',
    fetch: async (url, init) => {
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        'Bearer speech-fixture-key',
      );
      if (String(url).endsWith('/transcriptions')) {
        const form = init?.body as FormData;
        const file = form.get('file') as File;
        assert.equal(file.name, 'capture.mp4');
        assert.equal(file.type, 'audio/mp4');
        assert.equal(form.get('model'), 'fixture-stt');
        return Response.json(
          malformed ? { secret: 'untrusted-response' } : { text: 'Speech fixture.' },
        );
      }
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'fixture-tts');
      assert.equal(body.input, 'Hello fixture.');
      assert.equal(body.response_format, 'mp3');
      assert.equal(JSON.stringify(body).includes('speech-fixture-key'), false);
      return new Response(audio);
    },
  });
  const speech = createSpeech(provider);
  assert.equal(
    await speech.transcribe({ bytes: audio, mimeType: 'audio/mp4', fileName: 'capture.mp4' }),
    'Speech fixture.',
  );
  assert.deepEqual(await speech.synthesize('Hello fixture.'), {
    bytes: audio,
    mimeType: 'audio/mpeg',
    fileName: 'reply.mp3',
  });
  malformed = true;
  await assert.rejects(
    speech.transcribe({ bytes: audio, mimeType: 'audio/mp4', fileName: 'capture.mp4' }),
    { message: 'Speech transcription failed.' },
  );
});

test('relevance adapters validate responses and Jev confidence before returning normalized decisions', async () => {
  let confidence = 0.7;
  const jev = createJevRelevanceClassifier({
    apiKey: 'fixture-jev-key',
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        'Bearer fixture-jev-key',
      );
      assert.deepEqual(JSON.parse(JSON.parse(String(init?.body)).state), { event: 'fixture' });
      return Response.json({ answers: { action: { choice: 'wake', confidence } } });
    },
  });
  assert.equal(await jev.classify({ event: 'fixture' }, relevancePolicy), 'digest');
  confidence = 0.95;
  assert.equal(await jev.classify({ event: 'fixture' }, relevancePolicy), 'wake');
  confidence = 2;
  await assert.rejects(jev.classify({ event: 'fixture' }, relevancePolicy));
  let openaiDecision = { decision: 'ignore', confidence: 0.9 };
  const openai = createOpenAIRelevanceClassifier({
    apiKey: 'fixture-openai-key',
    fetch: async (_url, init) => {
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        'Bearer fixture-openai-key',
      );
      return Response.json({ choices: [{ message: { content: JSON.stringify(openaiDecision) } }] });
    },
  });
  assert.equal(await openai.classify({ event: 'fixture' }, relevancePolicy), 'ignore');
  openaiDecision = { decision: 'wake', confidence: 0.7 };
  assert.equal(await openai.classify({ event: 'fixture' }, relevancePolicy), 'digest');
  openaiDecision = { decision: 'wake', confidence: 0.95 };
  assert.equal(await openai.classify({ event: 'fixture' }, relevancePolicy), 'wake');
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(openai.classify({}, relevancePolicy, cancelled.signal));
  await assert.rejects(jev.classify({}, relevancePolicy, cancelled.signal));
  const unavailable = createOpenAIRelevanceClassifier({
    fetch: async () => {
      assert.fail('An unconfigured adapter must not contact a provider.');
    },
  });
  assert.equal(unavailable.configured, false);
  await assert.rejects(unavailable.classify({}, relevancePolicy));
});

test('OpenAI relevance requests use catalog capabilities for reasoning and sampling overrides', async () => {
  for (const [override, expectedModel, parameters] of [
    [undefined, 'gpt-6-luna', { reasoning_effort: 'none', temperature: 0 }],
    ['gpt-4.1-nano', 'gpt-4.1-nano', { temperature: 0 }],
    ['o3-mini', 'o3-mini', {}],
    ['fixture-unknown-model', 'fixture-unknown-model', {}],
  ] as const) {
    const classifier = createOpenAIRelevanceClassifier({
      apiKey: 'fixture-never-live',
      model: override,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, expectedModel);
        assert.deepEqual(
          Object.fromEntries(
            Object.entries(body).filter(([key]) =>
              ['reasoning_effort', 'temperature'].includes(key),
            ),
          ),
          parameters,
        );
        assert.equal(body.max_completion_tokens, 256);
        assert.deepEqual(body.response_format, { type: 'json_object' });
        return Response.json({
          choices: [{ message: { content: '{"decision":"digest","confidence":0.9}' } }],
        });
      },
    });
    assert.equal(await classifier.classify({ event: 'fixture' }, relevancePolicy), 'digest');
  }
});

test('Composio sessions omit absent auth overrides before SDK validation and preserve tool schemas', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  const transport = client.getClient().toolRouter.session;
  const created: Record<string, unknown>[] = [];
  t.mock.method(transport, 'create', async (input: Record<string, unknown>) => {
    created.push(input);
    return {
      session_id: 'fixture-session',
      mcp: { type: 'http', url: 'https://backend.composio.dev/tool_router/mcp/fixture-session' },
      config: { user_id: 'local-development' },
      config_version: 1,
    };
  });
  t.mock.method(transport, 'search', async (_id: string, input: Record<string, unknown>) => {
    assert.deepEqual(input.queries, [{ use_case: 'List Gmail labels' }]);
    return {
      success: true,
      error: null,
      results: [
        {
          index: 0,
          use_case: 'List Gmail labels',
          primary_tool_slugs: ['GMAIL_LIST_LABELS'],
          related_tool_slugs: [],
          toolkits: ['gmail'],
        },
      ],
      tool_schemas: {
        GMAIL_LIST_LABELS: {
          tool_slug: 'GMAIL_LIST_LABELS',
          toolkit: 'gmail',
          input_schema: { type: 'object', properties: { user_id: { type: 'string' } } },
          hasFullSchema: true,
        },
      },
      toolkit_connection_statuses: [],
      next_steps_guidance: [],
      session: { id: 'private-session-metadata', generate_id: false, instructions: '' },
      time_info: {
        current_time_utc: '2026-09-24T00:00:00Z',
        current_time_utc_epoch_seconds: 1790208000,
        message: '',
      },
    };
  });
  t.mock.method(transport, 'execute', async (_id: string, input: Record<string, unknown>) => {
    assert.deepEqual(input, {
      tool_slug: 'GMAIL_LIST_LABELS',
      arguments: { user_id: 'me' },
      account: 'fixture-account',
    });
    return { data: { labels: [{ id: 'INBOX' }] }, error: null, log_id: 'fixture-log' };
  });
  const authConfigs = {
    gmail: undefined,
    googlecalendar: undefined,
    googledrive: undefined,
    googlesheets: undefined,
    googledocs: undefined,
  };
  const provider = createComposioProvider({ client, authConfigs });
  const session = await provider.createSession('local-development', { gmail: 'fixture-account' });
  assert.equal(created[0].auth_configs, undefined);
  assert.deepEqual(created[0].toolkits, {
    enable: [
      'gmail',
      'googlecalendar',
      'googledrive',
      'googlesheets',
      'googledocs',
      'slack',
      'notion',
    ],
  });
  assert.deepEqual(created[0].connected_accounts, { gmail: ['fixture-account'] });
  const search = await session.search('List Gmail labels');
  assert.deepEqual(search.suggestions, [
    { useCase: 'List Gmail labels', primaryToolSlugs: ['GMAIL_LIST_LABELS'] },
  ]);
  const schema = (search.tools as Record<string, { inputSchema: unknown }>).GMAIL_LIST_LABELS;
  assert.deepEqual(schema.inputSchema, {
    type: 'object',
    properties: { user_id: { type: 'string' } },
  });
  assert.equal(JSON.stringify(search).includes('private-session-metadata'), false);
  assert.deepEqual(
    await session.execute('GMAIL_LIST_LABELS', { user_id: 'me' }, 'fixture-account'),
    {
      data: { labels: [{ id: 'INBOX' }] },
      error: null,
      logId: 'fixture-log',
    },
  );
  const configured = createComposioProvider({
    client,
    authConfigs: {
      ...authConfigs,
      gmail: 'fixture-auth-config',
      googledocs: '',
      slack: 'slack-auth',
      notion: 'notion-auth',
    },
  });
  await configured.createSession('local-development', {
    gmail: ['first-account', 'second-account'],
  });
  assert.deepEqual(created[1].auth_configs, {
    gmail: 'fixture-auth-config',
    slack: 'slack-auth',
    notion: 'notion-auth',
  });
  assert.deepEqual(created[1].connected_accounts, { gmail: ['first-account', 'second-account'] });
  assert.deepEqual(created[1].multi_account, {
    enable: true,
    max_accounts_per_toolkit: 10,
    require_explicit_selection: true,
  });
});

test('Composio execution rejects failure envelopes without exposing provider details', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  let result: Record<string, unknown> = {};
  t.mock.method(client.sessions, 'create', async () => ({
    sessionId: 'fixture-session',
    execute: async () => result,
  }));
  const session = await createComposioProvider({ client }).createSession('local-development', {});
  for (const failure of [
    { data: {}, error: 'private-provider-error', logId: 'private-log' },
    { data: {}, error: { message: 'private-provider-error' }, logId: 'private-log' },
    { data: {}, successful: false },
    { data: { successful: false, error: 'private-provider-error' }, error: null },
  ]) {
    result = failure;
    await assert.rejects(session.execute('GMAIL_SEND_EMAIL', {}, 'fixture-account'), {
      message: 'The connection provider could not complete this action.',
    });
  }
  result = { data: { successful: true, id: 'fixture-message' }, error: null };
  assert.deepEqual(await session.execute('GMAIL_SEND_EMAIL', {}, 'fixture-account'), result);
});

test('Composio account identity comes from an account-bound Google response and excludes credentials', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  t.mock.method(client.connectedAccounts, 'get', async () => ({
    status: 'ACTIVE',
    isDisabled: false,
    toolkit: { slug: 'gmail' },
    data: { access_token: 'must-not-expose', email: 'untrusted@example.com' },
  }));
  t.mock.method(client.sessions, 'create', async () => {
    throw new Error('Fixture session is unavailable.');
  });
  const endpoints: string[] = [];
  t.mock.method(
    client.tools,
    'proxyExecute',
    async (input: { connectedAccountId: string; method: string; endpoint: string }) => {
      assert.equal(input.connectedAccountId, 'verified-account');
      assert.equal(input.method, 'GET');
      endpoints.push(input.endpoint);
      if (input.endpoint.includes('/oauth2/'))
        return { status: 403, data: { error: 'Missing profile scope' } };
      assert.equal(input.endpoint, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
      return {
        status: 200,
        data: {
          emailAddress: 'verified@example.com',
          messagesTotal: 999,
          historyId: 'private-history',
        },
      };
    },
  );
  const provider = createComposioProvider({ client });
  assert.deepEqual(await provider.inspectAccount('verified-account', 'fixture-owner'), {
    active: true,
    service: 'gmail',
    accountEmail: 'verified@example.com',
  });
  assert.deepEqual(await provider.inspectAccount('verified-account', 'fixture-owner'), {
    active: true,
    service: 'gmail',
    accountEmail: 'verified@example.com',
  });
  assert.equal(endpoints.length, 2);
});

test('Composio identity uses account-scoped Google, Slack and Notion reads without direct proxy access', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  const profiles = {
    slack: {
      action: 'SLACK_WHO_AM_I',
      args: {},
      data: {
        data: {
          user: 'fixture-user',
          team: 'Fixture workspace',
          user_id: 'U-private',
          team_id: 'T-private',
        },
      },
      identity: { accountName: 'fixture-user · Fixture workspace' },
    },
    notion: {
      action: 'NOTION_WHO_AM_I',
      args: {},
      data: {
        data: {
          name: 'Composio integration',
          type: 'bot',
          workspace_name: 'Fixture notes',
          owner_email: 'notes@example.com',
        },
      },
      identity: { accountName: 'Fixture notes', accountEmail: 'notes@example.com' },
    },
    gmail: {
      action: 'GMAIL_GET_PROFILE',
      args: { user_id: 'me' },
      data: { emailAddress: 'personal@example.com', historyId: 'private-history' },
      identity: { accountEmail: 'personal@example.com' },
    },
    googlecalendar: {
      action: 'GOOGLECALENDAR_GET_CURRENT_USER',
      args: {},
      data: { data: { email: 'work@example.com', display_name: 'Work calendar' } },
      identity: { accountEmail: 'work@example.com', accountName: 'Work calendar' },
    },
    googledrive: {
      action: 'GOOGLEDRIVE_GET_ABOUT',
      args: { fields: 'user(displayName,emailAddress)' },
      data: {
        user: { emailAddress: 'drive@example.com', displayName: 'Fixture User' },
        display_url: 'private-provider-url',
      },
      identity: { accountEmail: 'drive@example.com', accountName: 'Fixture User' },
    },
  };
  const created: string[] = [];
  const deleted: string[] = [];
  t.mock.method(client.connectedAccounts, 'get', async (id: string) => ({
    status: 'ACTIVE',
    isDisabled: false,
    toolkit: { slug: id },
    data: { access_token: 'must-not-expose', email: 'unverified@example.com' },
  }));
  t.mock.method(client.tools, 'proxyExecute', async () => {
    assert.fail('Successful identity tools do not require direct proxy permissions.');
  });
  t.mock.method(
    client.sessions,
    'create',
    async (
      owner: string,
      config: {
        toolkits: string[];
        tools: Record<string, string[]>;
        connectedAccounts: Record<string, string>;
        manageConnections: boolean;
        sandbox: { enable: boolean };
        premiumUsage: boolean;
      },
    ) => {
      assert.equal(owner, 'fixture-owner');
      const service = config.toolkits[0] as keyof typeof profiles;
      const profile = profiles[service];
      assert.deepEqual(config.toolkits, [service]);
      assert.deepEqual(config.tools, { [service]: [profile.action] });
      assert.deepEqual(config.connectedAccounts, { [service]: service });
      assert.equal(config.manageConnections, false);
      assert.deepEqual(config.sandbox, { enable: false });
      assert.equal(config.premiumUsage, false);
      created.push(service);
      return {
        sessionId: `identity-${service}`,
        execute: async (action: string, args: unknown, selection: unknown) => {
          assert.equal(action, profile.action);
          assert.deepEqual(args, profile.args);
          assert.deepEqual(selection, { account: service });
          return { data: profile.data, error: null, logId: 'private-log' };
        },
      };
    },
  );
  t.mock.method(client.sessions, 'delete', async (id: string) => {
    deleted.push(id);
  });
  const provider = createComposioProvider({ client });
  for (const [service, profile] of Object.entries(profiles)) {
    const results = await Promise.all([
      provider.inspectAccount(service, 'fixture-owner'),
      provider.inspectAccount(service, 'fixture-owner'),
    ]);
    for (const result of results)
      assert.deepEqual(result, { active: true, service, ...profile.identity });
    assert.deepEqual(await provider.inspectAccount(service, 'fixture-owner'), results[0]);
  }
  assert.deepEqual(created.sort(), Object.keys(profiles).sort());
  assert.deepEqual(
    deleted.sort(),
    Object.keys(profiles)
      .map((service) => `identity-${service}`)
      .sort(),
  );
});

test('Composio failed identity envelopes do not invent account labels or retain inspection sessions', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  t.mock.method(client.connectedAccounts, 'get', async () => ({
    status: 'ACTIVE',
    isDisabled: false,
    toolkit: { slug: 'gmail' },
  }));
  t.mock.method(client.sessions, 'create', async () => ({
    sessionId: 'failed-identity',
    execute: async () => ({
      error: null,
      data: {
        successful: false,
        data: { emailAddress: 'must-not-use@example.com' },
        error: 'private-error',
      },
    }),
  }));
  const deleted: string[] = [];
  t.mock.method(client.sessions, 'delete', async (id: string) => {
    deleted.push(id);
  });
  t.mock.method(client.tools, 'proxyExecute', async () => ({
    status: 403,
    data: { error: 'private-error' },
  }));
  assert.deepEqual(
    await createComposioProvider({ client }).inspectAccount('failed-account', 'fixture-owner'),
    { active: true, service: 'gmail' },
  );
  assert.deepEqual(deleted, ['failed-identity']);
});

test('Composio adapter normalizes sessions without exposing SDK metadata and authenticates raw webhooks', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  t.mock.method(client.sessions, 'create', async () => ({
    sessionId: 'fixture-session',
    authorize: async () => ({
      id: 'fixture-account',
      redirectUrl: 'https://connect.composio.dev/link/fixture',
    }),
    execute: async () => ({ data: [] }),
    search: async () => ({
      success: true,
      error: null,
      toolSchemas: {
        GMAIL_FETCH_EMAILS: {
          toolSlug: 'GMAIL_FETCH_EMAILS',
          toolkit: 'gmail',
          inputSchema: { type: 'object' },
        },
      },
      results: [{ useCase: 'Find email', primaryToolSlugs: ['GMAIL_FETCH_EMAILS'] }],
      session: { token: 'do-not-expose' },
    }),
  }));
  const provider = createComposioProvider({ client, webhookSecret: 'fixture-signing-secret' });
  const session = await provider.createSession('local-development', {});
  assert.equal(session.id, 'fixture-session');
  assert.deepEqual(await session.authorize('gmail', 'http://localhost:4310/api/apps/callback'), {
    accountId: 'fixture-account',
    url: 'https://connect.composio.dev/link/fixture',
  });
  assert.equal(JSON.stringify(await session.search('Find email')).includes('do-not-expose'), false);
  const body = JSON.stringify({
    id: 'event-fixture',
    type: 'composio.trigger.message',
    timestamp: new Date().toISOString(),
    metadata: {
      log_id: 'log-fixture',
      trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE',
      trigger_id: 'ti-fixture',
      connected_account_id: 'ca-fixture',
      auth_config_id: 'ac-fixture',
      user_id: 'local-development',
    },
    data: { subject: 'Fixture event' },
  });
  function signed(timestamp = String(Math.floor(Date.now() / 1000))) {
    const id = 'delivery-fixture';
    const signature = createHmac('sha256', 'fixture-signing-secret')
      .update(`${id}.${timestamp}.${body}`)
      .digest('base64');
    return {
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    };
  }
  const verified = await provider.verifyWebhook(body, signed());
  assert.equal(verified.ownerId, 'local-development');
  assert.equal(verified.accountId, 'ca-fixture');
  assert.equal(verified.subscriptionId, 'ti-fixture');
  await assert.rejects(
    provider.verifyWebhook(body, { ...signed(), 'webhook-signature': 'v1,invalid' }),
  );
  await assert.rejects(
    createComposioProvider({
      client,
      webhookSecret: 'different-fixture-signing-secret',
    }).verifyWebhook(body, signed()),
  );
  await assert.rejects(
    provider.verifyWebhook(body, signed(String(Math.floor(Date.now() / 1000) - 600))),
  );
});

test('environment key-store adapter accepts only an explicit 32-byte key', async () => {
  const key = randomBytes(32);
  assert.deepEqual(await createEnvironmentKeyStore(key.toString('base64')).getKey(), key);
  assert.equal(createEnvironmentKeyStore().configured, false);
  await assert.rejects(createEnvironmentKeyStore().getKey());
  await assert.rejects(createEnvironmentKeyStore('not-a-key').getKey());
});

test('Composio Slack and Notion subscriptions use current exact events and preserve setup failures', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  const subscriptions: unknown[] = [];
  t.mock.method(
    client.triggers,
    'create',
    async (owner: string, trigger: string, config: unknown) => {
      subscriptions.push({ owner, trigger, config });
      if (trigger === 'NOTION_PAGE_CONTENT_UPDATED')
        throw new Error('Fixture ingress is unavailable.');
      return { triggerId: 'fixture-slack-trigger' };
    },
  );
  const provider = createComposioProvider({ client, webhookSecret: 'fixture-signature' });
  assert.equal(provider.supportedServices?.includes('slack'), true);
  assert.equal(provider.supportedServices?.includes('notion'), true);
  assert.deepEqual(await provider.subscribe('fixture-owner', 'slack', 'slack-account'), {
    id: 'fixture-slack-trigger',
  });
  await assert.rejects(provider.subscribe('fixture-owner', 'notion', 'notion-account'));
  assert.deepEqual(subscriptions, [
    {
      owner: 'fixture-owner',
      trigger: 'SLACK_DIRECT_MESSAGE_RECEIVED',
      config: { connectedAccountId: 'slack-account', triggerConfig: {} },
    },
    {
      owner: 'fixture-owner',
      trigger: 'NOTION_PAGE_CONTENT_UPDATED',
      config: { connectedAccountId: 'notion-account', triggerConfig: {} },
    },
  ]);
  assert.equal(provider.matchesSubscription('slack', 'SLACK_DIRECT_MESSAGE_RECEIVED'), true);
  assert.equal(provider.matchesSubscription('slack', 'SLACK_CHANNEL_MESSAGE_RECEIVED'), false);
  assert.equal(provider.matchesSubscription('notion', 'NOTION_PAGE_CONTENT_UPDATED'), true);
  assert.equal(provider.matchesSubscription('notion', 'NOTION_PAGE_CREATED'), false);
});

test('unsupported Slack identity does not send its account through Google profile endpoints', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  t.mock.method(client.connectedAccounts, 'get', async () => ({
    status: 'ACTIVE',
    isDisabled: false,
    toolkit: { slug: 'slack' },
    data: { email: 'untrusted@example.com' },
  }));
  t.mock.method(client.sessions, 'create', async () => {
    throw new Error('Fixture scope missing');
  });
  let proxyCalls = 0;
  t.mock.method(client.tools, 'proxyExecute', async () => {
    proxyCalls++;
    throw new Error('Wrong provider');
  });
  assert.deepEqual(
    await createComposioProvider({ client }).inspectAccount('slack-account', 'fixture-owner'),
    { active: true, service: 'slack' },
  );
  assert.equal(proxyCalls, 0);
});
