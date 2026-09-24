import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentSession } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { RuntimeContext } from '../src/ports/agent.ts';
import { createPiAgent } from '../src/providers/pi/index.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

test('real Pi sessions persist a credential pause and resume without replaying chat history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-pi-'));
  const id = 'test-' + randomUUID();
  const replies: string[] = [];
  const prompts: string[] = [];
  let remembered = 0;
  let phase = 0;
  const context: RuntimeContext = {
    taskId: id,
    ownerId: 'fixture',
    prompt: 'Sign in to the fixture',
    history: [{ role: 'user', text: 'Older fixture context' }],
    memories: [],
    workspacePath: directory,
    signal: new AbortController().signal,
    attachments: [],
    emit: async () => {},
    reply: async (text) => {
      replies.push(text);
    },
    delta: () => {},
    remember: async () => {
      remembered += 1;
    },
    publish: async () => {
      throw new Error('Not used');
    },
    requestCredential: async () => ({ url: '/credentials/fixture' }),
    integration: async () => ({}),
    manage: async () => {
      remembered += 1;
      return {};
    },
  };
  const factory: typeof createAgentSession = async (options) => {
    assert.equal(options?.tools?.includes('bash'), false);
    assert.equal(options?.tools?.includes('read'), false);
    assert.deepEqual(options?.resourceLoader?.getAgentsFiles().agentsFiles, []);
    assert.deepEqual(options?.resourceLoader?.getExtensions().extensions, []);
    assert.equal(
      options?.resourceLoader?.getSystemPrompt()?.includes('runtime-fixture-key'),
      false,
    );
    const result = await createAgentSession(options);
    result.session.agent.streamFunction = (model, request) => {
      prompts.push(JSON.stringify(request.messages));
      if (phase === 0 && prompts.length > 1) throw new Error('Fixture exceeded one turn');
      const output: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: phase === 0 ? 'toolUse' : 'stop',
        content:
          phase === 0
            ? [
                {
                  type: 'toolCall',
                  id: 'credential-call',
                  name: 'request_credentials',
                  arguments: {
                    origin: 'https://example.com',
                    label: 'Example',
                    kind: 'password',
                    passwordSelector: '#password',
                  },
                },
                {
                  type: 'toolCall',
                  id: 'later-call',
                  name: 'remember',
                  arguments: { text: 'This should not execute' },
                },
              ]
            : [{ type: 'text', text: 'Resumed successfully.' }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: output });
      stream.push({ type: 'done', reason: phase === 0 ? 'toolUse' : 'stop', message: output });
      return stream;
    };
    return result;
  };
  const runtime = createAgentRuntime({
    agent: createPiAgent({
      provider: 'openai',
      apiKey: 'runtime-fixture-key',
      sessionRoot: join(directory, 'sessions'),
      createSession: factory,
    }),
    computer: fakeComputer(),
    workspace: fakeWorkspace(),
  });
  try {
    assert.equal((await runtime.runTask(context)).status, 'waiting_credentials');
    assert.equal(remembered, 0);
    phase = 1;
    assert.equal(
      (
        await runtime.runTask({
          ...context,
          prompt: 'Secure entry completed',
          history: [{ role: 'user', text: 'History must not be appended again' }],
        })
      ).status,
      'succeeded',
    );
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1].includes('Older fixture context'), true);
    assert.equal(prompts[1].includes('Secure entry completed'), true);
    assert.equal(prompts[1].includes('History must not be appended again'), false);
    assert.equal(prompts[1].includes('runtime-fixture-key'), false);
    assert.deepEqual(replies, [
      'Secure sign-in is needed to continue: /credentials/fixture',
      'Resumed successfully.',
    ]);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Responses commentary and final answer remain separate visible messages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-pi-phases-'));
  const events: Array<import('../src/ports/agent.ts').AgentEvent> = [];
  const answer = 'Your file is ready. Go, go.';
  const factory: typeof createAgentSession = async (options) => {
    const result = await createAgentSession(options);
    result.session.agent.streamFunction = (model) => {
      const output: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: 'stop',
        content: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: output });
        for (const [contentIndex, phase] of ['commentary', 'final_answer'].entries()) {
          output.content.push({ type: 'text', text: '' });
          stream.push({ type: 'text_start', contentIndex, partial: structuredClone(output) });
          const block = output.content[contentIndex];
          if (block.type !== 'text') throw new Error('Unexpected fixture block');
          block.text = answer;
          stream.push({
            type: 'text_delta',
            contentIndex,
            delta: answer,
            partial: structuredClone(output),
          });
          block.textSignature = JSON.stringify({ v: 1, id: `msg_${contentIndex}`, phase });
          stream.push({
            type: 'text_end',
            contentIndex,
            content: answer,
            partial: structuredClone(output),
          });
        }
        stream.push({ type: 'done', reason: 'stop', message: output });
      });
      return stream;
    };
    return result;
  };
  const agent = createPiAgent({
    provider: 'openai',
    apiKey: 'fixture-key',
    sessionRoot: directory,
    createSession: factory,
  });
  try {
    const session = await agent.open({
      taskId: `test-${randomUUID()}`,
      systemPrompt: 'Fixture',
      tools: [],
      onEvent: (event) => events.push(event),
      shouldStop: () => false,
    });
    await session.prompt('Create the fixture file', []);
    assert.deepEqual(
      events.filter((event) => event.type === 'final'),
      [{ type: 'final', text: answer }],
    );
    const streamed: string[] = [];
    for (const event of events) {
      if (event.type === 'message_start') streamed.push('');
      if (event.type === 'text_delta') streamed[streamed.length - 1] += event.text;
    }
    assert.deepEqual(streamed.filter(Boolean), [answer, answer]);
    await session.dispose();
  } finally {
    await agent.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
