import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  Agent,
  AgentEvent,
  AgentSessionOptions,
  AgentTool,
  RuntimeContext,
} from '../src/ports/agent.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

async function fixture(
  run: (tools: Map<string, AgentTool>, emit: (event: AgentEvent) => void) => Promise<void>,
  overrides: Partial<RuntimeContext> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-session-'));
  const replies: string[] = [];
  const events: string[] = [];
  const deltas: string[] = [];
  let aborted = false;
  let supplied: AgentSessionOptions | undefined;
  let userPrompt = '';
  const context: RuntimeContext = {
    taskId: 'test-' + randomUUID(),
    ownerId: 'test-owner',
    prompt: 'Help with a fixture',
    history: [],
    memories: [],
    workspacePath: directory,
    signal: new AbortController().signal,
    attachments: [],
    emit: async (type) => {
      events.push(type);
    },
    reply: async (text) => {
      replies.push(text);
    },
    delta: (text, _id, done) => {
      if (!done) deltas.push(text);
    },
    remember: async () => {},
    publish: async () => {
      throw new Error('Not used');
    },
    requestCredential: async () => ({ url: '/credentials/fixture' }),
    integration: async () => ({}),
    manage: async () => ({}),
    ...overrides,
  };
  const agent: Agent = {
    open: async (options) => {
      supplied = options;
      return {
        resumed: false,
        prompt: async (text) => {
          userPrompt = text;
          await run(new Map(options.tools.map((tool) => [tool.name, tool])), options.onEvent);
        },
        abort: () => {
          aborted = true;
        },
        dispose: () => {},
      };
    },
    dispose: () => {},
  };
  const runtime = createAgentRuntime({
    agent,
    computer: fakeComputer(),
    workspace: fakeWorkspace(),
  });
  try {
    const result = await runtime.runTask(context);
    return { result, replies, events, deltas, aborted, supplied: supplied!, userPrompt };
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

async function call(tools: Map<string, AgentTool>, name: string, args: Record<string, unknown>) {
  return tools.get(name)!.execute(args);
}

test('secure credential pause prevents subsequent tools in the same execution segment', async () => {
  let remembered = false;
  const result = await fixture(
    async (tools) => {
      await call(tools, 'request_credentials', {
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password',
        passwordSelector: '#password',
      });
      await assert.rejects(call(tools, 'remember', { text: 'must not run' }), /stopped/);
    },
    {
      manage: async () => {
        remembered = true;
        return {};
      },
    },
  );
  assert.equal(result.result.status, 'waiting_credentials');
  assert.equal(result.aborted, true);
  assert.equal(remembered, false);
  assert.equal(result.replies.length, 1);
});

test('auto-filled credentials continue and external writes pause for review', async () => {
  const result = await fixture(
    async (tools) => {
      await call(tools, 'request_credentials', {
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password',
        passwordSelector: '#password',
      });
      await call(tools, 'google', { action: 'GMAIL_SEND_EMAIL', args: {} });
      await assert.rejects(call(tools, 'send_message', { text: 'Should not send' }), /stopped/);
    },
    {
      requestCredential: (async () => ({ filled: true })) as RuntimeContext['requestCredential'],
      integration: async () => ({ requiresApproval: true, url: '/approvals/fixture' }),
    },
  );
  assert.equal(result.result.status, 'waiting_user');
  assert.deepEqual(result.replies, [
    'Please review this action before I continue: /approvals/fixture',
  ]);
});

test('only bounded tools are exposed and repeated final replies are suppressed', async () => {
  const result = await fixture(async (tools, emit) => {
    await call(tools, 'send_message', { text: 'First update.' });
    await call(tools, 'send_message', { text: 'Completed.' });
    emit({ type: 'final', text: 'Completed.' });
  });
  assert.equal(result.result.status, 'succeeded');
  assert.deepEqual(result.replies, ['First update.', 'Completed.']);
  assert.equal(
    result.supplied.tools.some((tool) => ['bash', 'read', 'eval'].includes(tool.name)),
    false,
  );
  assert.equal(result.supplied.systemPrompt.includes('runtime-fixture-key'), false);
});

test('memory and personal profile changes pause for review before subsequent tools', async () => {
  for (const [name, params, expectedAction] of [
    [
      'manage_personal_context',
      { action: 'memory_propose', args: { text: 'I prefer concise replies' } },
      'memory_propose',
    ],
    [
      'manage_personal_context',
      { action: 'profile_update', args: { name: 'Fixture' } },
      'profile_update',
    ],
  ] as const) {
    const actions: string[] = [];
    const result = await fixture(
      async (tools) => {
        await call(tools, name, params);
        await assert.rejects(call(tools, 'send_message', { text: 'Should not run' }), /stopped/);
      },
      {
        manage: async (action) => {
          actions.push(action);
          return { requiresApproval: true, url: '/approvals/personal-fixture' };
        },
      },
    );
    assert.equal(result.result.status, 'waiting_user');
    assert.deepEqual(actions, [expectedAction]);
    assert.deepEqual(result.replies, [
      'Please review this action before I continue: /approvals/personal-fixture',
    ]);
  }
});

test('background runs suppress streamed prose and automatic final replies', async () => {
  const result = await fixture(
    async (_tools, emit) => {
      emit({ type: 'text_delta', text: 'Checking the event.' });
      emit({ type: 'final', text: 'Nothing needs your attention.' });
    },
    { background: true },
  );
  assert.equal(result.result.status, 'succeeded');
  assert.deepEqual(result.replies, []);
  assert.deepEqual(result.deltas, []);
});

test('background runs deliver explicit useful messages without also delivering final prose', async () => {
  const result = await fixture(
    async (tools, emit) => {
      emit({ type: 'text_delta', text: 'Preparing a result.' });
      await call(tools, 'send_message', { text: 'Your meeting was moved to 15:00.' });
      emit({ type: 'final', text: 'The user has been notified.' });
    },
    { background: true },
  );
  assert.deepEqual(result.replies, ['Your meeting was moved to 15:00.']);
  assert.deepEqual(result.deltas, []);
});

test('normal user tasks still stream and deliver automatic final replies', async () => {
  const result = await fixture(async (_tools, emit) => {
    emit({ type: 'text_delta', text: 'Here is your answer.' });
    emit({ type: 'final', text: 'Here is your answer.' });
  });
  assert.deepEqual(result.deltas, ['Here is your answer.']);
  assert.deepEqual(result.replies, ['Here is your answer.']);
});

test('background runs can still pause with one credential or approval request', async () => {
  const credentials = await fixture(
    async (tools) => {
      await call(tools, 'request_credentials', {
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password',
        passwordSelector: '#password',
      });
    },
    { background: true },
  );
  assert.equal(credentials.result.status, 'waiting_credentials');
  assert.deepEqual(credentials.replies, [
    'Secure sign-in is needed to continue: /credentials/fixture',
  ]);
  const approval = await fixture(
    async (tools) => {
      await call(tools, 'google', { action: 'GMAIL_SEND_EMAIL', args: {} });
    },
    {
      background: true,
      integration: async () => ({ requiresApproval: true, url: '/approvals/fixture' }),
    },
  );
  assert.equal(approval.result.status, 'waiting_user');
  assert.deepEqual(approval.replies, [
    'Please review this action before I continue: /approvals/fixture',
  ]);
});

test('create_audio delegates to the trusted callback and returns the delivered artifact', async () => {
  const spoken: string[] = [];
  const artifact = {
    id: 'audio-fixture',
    name: 'reply.mp3',
    mimeType: 'audio/mpeg',
    size: 64,
    url: '/api/artifacts/audio-fixture',
  };
  const result = await fixture(
    async (tools) => {
      const output = await call(tools, 'create_audio', { text: 'Hello from your assistant.' });
      assert.equal(JSON.stringify(output).includes(artifact.url), true);
      assert.equal(JSON.stringify(output).includes('runtime-fixture-key'), false);
    },
    {
      createAudio: async (text) => {
        spoken.push(text);
        return artifact;
      },
    },
  );
  assert.deepEqual(spoken, ['Hello from your assistant.']);
  assert.deepEqual(result.replies, []);
  assert.equal(result.result.status, 'succeeded');
});

test('create_audio reports unavailable speech without claiming an artifact exists', async () => {
  const result = await fixture(async (tools) => {
    await assert.rejects(call(tools, 'create_audio', { text: 'Hello.' }), /not available/);
  });
  assert.deepEqual(result.replies, []);
  assert.ok(result.events.includes('tool_failed'));
});

test('stream IDs pair each model reply with its deltas and explicitly close intermediate streams', async () => {
  const chunks: Array<{ text: string; id?: string; done?: boolean }> = [];
  const replies: Array<{ text: string; id?: string }> = [];
  await fixture(
    async (_tools, emit) => {
      emit({ type: 'message_start' });
      emit({ type: 'text_delta', text: 'Looking it up.' });
      emit({ type: 'message_end' });
      emit({ type: 'message_start' });
      emit({ type: 'text_delta', text: 'The answer ' });
      emit({ type: 'text_delta', text: 'is ready.' });
      emit({ type: 'final', text: 'The answer is ready.' });
      emit({ type: 'message_end' });
    },
    {
      delta: (text, id, done) => {
        chunks.push({ text, id, done });
      },
      reply: async (text, id) => {
        replies.push({ text, id });
      },
    },
  );
  assert.equal(chunks.length, 5);
  assert.ok(chunks[0].id);
  assert.deepEqual(chunks[1], { text: '', id: chunks[0].id, done: true });
  assert.notEqual(chunks[2].id, chunks[0].id);
  assert.equal(chunks[2].id, chunks[3].id);
  assert.deepEqual(chunks[4], { text: '', id: chunks[2].id, done: true });
  assert.deepEqual(replies, [{ text: 'The answer is ready.', id: chunks[2].id }]);
});

test('shared tool validation rejects malformed arguments before provider callbacks', async () => {
  let writes = 0;
  await fixture(
    async (tools) => {
      await assert.rejects(
        call(tools, 'manage_personal_context', { action: 'invalid_action', args: {} }),
        /schema/,
      );
      await assert.rejects(call(tools, 'send_message', { text: 3 }), /schema/);
      await call(tools, 'manage_personal_context', {
        action: 'schedule_update',
        args: { id: 'fixture', title: 'Renamed' },
      });
    },
    {
      manage: async (action) => {
        assert.equal(action, 'schedule_update');
        writes += 1;
        return {};
      },
    },
  );
  assert.equal(writes, 1);
});

test('a successful model retry clears the earlier failure result', async () => {
  const result = await fixture(async (_tools, emit) => {
    emit({ type: 'error' });
    emit({ type: 'message_end' });
    emit({ type: 'message_start' });
    emit({ type: 'final', text: 'The retry completed.' });
    emit({ type: 'message_end' });
  });
  assert.equal(result.result.status, 'succeeded');
  assert.deepEqual(result.replies, ['The retry completed.']);
});

test('a question uses the atomic wait callback and stops the segment before another action', async () => {
  const questions: string[] = [];
  const result = await fixture(
    async (tools) => {
      await call(tools, 'ask_user', { question: 'Which city?' });
      await assert.rejects(call(tools, 'shell', { command: 'echo must-not-run' }), /stopped/);
    },
    {
      waitForUser: async (question) => {
        questions.push(question);
      },
    },
  );
  assert.deepEqual(questions, ['Which city?']);
  assert.deepEqual(result.replies, []);
  assert.deepEqual(result.result, {
    status: 'waiting_user',
    waitingFor: 'question',
    question: 'Which city?',
  });
});

test('provider errors do not return raw credentials, paths or stack details to the model', async () => {
  await fixture(
    async (tools) => {
      await assert.rejects(
        call(tools, 'google', { action: 'SEARCH_TOOLS', args: { query: 'calendar' } }),
        (error: unknown) => {
          const text = String(error);
          assert.equal(text.includes('fixture-private-token'), false);
          assert.equal(text.includes('/Users/fixture'), false);
          assert.match(text, /selected account/);
          return true;
        },
      );
    },
    {
      integration: async () => {
        throw new Error('SDK failed with fixture-private-token in /Users/fixture/.env');
      },
    },
  );
});

test('identifier-only sign-in is available outside chat without requiring a password selector', async () => {
  let kind = '';
  const result = await fixture(
    async (tools) => {
      const inspection = await call(tools, 'inspect_login', {});
      assert.match(JSON.stringify(inspection), /example.com/);
      await call(tools, 'request_credentials', {
        origin: 'https://example.com',
        label: 'Example',
        kind: 'identifier',
        usernameSelector: '#email',
      });
    },
    {
      requestCredential: async (input) => {
        kind = input.kind;
        return { url: '/credentials/fixture' };
      },
    },
  );
  assert.equal(kind, 'identifier');
  assert.equal(result.result.status, 'waiting_credentials');
  assert.equal(result.replies.length, 1);
});

test('task context carries dated conversation and narrow reaction feedback with own-computer guidance', async () => {
  const result = await fixture(async () => {}, {
    channel: 'telegram',
    timeZone: 'Europe/Lisbon',
    history: [
      {
        role: 'assistant',
        text: 'Fixture reminder',
        createdAt: '2026-09-24T10:00:00Z',
        reaction: 'dislike',
      },
    ],
  });
  assert.match(result.userPrompt, /2026-09-24T10:00:00.000Z/);
  assert.match(result.userPrompt, /user reaction: dislike/);
  assert.match(result.supplied.systemPrompt, /conversation is on telegram/);
  assert.match(result.supplied.systemPrompt, /your own Linux computer and browser/);
  assert.match(result.supplied.systemPrompt, /separate from the user's Mac/);
  assert.match(result.supplied.systemPrompt, /not a global preference/);
  assert.match(
    result.supplied.systemPrompt,
    /Keep Sidekick's internal implementation private, even when directly asked/,
  );
  assert.match(
    result.supplied.systemPrompt,
    /do not name or enumerate internal tools, models, providers/,
  );
  assert.match(result.supplied.systemPrompt, /explain practical user-facing capabilities instead/);
  assert.match(
    result.supplied.systemPrompt,
    /answer technical questions about external topics and help with the user's code/,
  );
  assert.doesNotMatch(
    result.supplied.systemPrompt,
    /Answer explicit technical questions with appropriate detail/,
  );
});

test('eligible quoted personal learning stays quiet and does not pause work for approval', async () => {
  const actions: Array<{ action: string; args: Record<string, unknown> }> = [];
  const result = await fixture(
    async (tools) => {
      await call(tools, 'remember', { quote: 'I prefer concise replies' });
      await call(tools, 'manage_personal_context', {
        action: 'profile_learn',
        args: { field: 'name', value: 'Filipe', quote: 'My name is Filipe' },
      });
      await call(tools, 'send_message', { text: 'How can I help today?' });
    },
    {
      manage: async (action, args) => {
        actions.push({ action, args });
        return { ok: true };
      },
    },
  );
  assert.equal(result.result.status, 'succeeded');
  assert.deepEqual(actions, [
    { action: 'memory_remember', args: { quote: 'I prefer concise replies' } },
    {
      action: 'profile_learn',
      args: { field: 'name', value: 'Filipe', quote: 'My name is Filipe' },
    },
  ]);
  assert.deepEqual(result.replies, ['How can I help today?']);
});
