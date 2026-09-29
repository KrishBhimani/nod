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
import type { Computer, LoginInspection, Workspace } from '../src/ports/computer.ts';

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
) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-session-'));
  const replies: string[] = [];
  const deltas: string[] = [];
  let aborted = false;
  let supplied: AgentSessionOptions | undefined;
  let userPrompt = '';
  const context: RuntimeContext = {
    threadId: 'test-' + randomUUID(),
    turnId: randomUUID(),
    prompt: 'Help with a fixture',
    history: [],
    workspacePath: directory,
    signal: new AbortController().signal,
    attachments: [],
    emit: async () => {},
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
        resumed: false,
        prompt: async (text) => {
          userPrompt = text;
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
      deltas,
      aborted,
      supplied: supplied!,
      userPrompt,
    };
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

async function call(tools: Map<string, AgentTool>, name: string, args: Record<string, unknown>) {
  return tools.get(name)!.execute(args);
}

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

test('a sole OAuth method already chosen is not clicked again on the next request', async () => {
  let selections = 0;
  const sole: LoginInspection = {
    origin: 'https://example.com',
    url: 'https://example.com/login',
    fields: [],
    methods: [
      { id: 'oauth-google', kind: 'oauth', label: 'Google', supported: true, selector: '#google' },
    ],
  };
  await fixture(
    async (tools) => {
      const request = {
        action: 'request',
        origin: sole.origin,
        label: 'Example',
        kind: 'password',
      };
      assert.match(JSON.stringify(await call(tools, 'sign_in', request)), /login_method_selected/);
      await call(tools, 'sign_in', request);
    },
    {},
    {
      computer: fakeComputer({
        inspectLogin: async () => sole,
        selectLoginMethod: async () => {
          selections++;
        },
      }),
    },
  );
  assert.equal(selections, 1);
});

const refusal = 'This turn can only read. Use app reads, and browser open, snapshot or scroll.';

const refused: Array<[string, Record<string, unknown>]> = [
  ['browser', { action: 'click', selector: '@send' }],
  ['browser', { action: 'fill', selector: '@reply', text: 'Synthetic reply' }],
  ['browser', { action: 'share_screenshot' }],
  ['browser_session', { action: 'connect', url: 'https://mail.example.test/' }],
  ['bash', { command: 'curl https://example.test' }],
  ['write', { path: 'notes.txt', content: 'Synthetic note' }],
  ['share_file', { path: 'notes.txt' }],
  ['manage_apps', { action: 'connect', service: 'gmail' }],
  ['manage_personal_context', { action: 'schedule_create', args: { title: 'Synthetic' } }],
  [
    'sign_in',
    { action: 'request', origin: 'https://mail.example.test', label: 'Sign in', kind: 'password' },
  ],
  ['ask_user', { question: 'Which email should I answer?' }],
];

test('a read-only turn refuses every outside action with a fixed error and still posts its findings', async () => {
  let sideEffects = 0;
  const result = await fixture(
    async (tools, _emit, options) => {
      for (const [name, args] of refused)
        await assert.rejects(
          tools.has(name)
            ? call(tools, name, args)
            : options.runTool(name, args, async () => {
                sideEffects++;
                return { content: [] };
              }),
          (error: Error) => error.message === refusal,
          name,
        );
      await call(tools, 'apps', { action: 'GMAIL_FETCH_EMAILS', args: {} });
      await call(tools, 'send_message', { text: 'You have two threads to answer.' });
    },
    {
      readOnly: true,
      background: true,
      requestCredential: async () => {
        sideEffects++;
        return {};
      },
      manage: async () => {
        sideEffects++;
        return {};
      },
      integration: async (action) => {
        assert.equal(action, 'GMAIL_FETCH_EMAILS');
        return {};
      },
    },
    {
      computer: fakeComputer({
        act: async () => {
          sideEffects++;
          return { text: '', url: 'https://mail.example.test/', candidates: [] };
        },
      }),
    },
  );
  assert.equal(sideEffects, 0);
  assert.deepEqual(result.replies, ['You have two threads to answer.']);
  assert.deepEqual(result.result, { status: 'succeeded' });
});
