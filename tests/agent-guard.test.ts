import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  Agent,
  AgentEvent,
  AgentImage,
  AgentSessionOptions,
  AgentTool,
  RuntimeContext,
  RuntimeObservation,
} from '../src/ports/agent.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';
import type { Computer, LoginInspection, Workspace } from '../src/ports/computer.ts';
import { requestsPrivateInput, vaultInvitation } from '../src/runtime/communication.ts';

async function fixture(
  run: (
    tools: Map<string, AgentTool>,
    emit: (event: AgentEvent) => void,
    options: AgentSessionOptions,
  ) => Promise<void>,
  overrides: Partial<RuntimeContext> = {},
  runtimeOptions: {
    observationTimeoutMs?: number;
    computer?: Computer;
    workspace?: Workspace;
  } = {},
  resumed = false,
) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-session-'));
  const replies: string[] = [];
  const events: string[] = [];
  const deltas: string[] = [];
  let aborted = false;
  let supplied: AgentSessionOptions | undefined;
  let userPrompt = '';
  let promptImages: AgentImage[] = [];
  const context: RuntimeContext = {
    threadId: 'test-' + randomUUID(),
    turnId: randomUUID(),
    prompt: 'Help with a fixture',
    history: [],
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
        resumed,
        prompt: async (text, images) => {
          userPrompt = text;
          promptImages = images ?? [];
          await run(
            new Map(options.tools.map((tool) => [tool.name, tool])),
            options.onEvent,
            options,
          );
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
    computer: fakeComputer({
      inspectLogin: async () => ({
        origin: 'https://example.com',
        url: 'https://example.com/login',
        fields: [{ kind: 'password', selector: '#password', label: 'Password' }],
        methods: [{ id: 'credentials', kind: 'credentials', label: 'Password', supported: true }],
      }),
    }),
    workspace: fakeWorkspace(),
    ...runtimeOptions,
  });
  try {
    const result = await runtime.runTurn(context);
    return {
      result,
      replies,
      events,
      deltas,
      aborted,
      supplied: supplied!,
      userPrompt,
      promptImages,
      catalog: runtime.inspectTools(),
    };
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

async function call(tools: Map<string, AgentTool>, name: string, args: Record<string, unknown>) {
  return tools.get(name)!.execute(args);
}

test('Vault invitations name the broker-observed site and step without using untrusted labels or links', async () => {
  assert.equal(
    vaultInvitation(
      {
        origin: 'https://accounts.example.com:8443/login?state=synthetic-private-state#code',
        kind: 'password',
      },
      '/vault/fixture',
    ),
    'https://accounts.example.com:8443 needs you to sign in. [Enter login details](/vault/fixture) and I will continue the task.',
  );
  for (const link of [
    'https://attacker.test/secret',
    '/vault/fixture?token=secret',
    '/vault/x)bad',
    'javascript:alert(1)',
  ])
    assert.throws(
      () => vaultInvitation({ origin: 'https://example.com', kind: 'password' }, link),
      /unavailable/,
    );
  assert.throws(
    () =>
      vaultInvitation(
        { origin: 'https://user:secret@example.com', kind: 'password' },
        '/vault/fixture',
      ),
    /unavailable/,
  );
  const result = await fixture(
    async (tools) => {
      await call(tools, 'sign_in', {
        action: 'request',
        origin: 'https://example.com',
        label: 'Untrusted **label** https://attacker.test',
        kind: 'password',
      });
    },
    {
      requestCredential: async () => ({
        url: '/vault/fixture',
        invitation: { origin: 'https://example.com', kind: 'identifier' },
      }),
    },
  );
  assert.deepEqual(result.replies, [
    'https://example.com needs you to sign in. [Enter login details](/vault/fixture) and I will continue the task.',
  ]);
});

test('a trusted code request asks in chat without a Vault link or exposing inbox metadata to tools', async () => {
  const observations: RuntimeObservation[] = [];
  const inspection: LoginInspection = {
    origin: 'https://accounts.example.test',
    url: 'https://accounts.example.test/verify',
    fields: [{ kind: 'otp', selector: '#code', label: 'Verification code' }],
    methods: [
      { id: 'credentials', label: 'Verification code', kind: 'credentials', supported: true },
    ],
    emailCode: { recipient: 'private-inbox@example.test', length: 6 },
  };
  const result = await fixture(
    async (tools) => {
      for (const args of [
        { action: 'inspect' },
        { action: 'select_method', origin: inspection.origin, methodId: 'credentials' },
      ]) {
        const output = await call(tools, 'sign_in', args);
        assert.doesNotMatch(JSON.stringify(output), /emailCode|private-inbox/);
        assert.match(JSON.stringify(output), /Verification code/);
      }
      await call(tools, 'sign_in', {
        action: 'request',
        origin: inspection.origin,
        label: 'Example',
        kind: 'otp',
      });
    },
    {
      requestCredential: async () => ({ invitation: { origin: inspection.origin, kind: 'otp' } }),
      observe: async (event) => {
        observations.push(event);
      },
    },
    { computer: fakeComputer({ inspectLogin: async () => inspection }) },
  );
  assert.equal(result.result.status, 'waiting_credentials');
  assert.equal(result.replies.length, 1);
  assert.match(result.replies[0]!, /Reply here with the code/);
  assert.doesNotMatch(result.replies[0]!, /vault|credentials\//i);
  assert.doesNotMatch(JSON.stringify(observations), /emailCode|private-inbox/);
});

test('chat login solicitations are withheld without inspecting or opening Vault', async () => {
  for (const method of ['ask_user', 'send_message', 'final']) {
    let requests = 0;
    let inspections = 0;
    let prompts = 0;
    const outputs: string[] = [];
    const result = await fixture(
      async (tools, emit) => {
        prompts++;
        const text = "What's your X username?";
        if (prompts > 1) emit({ type: 'final', text: 'I will use secure sign-in instead.' });
        else if (method === 'final') {
          emit({ type: 'text_delta', text: "What's your X " });
          emit({ type: 'text_delta', text: 'username?' });
          emit({ type: 'final', text });
        } else {
          const output = await call(
            tools,
            method,
            method === 'ask_user' ? { question: text } : { text },
          );
          outputs.push(JSON.stringify(output.content));
        }
      },
      {
        requestCredential: async () => {
          requests++;
          return { url: '/vault/fixture' };
        },
      },
      {
        computer: fakeComputer({
          inspectLogin: async () => {
            inspections++;
            throw new Error('Unused fixture inspection.');
          },
        }),
      },
    );
    assert.equal(result.result.status, 'succeeded', method);
    assert.equal(requests, 0, method);
    assert.equal(inspections, 0, method);
    assert.equal(result.deltas.join('').includes('username'), false);
    if (method === 'final') {
      assert.equal(prompts, 2);
      assert.match(result.userPrompt, /Not sent: never ask for passwords/);
      assert.deepEqual(result.replies, ['I will use secure sign-in instead.']);
    } else {
      assert.equal(prompts, 1);
      assert.deepEqual(result.replies, []);
      assert.match(outputs[0], /withheld/);
    }
  }
});

test('a continuation repeating the same private-input request fails instead of being deduplicated', async () => {
  let prompts = 0;
  await assert.rejects(
    fixture(async (_tools, emit) => {
      prompts++;
      emit({ type: 'final', text: "What's your username?" });
    }),
    /The reply kept asking for private sign-in details/,
  );
  assert.equal(prompts, 2);
});

test('chat connection shows one sign-in link and waits for its callback', async () => {
  const questions: string[] = [];
  const result = await fixture(
    async (tools, emit) => {
      await call(tools, 'manage_apps', { action: 'connect', service: 'linear' });
      emit({ type: 'final', text: 'The account is connected.' });
    },
    {
      connections: async () => ({ name: 'Linear', url: 'https://mcp.linear.app/authorize' }),
      waitForUser: async (question) => {
        questions.push(question);
      },
    },
  );
  assert.equal(result.result.status, 'waiting_user');
  assert.equal(result.aborted, true);
  assert.deepEqual(result.replies, []);
  assert.deepEqual(questions, [
    'I need access to your Linear account for this task. [Connect Linear](https://mcp.linear.app/authorize) and I will continue here.',
  ]);
});

test('waitForThread drains an in-flight browser action even after the model prompt ends on abort', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-drain-'));
  const controller = new AbortController();
  let started!: () => void;
  let release!: () => void;
  let endPrompt!: () => void;
  const actionStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const actionGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const id = 'test-' + randomUUID();
  const runtime = createAgentRuntime({
    agent: {
      open: async (options) => ({
        resumed: false,
        prompt: async () => {
          void options.tools
            .find((tool) => tool.name === 'browser')!
            .execute({ action: 'snapshot' })
            .catch(() => {});
          await new Promise<void>((resolve) => {
            endPrompt = resolve;
          });
        },
        abort: () => endPrompt(),
        dispose() {},
      }),
      dispose() {},
    },
    computer: fakeComputer({
      act: async () => {
        started();
        await actionGate;
        return { text: '', url: 'https://example.com', candidates: [] };
      },
    }),
    workspace: fakeWorkspace(),
  });
  try {
    const execution = runtime
      .runTurn({
        threadId: id,
        turnId: randomUUID(),
        prompt: 'Open a fixture page',
        history: [],
        attachments: [],
        workspacePath: directory,
        signal: controller.signal,
        emit: async () => {},
        reply: async () => {},
        delta() {},
        publish: async () => {
          throw new Error('Unused');
        },
        requestCredential: async () => ({}),
        integration: async () => ({}),
        manage: async () => ({}),
      })
      .catch((error) => error);
    await actionStarted;
    controller.abort();
    let drained = false;
    const drain = runtime.waitForThread(id).then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(drained, false);
    assert.equal(runtime.status().activeThreads, 1);
    release();
    assert.ok((await execution) instanceof Error);
    await drain;
    assert.equal(runtime.status().activeThreads, 0);
  } finally {
    release();
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('secure credential pause prevents subsequent tools in the same execution segment', async () => {
  let managed = false;
  const result = await fixture(
    async (tools) => {
      await call(tools, 'sign_in', {
        action: 'request',
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password',
        passwordSelector: '#password',
      });
      await assert.rejects(
        call(tools, 'manage_personal_context', {
          action: 'goal_create',
          args: { title: 'must not run' },
        }),
        /stopped/,
      );
    },
    {
      manage: async () => {
        managed = true;
        return {};
      },
    },
  );
  assert.equal(result.result.status, 'waiting_credentials');
  assert.equal(result.aborted, true);
  assert.equal(managed, false);
  assert.equal(result.replies.length, 1);
});

test('auto-filled credentials continue and a saved chat confirmation pauses without duplicate prose', async () => {
  const result = await fixture(
    async (tools) => {
      await call(tools, 'sign_in', {
        action: 'request',
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password',
        passwordSelector: '#password',
      });
      await call(tools, 'apps', { action: 'GMAIL_SEND_EMAIL', args: {} });
      await assert.rejects(call(tools, 'send_message', { text: 'Should not send' }), /stopped/);
    },
    {
      requestCredential: (async () => ({ filled: true })) as RuntimeContext['requestCredential'],
      integration: async () => ({
        requiresConfirmation: true,
        question: 'Send this exact fixture email?',
      }),
    },
  );
  assert.equal(result.result.status, 'waiting_user');
  assert.deepEqual(result.replies, []);
  assert.equal(result.result.question, 'Send this exact fixture email?');
});

test('a blocked credential solicitation keeps the rest of that message out of chat and saved commentary', async () => {
  const result = await fixture(async (_tools, emit) => {
    emit({ type: 'message_start' });
    emit({ type: 'text_delta', text: 'I found the website. ' });
    emit({ type: 'text_delta', text: 'Please send me your password. ' });
    emit({ type: 'text_delta', text: 'Then I can continue.' });
    emit({ type: 'message_end', status: 'succeeded' });
  });
  assert.deepEqual(result.replies, []);
  assert.deepEqual(result.deltas, ['I found the website. ']);
});

test('provider errors do not return raw credentials, paths or stack details to the model', async () => {
  await fixture(
    async (tools) => {
      await assert.rejects(
        call(tools, 'apps', { action: 'SEARCH_TOOLS', args: { query: 'calendar' } }),
        (error: unknown) => {
          const text = String(error);
          assert.equal(text.includes('fixture-private-token'), false);
          assert.equal(text.includes('/Users/fixture'), false);
          assert.match(text, /The action failed/);
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

test('stale credential requests inspect the current page and return observations without a new Vault form', async () => {
  for (const page of [
    'Account overview: invoice NS-1042, EUR 240.',
    'Service temporarily unavailable.',
  ]) {
    let requests = 0;
    const actions: string[] = [];
    const result = await fixture(
      async (tools) => {
        const result = await call(tools, 'sign_in', {
          action: 'request',
          origin: 'https://example.com',
          label: 'Previous verification step',
          kind: 'otp',
          passwordSelector: '#old-code',
        });
        assert.equal(result.content[0].type, 'text');
        if (result.content[0].type !== 'text') throw new Error('Expected observation data.');
        const data = JSON.parse(result.content[0].text);
        assert.equal(data.outcome, 'no_sign_in_step');
        assert.equal(data.observation.text, page);
        assert.equal(data.message, 'This page has no sign-in fields or methods.');
      },
      {
        prompt:
          'The secure credential step has completed. Inspect the current browser and continue the original task.',
        requestCredential: async () => {
          requests++;
          return { url: '/vault/unnecessary-form' };
        },
      },
      {
        computer: fakeComputer({
          inspectLogin: async () => {
            actions.push('inspect');
            return {
              origin: 'https://example.com',
              url: 'https://example.com/current',
              fields: [],
              methods: [],
            };
          },
          act: async (_id, action) => {
            actions.push(action.action);
            return { text: page, url: 'https://example.com/current', candidates: [] };
          },
        }),
      },
      true,
    );
    assert.deepEqual(actions, ['inspect', 'snapshot']);
    assert.equal(requests, 0);
    assert.equal(result.result.status, 'succeeded');
    assert.deepEqual(result.replies, []);
  }
});

test('a blocked browser sign-in returns native handoff guidance without a Vault request or snapshot', async () => {
  let requests = 0;
  let snapshots = 0;
  const result = await fixture(
    async (tools) => {
      const output = await call(tools, 'sign_in', {
        action: 'request',
        origin: 'https://accounts.google.com',
        label: 'Google',
        kind: 'identifier',
      });
      assert.equal(output.content[0].type, 'text');
      if (output.content[0].type !== 'text') return;
      const value = JSON.parse(output.content[0].text);
      assert.equal(value.outcome, 'sign_in_blocked');
      assert.equal(value.issue, 'browser_not_supported');
      assert.match(value.message, /Take control/);
      assert.match(value.message, /Resume agent/);
      assert.doesNotMatch(value.message, /signed in successfully/i);
    },
    {
      requestCredential: async () => {
        requests++;
        return { url: '/vault/unnecessary' };
      },
    },
    {
      computer: fakeComputer({
        inspectLogin: async () => ({
          origin: 'https://accounts.google.com',
          url: 'https://accounts.google.com/signin',
          issue: 'browser_not_supported',
          fields: [],
          methods: [],
        }),
        act: async () => {
          snapshots++;
          return { url: 'https://accounts.google.com', text: 'Blocked sign-in', candidates: [] };
        },
      }),
    },
  );
  assert.equal(requests, 0);
  assert.equal(snapshots, 0);
  assert.deepEqual(result.replies, []);
});

test('a sole supported provider bypasses ambiguous credential fields and opens Vault only on its resulting page', async () => {
  let selected = 0;
  let requests = 0;
  const provider: LoginInspection = {
    origin: 'https://accounts.example.test',
    url: 'https://accounts.example.test/login',
    fields: [{ kind: 'identifier', selector: '#email', label: 'Email' }],
    methods: [{ id: 'credentials', kind: 'credentials', label: 'Email', supported: true }],
  };
  const result = await fixture(
    async (tools) => {
      const output = await call(tools, 'sign_in', {
        action: 'request',
        origin: 'https://example.com',
        label: 'Example',
        kind: 'identifier',
      });
      assert.match(JSON.stringify(output), /login_method_selected/);
      assert.match(JSON.stringify(output), /accounts\.example\.test/);
      assert.equal(requests, 0);
      await call(tools, 'sign_in', {
        action: 'request',
        origin: provider.origin,
        label: 'Provider',
        kind: 'identifier',
      });
    },
    {
      requestCredential: async (input) => {
        assert.equal(input.origin, provider.origin);
        requests++;
        return { url: '/credentials/provider-after-selection' };
      },
    },
    {
      computer: fakeComputer({
        inspectLogin: async () =>
          selected
            ? provider
            : {
                origin: 'https://example.com',
                url: 'https://example.com/login',
                fields: [
                  { kind: 'identifier', selector: '#first-email', label: 'Email' },
                  { kind: 'identifier', selector: '#other-email', label: 'Email' },
                ],
                methods: [
                  {
                    id: 'credentials',
                    kind: 'credentials',
                    label: 'Email',
                    supported: false,
                    reason: 'More than one active form matches this step.',
                  },
                  {
                    id: 'oauth-google',
                    kind: 'oauth',
                    label: 'Google',
                    supported: true,
                    selector: '#google',
                  },
                ],
              },
        selectLoginMethod: async (_threadId, origin, methodId) => {
          assert.equal(origin, 'https://example.com');
          assert.equal(methodId, 'oauth-google');
          selected++;
        },
      }),
    },
  );
  assert.equal(selected, 1);
  assert.equal(requests, 1);
  assert.equal(result.result.status, 'waiting_credentials');
  assert.equal(result.replies.length, 1);
  assert.match(result.replies[0], /provider-after-selection/);
});

const loginChoices: LoginInspection = {
  origin: 'https://example.com',
  url: 'https://example.com/login',
  fields: [{ kind: 'identifier', selector: '#email', label: 'Email' }],
  methods: [
    { id: 'credentials', kind: 'credentials', label: 'Email', supported: true },
    { id: 'oauth-google', kind: 'oauth', label: 'Google', supported: true, selector: '#google' },
    { id: 'oauth-apple', kind: 'oauth', label: 'Apple', supported: true, selector: '#apple' },
    { id: 'passkey', kind: 'passkey', label: 'Passkey', supported: false },
  ],
};

test('method selection rejects changed origins, unavailable options and blocked pages before clicking', async () => {
  let selections = 0;
  let login = loginChoices;
  await fixture(
    async (tools) => {
      for (const args of [
        { origin: 'https://wrong.example.test', methodId: 'oauth-google' },
        { origin: loginChoices.origin + '/login', methodId: 'oauth-google' },
        { origin: loginChoices.origin, methodId: 'unknown' },
        { origin: loginChoices.origin, methodId: 'passkey' },
      ]) {
        await assert.rejects(
          call(tools, 'sign_in', { action: 'select_method', ...args }),
          /The action failed/,
        );
      }
      login = { ...loginChoices, issue: 'browser_not_supported' };
      await assert.rejects(
        call(tools, 'sign_in', {
          action: 'select_method',
          origin: loginChoices.origin,
          methodId: 'oauth-google',
        }),
        /The action failed/,
      );
    },
    {},
    {
      computer: fakeComputer({
        inspectLogin: async () => login,
        selectLoginMethod: async () => {
          selections++;
        },
      }),
    },
  );
  assert.equal(selections, 0);
});

test('cancellation during method inspection prevents provider selection', async () => {
  const controller = new AbortController();
  let selections = 0;
  await assert.rejects(
    fixture(
      async (tools) => {
        await call(tools, 'sign_in', {
          action: 'select_method',
          origin: loginChoices.origin,
          methodId: 'oauth-google',
        });
      },
      { signal: controller.signal },
      {
        computer: fakeComputer({
          inspectLogin: async () => {
            controller.abort();
            return loginChoices;
          },
          selectLoginMethod: async () => {
            selections++;
          },
        }),
      },
    ),
    /cancelled/,
  );
  assert.equal(selections, 0);
});

test('cancellation while recording a tool start prevents the action from beginning', async () => {
  const controller = new AbortController();
  const observations: RuntimeObservation[] = [];
  let executed = false;
  await assert.rejects(
    fixture(
      async (tools) => {
        await call(tools, 'apps', { action: 'FIXTURE_ACTION', args: {} });
      },
      {
        signal: controller.signal,
        observe: async (event) => {
          observations.push(event);
          if (event.type === 'tool_start') controller.abort();
        },
        integration: async () => {
          executed = true;
          return {};
        },
      },
    ),
    /cancelled/,
  );
  assert.equal(executed, false);
  assert.equal(observations.at(-1)?.type, 'tool_end');
  const end = observations.at(-1);
  assert.equal(end?.type === 'tool_end' && end.status, 'cancelled');
});

test('screenshot publishing cannot bypass secure-entry locks, unavailable screens or cancellation', async () => {
  for (const outcome of ['locked', 'unavailable', 'cancelled'] as const) {
    const controller = new AbortController();
    let published = 0;
    const running = fixture(
      async (tools) => {
        await assert.rejects(
          call(tools, 'browser', { action: 'share_screenshot' }),
          outcome === 'cancelled' ? /cancelled/ : /The action failed/,
        );
      },
      {
        signal: controller.signal,
        publishScreenshot: async () => {
          published++;
          throw new Error('Must not publish');
        },
      },
      {
        computer: fakeComputer({
          screenshot: async () => {
            if (outcome === 'locked')
              throw Object.assign(new Error('private fixture credential text'), {
                statusCode: 423,
              });
            if (outcome === 'unavailable') return null;
            controller.abort();
            return Buffer.from('Must not publish');
          },
        }),
      },
    );
    if (outcome === 'cancelled') await assert.rejects(running, /abort/i);
    else await running;
    assert.equal(published, 0);
  }
});

test('private input detection covers login details, codes and API keys without classifying ordinary text', () => {
  for (const text of [
    "What's your login email?",
    'Please provide your password.',
    'Please provide your login credentials so I can continue.',
    'Please share your sign-in details to continue.',
    'Tell me your verification code.',
    'Qual é o teu nome de utilizador?',
    'Please provide your API key.',
    'API key please.',
    'Partilha a tua chave da API.',
  ])
    assert.equal(requestsPrivateInput(text), true, text);
  for (const text of [
    'A username identifies an account.',
    'Which city should I use?',
    'I found the password reset help page.',
    'This service uses an API key.',
    'Which sign-in method would you like to use: email, Google or Apple?',
    'Please use Sign in in browser under the browser controls, sign in to X in that separate window, then choose Continue in Otto.',
  ])
    assert.equal(requestsPrivateInput(text), false, text);
});

test('read-only app downloads keep the owned callback and ordinary findings reply', async () => {
  const downloads: string[] = [];
  const delivered = {
    id: randomUUID(),
    name: 'fixture.txt',
    mimeType: 'text/plain',
    size: 7,
    url: '/api/artifacts/fixture-file',
    workspaceFile: 'fixture-file-fixture.txt',
  };
  const result = await fixture(
    async (tools) => {
      const response = await call(tools, 'apps', {
        action: 'GMAIL_GET_ATTACHMENT',
        args: { connectionId: 'fixture-account', message_id: 'mail-1', attachment_id: 'file-1' },
      });
      const first = response.content[0];
      assert.deepEqual(first.type === 'text' && JSON.parse(first.text), delivered);
      await assert.rejects(call(tools, 'share_file', { path: 'invoice.pdf' }), /can only read/);
      await call(tools, 'send_message', { text: 'I found the invoice.' });
    },
    {
      readOnly: true,
      background: true,
      downloadIntegrationFile: async (action) => {
        downloads.push(action);
        return delivered;
      },
    },
  );
  assert.deepEqual(downloads, ['GMAIL_GET_ATTACHMENT']);
  assert.deepEqual(result.replies, ['I found the invoice.']);
  assert.deepEqual(result.result, { status: 'succeeded' });
});

const native = new Set(['read', 'bash', 'edit', 'write', 'find', 'ls']);

const refusal = 'This turn can only read. Use app reads, and browser open, snapshot or scroll.';

const refused: Array<[string, Record<string, unknown>]> = [
  ['browser', { action: 'click', selector: '@send' }],
  ['browser', { action: 'fill', selector: '@reply', text: 'Synthetic reply' }],
  ['browser', { action: 'press', key: 'Enter' }],
  ['browser', { action: 'share_screenshot' }],
  ['browser', { action: 'download', url: 'https://mail.example.test/file.pdf' }],
  ['browser_session', { action: 'connect', url: 'https://mail.example.test/' }],
  ['bash', { command: 'curl https://example.test' }],
  ['write', { path: 'notes.txt', content: 'Synthetic note' }],
  ['edit', { path: 'notes.txt', edits: [{ oldText: 'a', newText: 'b' }] }],
  ['share_file', { path: 'notes.txt' }],
  ['manage_apps', { action: 'connect', service: 'gmail' }],
  ['manage_personal_context', { action: 'goal_create', args: { title: 'Synthetic goal' } }],
  ['manage_personal_context', { action: 'schedule_create', args: { title: 'Synthetic' } }],
  ['sign_in', { action: 'inspect' }],
  ['sign_in', { action: 'select_method', origin: 'https://mail.example.test', methodId: 'google' }],
  [
    'sign_in',
    { action: 'request', origin: 'https://mail.example.test', label: 'Sign in', kind: 'password' },
  ],
  ['ask_user', { question: 'Which email should I answer?' }],
  ['create_audio', { text: 'Synthetic speech' }],
];

async function run(readOnly: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-welcome-read-only-'));
  const outcomes = new Map<string, string>();
  const browserActions: string[] = [];
  const integrationCalls: string[] = [];
  const manageCalls: string[] = [];
  const replies: string[] = [];
  const observations: RuntimeObservation[] = [];
  let commands = 0;
  let writes = 0;
  let credentials = 0;
  let connections = 0;
  const agent: Agent = {
    open: async (input) => ({
      resumed: false,
      abort: () => {},
      dispose: () => {},
      prompt: async () => {
        const tools = new Map<string, AgentTool>(input.tools.map((entry) => [entry.name, entry]));
        const call = async (name: string, args: Record<string, unknown>) => {
          const key = `${name} ${String(args.action ?? '')}`.trim();
          try {
            const result = native.has(name)
              ? await input.runTool(name, args, async () => {
                  if (name === 'bash') commands++;
                  if (name === 'write' || name === 'edit') writes++;
                  return { content: [{ type: 'text', text: `Fixture ${name}` }] };
                })
              : await tools.get(name)!.execute(args);
            const content = result.content[0];
            outcomes.set(key, content.type === 'text' ? content.text : content.type);
          } catch (error) {
            outcomes.set(key, `error: ${(error as Error).message}`);
          }
        };
        await call('manage_apps', { action: 'list' });
        await call('apps', { action: 'GMAIL_FETCH_EMAILS', args: { max_results: 5 } });
        await call('manage_personal_context', { action: 'history_search', args: { query: 'x' } });
        await call('browser', { action: 'open', url: 'https://mail.example.test/' });
        await call('browser', { action: 'snapshot' });
        await call('browser', { action: 'scroll', direction: 'down' });
        await call('browser', { action: 'screenshot' });
        await call('read', { path: 'notes.txt' });
        await call('find', { pattern: '*.txt' });
        await call('ls', {});
        await call('web_search', { query: 'synthetic' });
        if (!readOnly) {
          await call('browser', { action: 'click', selector: '@send' });
          return;
        }
        for (const [name, args] of refused) await call(name, args);
        await call('send_message', { text: 'You have two threads that wait for your reply.' });
      },
    }),
    dispose: () => {},
  };
  const runtime = createAgentRuntime({
    agent,
    workspace: fakeWorkspace(),
    webSearch: async () => ({ source: 'fixture', results: [] }),
    computer: fakeComputer({
      act: async (_threadId, action) => {
        browserActions.push(action.action);
        return { text: 'Synthetic inbox', url: 'https://mail.example.test/', candidates: [] };
      },
    }),
  });
  const context: RuntimeContext = {
    threadId: randomUUID(),
    turnId: randomUUID(),
    prompt: 'Synthetic welcome discovery',
    background: true,
    readOnly,
    history: [],
    workspacePath: directory,
    signal: new AbortController().signal,
    attachments: [],
    emit: async () => {},
    reply: async (text) => {
      replies.push(text);
    },
    delta: () => {},
    publish: async () => {
      throw new Error('No file is expected.');
    },
    requestCredential: async () => {
      credentials++;
      return {};
    },
    integration: async (action) => {
      integrationCalls.push(action);
      return { successful: true, data: { threads: 2 } };
    },
    connections: async (action) => {
      connections++;
      return action === 'list' ? [{ slug: 'gmail', status: 'connected' }] : {};
    },
    browserConnection: async () => {
      connections++;
      return {};
    },
    observe: async (event) => {
      observations.push(event);
    },
    manage: async (action) => {
      manageCalls.push(action);
      return { results: [] };
    },
  };
  try {
    const result = await runtime.runTurn(context);
    return {
      result,
      outcomes,
      browserActions,
      integrationCalls,
      manageCalls,
      replies,
      observations,
      commands,
      writes,
      credentials,
      connections,
    };
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

test('a read-only turn refuses every outside action with a fixed error and still posts its findings', async () => {
  const run1 = await run(true);
  for (const [name, args] of refused)
    assert.equal(
      run1.outcomes.get(`${name} ${String(args.action ?? '')}`.trim()),
      `error: ${refusal}`,
      name,
    );
  assert.match(run1.outcomes.get('manage_apps list')!, /gmail/);
  assert.match(run1.outcomes.get('apps GMAIL_FETCH_EMAILS')!, /threads/);
  assert.match(run1.outcomes.get('manage_personal_context history_search')!, /results/);
  assert.match(run1.outcomes.get('browser open')!, /Synthetic inbox/);
  assert.match(run1.outcomes.get('browser snapshot')!, /Synthetic inbox/);
  assert.match(run1.outcomes.get('browser scroll')!, /Synthetic inbox/);
  assert.equal(run1.outcomes.get('browser screenshot'), 'Open a browser URL first.');
  for (const name of ['read', 'find', 'ls'])
    assert.equal(run1.outcomes.get(name), `Fixture ${name}`);
  assert.match(run1.outcomes.get('web_search')!, /fixture/);
  assert.deepEqual(run1.browserActions, ['open', 'snapshot', 'scroll']);
  assert.deepEqual(run1.integrationCalls, ['GMAIL_FETCH_EMAILS']);
  assert.deepEqual(run1.manageCalls, ['history_search']);
  assert.equal(run1.commands, 0);
  assert.equal(run1.writes, 0);
  assert.equal(run1.credentials, 0);
  assert.equal(run1.connections, 1);
  assert.deepEqual(run1.replies, ['You have two threads that wait for your reply.']);
  assert.deepEqual(run1.result, { status: 'succeeded' });
  const failures = run1.observations.filter(
    (event) => event.type === 'tool_end' && event.status === 'failed',
  );
  assert.equal(failures.length, refused.length);
  for (const event of failures) assert.equal(event.type === 'tool_end' && event.error, refusal);
  assert.equal(
    run1.observations.filter((event) => event.type === 'tool_start').length,
    run1.observations.filter((event) => event.type === 'tool_end').length,
  );
});
