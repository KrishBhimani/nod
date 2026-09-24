import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createAgentSession, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { RuntimeContext } from '../src/shared/contracts.ts';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { runTask } from '../src/runtime/index.ts';

async function fixture(run: (tools: Map<string, ToolDefinition>, emit: (event: unknown) => void) => Promise<void>, overrides: Partial<RuntimeContext> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-session-'));
  const id = 'test-' + randomUUID();
  const replies: string[] = [];
  const events: string[] = [];
  const deltas: string[] = [];
  let aborted = false;
  let supplied: Parameters<typeof createAgentSession>[0];
  const context = {
    taskId: id, ownerId: 'test-owner', prompt: 'Help with a fixture', history: [], memories: [], workspacePath: directory,
    signal: new AbortController().signal, attachments: [], emit: async (type: string) => { events.push(type); },
    reply: async (text: string) => { replies.push(text); }, delta: (text: string) => { deltas.push(text); }, remember: async () => {},
    publish: async () => { throw new Error('Not used'); }, requestCredential: async () => ({ url: '/credentials/fixture' }),
    integration: async () => ({}), manage: async () => ({}), ...overrides,
  } as RuntimeContext;
  const factory = (async (options: Parameters<typeof createAgentSession>[0]) => {
    supplied = options;
    let listener: (event: unknown) => void = () => {};
    const tools = new Map(options?.customTools?.map(tool => [tool.name, tool]));
    return { session: { agent: {}, subscribe: (callback: typeof listener) => { listener = callback; return () => {}; }, prompt: () => run(tools, event => listener(event)), abort: async () => { aborted = true; }, dispose: () => {} }, extensions: {} };
  }) as unknown as typeof createAgentSession;
  const key = process.env.OPENAI_API_KEY;
  const provider = process.env.LLM_PROVIDER;
  const model = process.env.LLM_MODEL;
  process.env.OPENAI_API_KEY = 'runtime-fixture-key'; process.env.LLM_PROVIDER = 'openai'; delete process.env.LLM_MODEL;
  try { const result = await runTask(context, { createSession: factory }); return { result, replies, events, deltas, aborted, supplied: supplied! }; }
  finally {
    if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
    if (provider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = provider;
    if (model === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = model;
    await rm(directory, { recursive: true, force: true });
    await rm(resolve('.local/sessions', id), { recursive: true, force: true });
  }
}

async function call(tools: Map<string, ToolDefinition>, name: string, args: unknown) {
  return tools.get(name)!.execute('fixture', args, undefined, undefined, {} as never);
}

test('secure credential pause prevents subsequent tools in the same execution segment', async () => {
  let remembered = false;
  const result = await fixture(async tools => {
    await call(tools, 'request_credentials', { origin: 'https://example.com', label: 'Example', kind: 'password', passwordSelector: '#password' });
    await assert.rejects(call(tools, 'remember', { text: 'must not run' }), /stopped/);
  }, { manage: async () => { remembered = true; return {}; } });
  assert.equal(result.result.status, 'waiting_credentials');
  assert.equal(result.aborted, true);
  assert.equal(remembered, false);
  assert.equal(result.replies.length, 1);
});

test('auto-filled credentials continue and external writes pause for review', async () => {
  const result = await fixture(async tools => {
    await call(tools, 'request_credentials', { origin: 'https://example.com', label: 'Example', kind: 'password', passwordSelector: '#password' });
    await call(tools, 'google', { action: 'GMAIL_SEND_EMAIL', args: {} });
    await assert.rejects(call(tools, 'send_message', { text: 'Should not send' }), /stopped/);
  }, { requestCredential: (async () => ({ filled: true })) as RuntimeContext['requestCredential'], integration: async () => ({ requiresApproval: true, url: '/approvals/fixture' }) });
  assert.equal(result.result.status, 'waiting_user');
  assert.deepEqual(result.replies, ['Please review this action before I continue: /approvals/fixture']);
});

test('only explicit tools and resources are configured; repeated final replies are suppressed', async () => {
  const result = await fixture(async (tools, emit) => {
    await call(tools, 'send_message', { text: 'First update.' });
    await call(tools, 'send_message', { text: 'Completed.' });
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Completed.' }] } });
  });
  assert.equal(result.result.status, 'succeeded');
  assert.deepEqual(result.replies, ['First update.', 'Completed.']);
  assert.equal(result.supplied?.tools?.includes('bash'), false);
  assert.equal(result.supplied?.tools?.includes('read'), false);
  assert.deepEqual(result.supplied?.resourceLoader?.getAgentsFiles().agentsFiles, []);
  assert.deepEqual(result.supplied?.resourceLoader?.getExtensions().extensions, []);
  assert.equal(result.supplied?.resourceLoader?.getSystemPrompt()?.includes('runtime-fixture-key'), false);
});


test('real Pi sessions persist a credential pause and resume without replaying chat history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-pi-'));
  const id = 'test-' + randomUUID();
  const replies: string[] = [];
  const prompts: string[] = [];
  let remembered = 0;
  let phase = 0;
  const previous = { key: process.env.OPENAI_API_KEY, provider: process.env.LLM_PROVIDER, model: process.env.LLM_MODEL };
  process.env.OPENAI_API_KEY = 'runtime-fixture-key'; process.env.LLM_PROVIDER = 'openai'; delete process.env.LLM_MODEL;
  const context: RuntimeContext = {
    taskId: id, ownerId: 'fixture', prompt: 'Sign in to the fixture', history: [{ role: 'user', text: 'Older fixture context' }], memories: [], workspacePath: directory,
    signal: new AbortController().signal, attachments: [], emit: async () => {}, reply: async text => { replies.push(text); }, delta: () => {},
    remember: async () => { remembered += 1; }, publish: async () => { throw new Error('Not used'); },
    requestCredential: async () => ({ url: '/credentials/fixture' }), integration: async () => ({}), manage: async () => { remembered += 1; return {}; },
  };
  const factory: typeof createAgentSession = async options => {
    const result = await createAgentSession(options);
    result.session.agent.streamFunction = (model, request) => {
      prompts.push(JSON.stringify(request.messages));
      if (phase === 0 && prompts.length > 1) throw new Error('Fixture exceeded one turn');
      const output: AssistantMessage = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: phase === 0 ? 'toolUse' : 'stop',
        content: phase === 0 ? [
          { type: 'toolCall', id: 'credential-call', name: 'request_credentials', arguments: { origin: 'https://example.com', label: 'Example', kind: 'password', passwordSelector: '#password' } },
          { type: 'toolCall', id: 'later-call', name: 'remember', arguments: { text: 'This should not execute' } },
        ] : [{ type: 'text', text: 'Resumed successfully.' }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: output });
      stream.push({ type: 'done', reason: phase === 0 ? 'toolUse' : 'stop', message: output });
      return stream;
    };
    return result;
  };
  try {
    assert.equal((await runTask(context, { createSession: factory })).status, 'waiting_credentials');
    assert.equal(remembered, 0);
    phase = 1;
    assert.equal((await runTask({ ...context, prompt: 'Secure entry completed', history: [{ role: 'user', text: 'History must not be appended again' }] }, { createSession: factory })).status, 'succeeded');
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1].includes('Older fixture context'), true);
    assert.equal(prompts[1].includes('Secure entry completed'), true);
    assert.equal(prompts[1].includes('History must not be appended again'), false);
    assert.equal(prompts[1].includes('runtime-fixture-key'), false);
    assert.deepEqual(replies, ['Secure sign-in is needed to continue: /credentials/fixture', 'Resumed successfully.']);
  } finally {
    for (const [key, value] of Object.entries({ OPENAI_API_KEY: previous.key, LLM_PROVIDER: previous.provider, LLM_MODEL: previous.model })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
    await rm(resolve('.local/sessions', id), { recursive: true, force: true });
  }
});


test('memory and personal profile changes pause for review before subsequent tools', async () => {
  for (const [name, params, expectedAction] of [
    ['remember', { text: 'I prefer concise replies' }, 'memory_propose'],
    ['manage_personal_context', { action: 'profile_update', args: { name: 'Fixture' } }, 'profile_update'],
  ] as const) {
    const actions: string[] = [];
    const result = await fixture(async tools => {
      await call(tools, name, params);
      await assert.rejects(call(tools, 'send_message', { text: 'Should not run' }), /stopped/);
    }, { manage: async action => { actions.push(action); return { requiresApproval: true, url: '/approvals/personal-fixture' }; } });
    assert.equal(result.result.status, 'waiting_user');
    assert.deepEqual(actions, [expectedAction]);
    assert.deepEqual(result.replies, ['Please review this action before I continue: /approvals/personal-fixture']);
  }
});


test('background runs suppress streamed prose and automatic final replies', async () => {
  const result = await fixture(async (_tools, emit) => {
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Checking the event.' } });
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Nothing needs your attention.' }] } });
  }, { background: true });
  assert.equal(result.result.status, 'succeeded');
  assert.deepEqual(result.replies, []);
  assert.deepEqual(result.deltas, []);
});

test('background runs deliver explicit useful messages without also delivering final prose', async () => {
  const result = await fixture(async (tools, emit) => {
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Preparing a result.' } });
    await call(tools, 'send_message', { text: 'Your meeting was moved to 15:00.' });
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'The user has been notified.' }] } });
  }, { background: true });
  assert.deepEqual(result.replies, ['Your meeting was moved to 15:00.']);
  assert.deepEqual(result.deltas, []);
});

test('normal user tasks still stream and deliver automatic final replies', async () => {
  const result = await fixture(async (_tools, emit) => {
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Here is your answer.' } });
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Here is your answer.' }] } });
  });
  assert.deepEqual(result.deltas, ['Here is your answer.']);
  assert.deepEqual(result.replies, ['Here is your answer.']);
});

test('background runs can still pause with one credential or approval request', async () => {
  const credentials = await fixture(async tools => {
    await call(tools, 'request_credentials', { origin: 'https://example.com', label: 'Example', kind: 'password', passwordSelector: '#password' });
  }, { background: true });
  assert.equal(credentials.result.status, 'waiting_credentials');
  assert.deepEqual(credentials.replies, ['Secure sign-in is needed to continue: /credentials/fixture']);
  const approval = await fixture(async tools => {
    await call(tools, 'google', { action: 'GMAIL_SEND_EMAIL', args: {} });
  }, { background: true, integration: async () => ({ requiresApproval: true, url: '/approvals/fixture' }) });
  assert.equal(approval.result.status, 'waiting_user');
  assert.deepEqual(approval.replies, ['Please review this action before I continue: /approvals/fixture']);
});


test('create_audio delegates to the trusted callback and returns the delivered artifact', async () => {
  const spoken: string[] = [];
  const artifact = { id: 'audio-fixture', name: 'reply.mp3', mimeType: 'audio/mpeg', size: 64, url: '/api/artifacts/audio-fixture' };
  const result = await fixture(async tools => {
    const output = await call(tools, 'create_audio', { text: 'Hello from your assistant.' });
    assert.equal(JSON.stringify(output).includes(artifact.url), true);
    assert.equal(JSON.stringify(output).includes('runtime-fixture-key'), false);
  }, { createAudio: async text => { spoken.push(text); return artifact; } });
  assert.deepEqual(spoken, ['Hello from your assistant.']);
  assert.deepEqual(result.replies, []);
  assert.equal(result.result.status, 'succeeded');
});

test('create_audio reports unavailable speech without claiming an artifact exists', async () => {
  const result = await fixture(async tools => {
    await assert.rejects(call(tools, 'create_audio', { text: 'Hello.' }), /not available/);
  });
  assert.deepEqual(result.replies, []);
  assert.ok(result.events.includes('tool_failed'));
});
