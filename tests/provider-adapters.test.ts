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
    assert.deepEqual(input, { tool_slug: 'GMAIL_LIST_LABELS', arguments: { user_id: 'me' } });
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
  assert.deepEqual(await session.execute('GMAIL_LIST_LABELS', { user_id: 'me' }), {
    data: { labels: [{ id: 'INBOX' }] },
    error: null,
    logId: 'fixture-log',
  });
  const configured = createComposioProvider({
    client,
    authConfigs: { ...authConfigs, gmail: 'fixture-auth-config', googledocs: '' },
  });
  await configured.createSession('local-development', {});
  assert.deepEqual(created[1].auth_configs, { gmail: 'fixture-auth-config' });
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
      toolSchemas: { GMAIL_FETCH_EMAILS: {} },
      results: [{ useCase: 'Find email', primaryToolSlugs: ['GMAIL_FETCH_EMAILS'] }],
      session: { token: 'do-not-expose' },
    }),
  }));
  const provider = createComposioProvider({ client, webhookSecret: 'fixture-signing-secret' });
  const session = await provider.createSession('local-development', {});
  assert.equal(session.id, 'fixture-session');
  assert.deepEqual(
    await session.authorize('gmail', 'http://localhost:4310/api/connections/callback'),
    { accountId: 'fixture-account', url: 'https://connect.composio.dev/link/fixture' },
  );
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
