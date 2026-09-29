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

test('PIN and semantic login identifier requests never reach chat', async () => {
  for (const text of [
    'Qual é o teu PIN da Chave Móvel Digital?',
    'Envia-me o teu código PIN.',
    'Preciso do seu PIN de autenticação.',
    'What is your sign-in PIN?',
    'Podes indicar o PIN da CMD?',
    'Please enter the PIN.',
    'Fornece o teu número de telemóvel para iniciar sessão.',
    'Qual é o código de segurança?',
    'Qual é o código que recebeste por SMS?',
    'What is the code you received?',
    'Can you send the code?',
    'Indica o código recebido no telemóvel.',
    'Enter your tax identification number to sign in.',
    'Qual é o teu NIF para entrar?',
    'Envía tu contraseña para iniciar sesión.',
    'Indiquez votre mot de passe pour vous connecter.',
    'Quel est votre mot de passe?',
    'Quel est votre code de vérification?',
    '¿Cuál es tu contraseña?',
    '¿Cuál es el código de verificación?',
    'Enter the code to continue.',
    'Introduz o código para continuar.',
    'What is your phone number for signing in?',
    'What is your email for logging in?',
    'Email, please, to continue logging in.',
    'O teu email, por favor, para iniciar sessão.',
    'Your phone number, please, to sign in.',
    'Sign in: your email, please.',
  ]) {
    for (const method of ['ask_user', 'send_message', 'final']) {
      let prompts = 0;
      const result = await fixture(async (tools, emit) => {
        prompts++;
        if (prompts > 1) emit({ type: 'final', text: 'I will use secure sign-in instead.' });
        else if (method === 'final') {
          emit({ type: 'text_delta', text });
          emit({ type: 'final', text });
        } else await call(tools, method, method === 'ask_user' ? { question: text } : { text });
      });
      assert.equal(result.result.status, 'succeeded', `${method}: ${text}`);
      assert.equal(result.replies.includes(text), false, `${method}: ${text}`);
      assert.equal(result.deltas.join('').includes(text), false, `${method}: ${text}`);
    }
  }
});

test('sign-in method questions remain available without requesting credential values', async () => {
  for (const question of [
    'Queres usar Cartão de Cidadão ou Chave Móvel Digital?',
    'Preferes Telemóvel ou Código QR?',
    'Qual é o método de autenticação: NIF ou EORI?',
    'Can you send the code snippet?',
    'What is the code that calculates tax?',
    'Can you share the QR code image?',
    'Sign in with email to continue.',
    'Continua com email para iniciar sessão.',
  ]) {
    const result = await fixture(async (tools) => {
      await call(tools, 'ask_user', { question });
    });
    assert.equal(result.result.status, 'waiting_user');
    assert.deepEqual(result.replies, [question]);
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

test('manual sign-in alternatives remain a user choice without browser or Vault actions', async () => {
  let selections = 0;
  let requests = 0;
  const login: LoginInspection = {
    origin: 'https://example.com',
    url: 'https://example.com/login',
    fields: [],
    methods: [
      {
        id: 'password',
        kind: 'credentials',
        label: 'Password',
        supported: true,
        selector: '#password',
      },
      { id: 'passkey', kind: 'passkey', label: 'Passkey', supported: false },
    ],
  };
  await fixture(
    async (tools) => {
      const result = await call(tools, 'sign_in', {
        action: 'request',
        origin: login.origin,
        label: 'Example',
        kind: 'password',
      });
      const choice = JSON.parse((result.content[0] as { text: string }).text);
      assert.equal(choice.outcome, 'choose_sign_in_method');
      assert.deepEqual(
        choice.methods.map((method: { id: string }) => method.id),
        ['password', 'passkey'],
      );
      const selected = await call(tools, 'sign_in', {
        action: 'select_method',
        origin: login.origin,
        methodId: 'passkey',
      });
      assert.equal(
        JSON.parse((selected.content[0] as { text: string }).text).outcome,
        'manual_sign_in_required',
      );
    },
    {
      requestCredential: async () => {
        requests++;
        return { filled: true };
      },
    },
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
  assert.equal(requests, 0);
});

test('nested sign-in groups preserve the chosen method and ask about the next group before Vault', async () => {
  const origin = 'https://identity.example.test';
  const method = (id: string, label: string, group: string, selected = false) => ({
    id,
    label,
    group,
    selected,
    kind: 'credentials' as const,
    supported: true,
    selector: `#${id}`,
  });
  const outer = [
    method('card', 'Cartão de Cidadão', 'Authentication', true),
    method('cmd', 'Chave Móvel Digital', 'Authentication'),
  ];
  const inner = [
    method('phone', 'Telemóvel', 'Chave Móvel Digital', true),
    method('qr', 'Código QR', 'Chave Móvel Digital'),
  ];
  const next = {
    id: 'continue',
    label: 'Continuar',
    kind: 'credentials' as const,
    supported: true,
    selector: '#continue',
  };
  let login: LoginInspection = {
    origin,
    url: origin + '/login',
    fields: [],
    methods: [...outer, next],
  };
  const selections: string[] = [];
  const requests: unknown[] = [];
  await fixture(
    async (tools) => {
      const request = { action: 'request', origin, label: 'Identity fixture', kind: 'password' };
      const choice = async () =>
        JSON.parse(((await call(tools, 'sign_in', request)).content[0] as { text: string }).text);
      const first = await choice();
      assert.equal(first.outcome, 'choose_sign_in_method');
      assert.deepEqual(
        first.methods.map((item: { id: string }) => item.id),
        ['card', 'cmd'],
      );
      await call(tools, 'sign_in', { action: 'select_method', origin, methodId: 'cmd' });
      const second = await choice();
      assert.equal(second.outcome, 'choose_sign_in_method');
      assert.deepEqual(
        second.methods.map((item: { id: string }) => item.id),
        ['phone', 'qr'],
      );
      assert.equal(requests.length, 0);
      await call(tools, 'sign_in', { action: 'select_method', origin, methodId: 'phone' });
      assert.equal((await choice()).outcome, 'login_method_selected');
      await call(tools, 'sign_in', request);
      assert.equal(requests.length, 1);
      login = { ...login, fields: [], methods: [...outer, ...inner, next] };
      assert.equal((await choice()).outcome, 'login_method_selected');
      assert.equal(login.methods.find((item) => item.id === 'cmd')?.selected, true);
      assert.equal(requests.length, 1);
      assert.equal((await choice()).outcome, 'login_method_selected');
      await call(tools, 'sign_in', request);
    },
    {
      prompt: 'Use Chave Móvel Digital.',
      requestCredential: async (input) => {
        requests.push(input);
        return { filled: true };
      },
    },
    {
      computer: fakeComputer({
        inspectLogin: async () => login,
        selectLoginMethod: async (_thread, selectedOrigin, id) => {
          assert.equal(selectedOrigin, origin);
          selections.push(id);
          if (id === 'cmd')
            login = {
              ...login,
              methods: [
                ...outer.map((item) => ({ ...item, selected: item.id === id })),
                ...inner,
                next,
              ],
            };
          else if (id === 'continue')
            login = {
              ...login,
              fields: [
                { kind: 'identifier', label: 'Telemóvel', selector: '#phone' },
                { kind: 'password', label: 'PIN', selector: '#pin' },
              ],
              methods: [
                {
                  id: 'credentials',
                  label: 'Telemóvel e PIN',
                  kind: 'credentials',
                  supported: true,
                },
              ],
            };
        },
      }),
    },
  );
  assert.deepEqual(selections, ['cmd', 'continue', 'cmd', 'continue']);
  assert.equal(requests.length, 2);
  assert.equal((requests[0] as { origin: string }).origin, origin);
});

test('sign-in requests reject stale origins before selecting or using saved credentials', async () => {
  let requests = 0;
  await fixture(
    async (tools) => {
      await assert.rejects(
        call(tools, 'sign_in', {
          action: 'request',
          origin: 'https://other.example.test',
          label: 'Example',
          kind: 'password',
        }),
        /The action failed/,
      );
    },
    {
      requestCredential: async () => {
        requests++;
        return { filled: true };
      },
    },
  );
  assert.equal(requests, 0);
});

test('an OTP step uses the secure chat challenge instead of browser takeover', async () => {
  let requests = 0;
  const result = await fixture(
    async (tools) => {
      await call(tools, 'sign_in', {
        action: 'request',
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password',
        passwordSelector: '#otp',
      });
    },
    {
      requestCredential: async (input) => {
        requests++;
        assert.equal(input.kind, 'otp');
        return { invitation: { origin: input.origin, kind: 'otp' } };
      },
    },
    {
      computer: fakeComputer({
        inspectLogin: async () => ({
          origin: 'https://example.com',
          url: 'https://example.com/verify',
          fields: [{ kind: 'otp', selector: '#otp', label: 'Verification code' }],
          methods: [
            { id: 'credentials', kind: 'credentials', label: 'Verification code', supported: true },
          ],
        }),
      }),
    },
  );
  assert.equal(requests, 1);
  assert.equal(result.result.status, 'waiting_credentials');
  assert.equal(result.replies.length, 1);
});

test('visible OTP fields cannot bypass unresolved sign-in groups', async () => {
  let requests = 0;
  let selected = 'sms';
  const origin = 'https://example.com';
  const result = await fixture(
    async (tools) => {
      const request = { action: 'request', origin, label: 'Example', kind: 'otp' };
      const choice = await call(tools, 'sign_in', request);
      assert.equal(
        JSON.parse((choice.content[0] as { text: string }).text).outcome,
        'choose_sign_in_method',
      );
      assert.equal(requests, 0);
      await call(tools, 'sign_in', { action: 'select_method', origin, methodId: 'email' });
      await call(tools, 'sign_in', request);
    },
    {
      requestCredential: async (input) => {
        assert.equal(selected, 'email');
        assert.equal(input.kind, 'otp');
        requests++;
        return { invitation: { origin: input.origin, kind: 'otp' } };
      },
    },
    {
      computer: fakeComputer({
        inspectLogin: async () => ({
          origin,
          url: origin + '/verify',
          fields: [{ kind: 'otp', selector: '#otp', label: 'Verification code' }],
          methods: [
            { id: 'credentials', kind: 'credentials', label: 'Verification code', supported: true },
            ...['sms', 'email'].map((id) => ({
              id,
              kind: 'credentials' as const,
              group: 'Verification method',
              label: id,
              selector: `#${id}`,
              selected: selected === id,
              supported: true,
            })),
          ],
        }),
        selectLoginMethod: async (_thread, selectedOrigin, id) => {
          assert.equal(selectedOrigin, origin);
          selected = id;
        },
      }),
    },
  );
  assert.equal(requests, 1);
  assert.equal(result.result.status, 'waiting_credentials');
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
