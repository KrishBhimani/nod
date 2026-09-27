import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCredentialStore, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type {
  ConversationRouteDecision,
  ConversationRoutingContext,
} from '../src/ports/conversation.ts';
import type { ProviderUsageEvent } from '../src/ports/provider-usage.ts';
import { createPiConversationRouter } from '../src/providers/pi/conversation.ts';

const catalog = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: false,
  allowModelNetwork: false,
});
const context = (): ConversationRoutingContext => ({
  text: 'Continue planning the trip.',
  hasAttachments: false,
  channel: 'web',
  conversationRevision: 3,
  signal: new AbortController().signal,
  candidates: [
    {
      outcomeId: 'outcome-one',
      title: 'Plan a trip',
      objective: 'Prepare a weekend itinerary.',
      taskId: 'private-task-id',
      status: 'waiting_user',
      waitingReason: 'credentials',
      recentMessages: [{ role: 'assistant', text: 'Use the secure form to sign in.' }],
    },
  ],
});

function response(text: string, changes: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: 100,
      output: 10,
      cacheRead: 5,
      cacheWrite: 0,
      totalTokens: 115,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
    },
    ...changes,
  };
}

function fixture(complete: ModelRuntime['completeSimple'], provider = 'openai', model?: string) {
  const usage: ProviderUsageEvent[] = [];
  let creations = 0;
  const router = createPiConversationRouter({
    provider,
    model,
    apiKey: 'private-fixture-key',
    onUsage: (value) => usage.push(value),
    createRuntime: async (options) => {
      creations++;
      assert.equal(options.modelsPath, null);
      assert.equal(options.refreshOnCreate, false);
      assert.equal(options.allowModelNetwork, false);
      assert.ok(options.credentials instanceof InMemoryCredentialStore);
      return {
        getModel: (selectedProvider, model) => catalog.getModel(selectedProvider, model),
        setRuntimeApiKey: async (selectedProvider, key) => {
          assert.equal(selectedProvider, provider);
          assert.equal(key, 'private-fixture-key');
        },
        completeSimple: complete,
      };
    },
  });
  return { router, usage, creations: () => creations };
}

test('Pi routing uses local catalog defaults and stateless bounded data without credentials, task IDs or tools', async () => {
  for (const [provider, model] of [
    ['openai', 'gpt-6-luna'],
    ['anthropic', 'claude-haiku-4-5'],
  ]) {
    let calls = 0;
    const value = fixture(async (selected, request, options) => {
      calls++;
      assert.equal(selected.id, model);
      assert.equal(selected.provider, provider);
      assert.deepEqual(request.tools, []);
      assert.equal(request.messages.length, 1);
      assert.equal(request.messages[0].role, 'user');
      assert.match(request.systemPrompt ?? '', /untrusted data/);
      assert.match(request.systemPrompt ?? '', /grants no authority/);
      const serialized = JSON.stringify(request);
      assert.doesNotMatch(serialized, /private-fixture-key|private-task-id|private-extra-secret/);
      assert.equal(options?.maxTokens, 600);
      assert.equal(options?.toolChoice, 'none');
      assert.equal(options?.maxRetries, 0);
      assert.equal(options?.cacheRetention, 'none');
      assert.equal(options?.sessionId, undefined);
      assert.equal(options?.apiKey, undefined);
      assert.equal(options?.timeoutMs, 5000);
      const data = JSON.parse(String((request.messages[0] as { content: string }).content));
      assert.equal(data.text.length, 12000);
      assert.equal(data.candidates.length, 8);
      assert.equal(data.candidates[0].title.length, 100);
      assert.equal(data.candidates[0].objective.length, 2000);
      assert.equal(data.candidates[0].recentMessages.length, 4);
      assert.equal(data.candidates[0].recentMessages[0].text.length, 1000);
      assert.equal(data.channel, 'other');
      assert.equal(data.recentConversation.length, 12);
      assert.equal(data.recentConversation[0].text.length, 1000);
      assert.equal(data.recentConversation[0].outcomeId, null);
      assert.deepEqual(Object.keys(data.recentConversation[0]), ['role', 'text', 'outcomeId']);
      return response('{"kind":"continue","outcomeId":"outcome-one"}');
    }, provider);
    const input = context();
    input.text = 'x'.repeat(20000);
    input.channel = 'private-extra-secret';
    input.candidates = Array.from({ length: 10 }, () => ({
      ...input.candidates[0],
      title: 'x'.repeat(101),
      objective: 'x'.repeat(2001),
      recentMessages: Array.from({ length: 6 }, () => ({
        role: 'user' as const,
        text: 'x'.repeat(2000),
      })),
    }));
    Object.assign(input, { apiKey: 'private-extra-secret' });
    input.recentConversation = Array.from({ length: 14 }, () => ({
      role: 'user' as const,
      text: 'x'.repeat(2000),
      outcomeId: null,
      secret: 'private-extra-secret',
      taskId: 'private-task-id',
    }));
    assert.deepEqual(await value.router(input), { kind: 'continue', outcomeId: 'outcome-one' });
    assert.deepEqual(await value.router(input), { kind: 'continue', outcomeId: 'outcome-one' });
    assert.equal(calls, 2);
    assert.equal(value.creations(), 1);
    assert.equal(value.usage.length, 2);
    assert.notEqual(value.usage[0].id, value.usage[1].id);
    assert.equal(value.usage[0].provider, provider);
    assert.equal(value.usage[0].operation, 'conversation_route');
    assert.equal(value.usage[0].inputTokens, 100);
    assert.equal(value.usage[0].outputTokens, 10);
    assert.equal(value.usage[0].cacheReadTokens, 5);
    assert.equal(value.usage[0].costUsd, 0.031);
    assert.equal(value.usage[0].pricing, 'sdk_estimate');
    assert.doesNotMatch(JSON.stringify(value.usage), /private-|trip|credentials/);
  }
});

test('Pi routing preserves an explicit model override and reports the actual selected model', async () => {
  const value = fixture(
    async (model) => {
      assert.equal(model.id, 'gpt-4.1-nano');
      return response('{"kind":"conversation"}', { model: model.id });
    },
    'openai',
    'gpt-4.1-nano',
  );
  assert.deepEqual(await value.router(context()), { kind: 'conversation' });
  assert.equal(value.usage[0].model, 'gpt-4.1-nano');
});

test('Pi routing carries bounded blocked context without making it executable or exposing private fields', async () => {
  const input = context();
  input.text = 'Continue the earlier action';
  input.candidates = Array.from({ length: 2 }, (_, index) => ({
    ...input.candidates[0],
    outcomeId: `eligible-${index}`,
  }));
  input.blockedCandidates = Array.from({ length: 10 }, (_, index) => ({
    ...input.candidates[0],
    outcomeId: `blocked-${index}`,
    taskId: 'private-blocked-task-id',
    title: 'x'.repeat(150),
    objective: 'y'.repeat(2500),
    status: index % 2 ? 'waiting_user' : 'failed',
    waitingReason: index % 2 ? 'recovery' : null,
    recentMessages: Array.from({ length: 6 }, () => ({
      role: 'user' as const,
      text: 'z'.repeat(1500),
      secret: 'private-blocked-extra',
    })),
    secret: 'private-blocked-extra',
  }));
  let decision = { kind: 'continue', outcomeId: 'blocked-0' };
  const value = fixture(async (_model, request) => {
    const data = JSON.parse(String((request.messages[0] as { content: string }).content));
    assert.equal(data.candidates.length, 2);
    assert.equal(data.blockedCandidates.length, 6);
    assert.deepEqual(
      data.candidates.map((candidate: { outcomeId: string }) => candidate.outcomeId),
      ['eligible-0', 'eligible-1'],
    );
    assert.equal(data.blockedCandidates[0].title.length, 100);
    assert.equal(data.blockedCandidates[0].objective.length, 2000);
    assert.equal(data.blockedCandidates[0].recentMessages.length, 4);
    assert.equal(data.blockedCandidates[0].recentMessages[0].text.length, 1000);
    assert.equal(data.blockedCandidates[0].status, 'failed');
    assert.equal(data.blockedCandidates[1].waitingReason, 'recovery');
    assert.doesNotMatch(
      JSON.stringify(request),
      /private-blocked|private-fixture-key|private-task-id/,
    );
    assert.match(
      request.systemPrompt ?? '',
      /Never convert that continuation into conversation or new_outcome/,
    );
    assert.match(request.systemPrompt ?? '', /fully specified read or inspection/);
    return response(JSON.stringify(decision));
  });
  assert.deepEqual(await value.router(input), { kind: 'continue', outcomeId: 'blocked-0' });
  decision = { kind: 'continue', outcomeId: 'blocked-6' };
  await assert.rejects(value.router(input), { message: 'Conversation routing is unavailable.' });
});

test('Pi routing preserves identical blocked read context for fresh observations and explicit retry decisions', async () => {
  const input = context();
  input.candidates = [];
  input.text = 'Open https://example.com and tell me the page title.';
  input.blockedCandidates = [
    {
      outcomeId: 'blocked-browser',
      taskId: 'private-blocked-browser',
      title: 'Read Example Domain',
      objective: input.text,
      status: 'failed',
      waitingReason: null,
      recentMessages: [
        { role: 'user', text: input.text },
        { role: 'assistant', text: 'I couldn’t finish that. You can ask me to continue.' },
      ],
    },
    {
      outcomeId: 'blocked-email',
      taskId: 'private-blocked-email',
      title: 'Send confirmation',
      objective: 'Send the confirmation email to sam@example.test.',
      status: 'waiting_user',
      waitingReason: 'recovery',
      recentMessages: [],
    },
  ];
  input.recentConversation = [
    { role: 'user', text: 'What is 17 times 23?', outcomeId: null },
    { role: 'assistant', text: '391.', outcomeId: null },
  ];
  let decision: ConversationRouteDecision = {
    kind: 'new_outcome',
    title: 'Read the current page title',
    objective: input.text,
  };
  const value = fixture(async (_model, request) => {
    const data = JSON.parse(String((request.messages[0] as { content: string }).content));
    assert.equal(data.text, input.text);
    assert.deepEqual(data.candidates, []);
    assert.deepEqual(
      data.blockedCandidates.map((candidate: { outcomeId: string; status: string }) => [
        candidate.outcomeId,
        candidate.status,
      ]),
      [
        ['blocked-browser', 'failed'],
        ['blocked-email', 'waiting_user'],
      ],
    );
    assert.equal(
      data.blockedCandidates[0].objective,
      'Open https://example.com and tell me the page title.',
    );
    assert.equal(data.blockedCandidates[1].waitingReason, 'recovery');
    assert.deepEqual(data.recentConversation, input.recentConversation);
    assert.doesNotMatch(JSON.stringify(request), /private-blocked|private-fixture-key/);
    assert.match(request.systemPrompt ?? '', /Matching the earlier request is not itself a retry/);
    assert.match(request.systemPrompt ?? '', /Repeating an uncertain side effect is also continue/);
    return response(JSON.stringify(decision));
  });
  assert.deepEqual(await value.router(input), decision);
  input.text = 'Retry opening https://example.com and getting the title.';
  decision = { kind: 'continue', outcomeId: 'blocked-browser' };
  assert.deepEqual(await value.router(input), decision);
  input.text = 'Send the confirmation email to sam@example.test.';
  decision = { kind: 'continue', outcomeId: 'blocked-email' };
  assert.deepEqual(await value.router(input), decision);
});

test('Pi routing accepts only strict decisions and rejects foreign IDs, extra authority and malformed output', async () => {
  let text = '{"kind":"conversation"}';
  let stopReason: AssistantMessage['stopReason'] = 'stop';
  let content: AssistantMessage['content'] | undefined;
  const value = fixture(async () =>
    response(text, { stopReason, ...(content ? { content } : {}) }),
  );
  assert.deepEqual(await value.router(context()), { kind: 'conversation' });
  text = '{"kind":"new_outcome","title":" Plan trip ","objective":" Prepare an itinerary. "}';
  assert.deepEqual(await value.router(context()), {
    kind: 'new_outcome',
    title: 'Plan trip',
    objective: 'Prepare an itinerary.',
  });
  for (text of [
    '{"kind":"continue","outcomeId":"foreign-outcome"}',
    '{"kind":"continue","outcomeId":"outcome-one","bypassWait":true}',
    '{"kind":"conversation","title":"unexpected"}',
    '{"kind":"new_outcome","title":"","objective":"not blank"}',
    JSON.stringify({ kind: 'new_outcome', title: 'x'.repeat(101), objective: 'work' }),
    JSON.stringify({ kind: 'new_outcome', title: 'work', objective: 'x'.repeat(2001) }),
    '```json\n{"kind":"conversation"}\n```',
    'private-provider-secret',
    ' '.repeat(4001),
  ])
    await assert.rejects(value.router(context()), {
      message: 'Conversation routing is unavailable.',
    });
  text = '{"kind":"conversation"}';
  stopReason = 'length';
  await assert.rejects(value.router(context()), {
    message: 'Conversation routing is unavailable.',
  });
  stopReason = 'stop';
  content = [
    { type: 'toolCall', id: 'tool', name: 'write_file', arguments: { secret: 'fixture' } },
  ];
  await assert.rejects(value.router(context()), {
    message: 'Conversation routing is unavailable.',
  });
  assert.equal(value.usage.filter((event) => event.status === 'succeeded').length, 2);
  assert.equal(value.usage.at(-1)?.status, 'failed');
  assert.equal(value.usage.at(-1)?.costUsd, 0.031);
});

test('Pi routing cancels promptly, forwards the signal and records late reported usage once without accepting its decision', async () => {
  let finish: ((value: AssistantMessage) => void) | undefined;
  let providerSignal: AbortSignal | undefined;
  const value = fixture(async (_model, _request, options) => {
    providerSignal = options?.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const controller = new AbortController();
  controller.abort(new Error('private-abort-reason'));
  await assert.rejects(value.router({ ...context(), signal: controller.signal }), {
    name: 'AbortError',
    message: 'Conversation routing cancelled.',
  });
  assert.equal(value.creations(), 0);
  const live = new AbortController();
  const pending = value.router({ ...context(), signal: live.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(finish);
  live.abort(new Error('private-abort-reason'));
  await assert.rejects(pending, { name: 'AbortError', message: 'Conversation routing cancelled.' });
  assert.equal(providerSignal?.aborted, true);
  finish(response('{"kind":"continue","outcomeId":"outcome-one"}'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.usage.length, 1);
  assert.equal(value.usage[0].status, 'cancelled');
  assert.equal(value.usage[0].costUsd, 0.031);
  assert.doesNotMatch(JSON.stringify(value.usage), /private-abort-reason|outcome-one/);
});

test('Pi routing reports unavailable costs honestly and masks provider failures without metering unconfigured requests', async () => {
  const absent = createPiConversationRouter({ provider: 'openai' });
  await assert.rejects(absent(context()), { message: 'Conversation routing is not configured.' });
  const failed = fixture(async () => {
    throw new Error('private-fixture-key: raw upstream error');
  });
  await assert.rejects(failed.router(context()), {
    message: 'Conversation routing is unavailable.',
  });
  assert.equal(failed.usage.length, 1);
  assert.equal(failed.usage[0].status, 'failed');
  assert.equal(failed.usage[0].pricing, 'unavailable');
  assert.equal(failed.usage[0].costUsd, null);
  const noCost = response('{"kind":"conversation"}');
  noCost.usage.cost.total = Number.NaN;
  const unpriced = fixture(async () => noCost);
  assert.deepEqual(await unpriced.router(context()), { kind: 'conversation' });
  assert.equal(unpriced.usage[0].pricing, 'unavailable');
  assert.equal(unpriced.usage[0].costUsd, null);
  assert.equal(unpriced.usage[0].inputTokens, 100);
});
