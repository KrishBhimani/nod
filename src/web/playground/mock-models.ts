import type {
  ModelChoice,
  ModelConnection,
  ModelEffort,
  ModelMethod,
  ModelProvider,
  ModelSelection,
  ModelsResponse,
} from '../../shared/models';
import { modelSource } from '../../shared/models';

const thinking: ModelEffort[] = ['minimal', 'low', 'medium', 'high'];
const extended: ModelEffort[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
const plain: ModelEffort[] = ['off'];

function model(id: string, name: string, contextWindow: number, efforts = thinking, images = true) {
  return { id, name, efforts, images, contextWindow } satisfies ModelChoice;
}

export const catalogs = {
  openai: [
    model('gpt-6.1-sol', 'GPT-6.1 Sol', 400000),
    model('gpt-6-sol', 'GPT-6 Sol', 400000),
    model('gpt-6-luna', 'GPT-6 Luna', 400000),
    model('gpt-5.5', 'GPT-5.5', 272000),
    model('gpt-5.5-mini', 'GPT-5.5 mini', 272000),
  ],
  subscription: [
    model('gpt-6.1-sol', 'GPT-6.1 Sol', 272000),
    model('gpt-6-sol', 'GPT-6 Sol', 272000),
    model('gpt-6-luna', 'GPT-6 Luna', 272000),
  ],
  anthropic: [
    model('claude-opus-5-5', 'Claude Opus 5.5', 1000000, extended),
    model('claude-sonnet-5-5', 'Claude Sonnet 5.5', 1000000, extended),
    model('claude-fable-5-1', 'Claude Fable 5.1', 500000, extended),
    model('claude-haiku-5-5', 'Claude Haiku 5.5', 200000, extended),
    model('claude-haiku-4-5', 'Claude Haiku 4.5', 200000, extended),
  ],
  openrouter: [
    model('openai/gpt-6.1-sol', 'OpenAI: GPT-6.1 Sol', 400000),
    model('openai/gpt-6-luna', 'OpenAI: GPT-6 Luna', 400000),
    model('anthropic/claude-opus-5.5', 'Anthropic: Claude Opus 5.5', 1000000, extended),
    model('anthropic/claude-sonnet-5.5', 'Anthropic: Claude Sonnet 5.5', 1000000, extended),
    model('anthropic/claude-haiku-5.5', 'Anthropic: Claude Haiku 5.5', 200000, extended),
    model('google/gemini-3-pro', 'Google: Gemini 3 Pro', 2000000),
    model('google/gemini-3-flash', 'Google: Gemini 3 Flash', 1000000),
    model('x-ai/grok-5', 'xAI: Grok 5', 256000),
    model('deepseek/deepseek-v4', 'DeepSeek: DeepSeek V4', 160000),
    model('deepseek/deepseek-r3', 'DeepSeek: R3', 160000),
    model('qwen/qwen3.5-max', 'Qwen: Qwen3.5 Max', 256000),
    model('qwen/qwen3.5-coder', 'Qwen: Qwen3.5 Coder', 256000, plain, false),
    model('mistralai/mistral-large-3', 'Mistral: Mistral Large 3', 128000, plain),
    model('meta-llama/llama-5-maverick', 'Meta: Llama 5 Maverick', 1000000, plain),
    model('moonshotai/kimi-k3', 'MoonshotAI: Kimi K3', 256000, thinking, false),
  ],
  'amazon-bedrock': [
    model('anthropic.claude-opus-5-5', 'Claude Opus 5.5', 1000000, extended),
    model('anthropic.claude-sonnet-5-5', 'Claude Sonnet 5.5', 1000000, extended),
    model('amazon.nova-premier-v2', 'Nova Premier 2', 1000000, plain),
    model('meta.llama5-maverick', 'Llama 5 Maverick', 1000000, plain, false),
  ],
  'google-vertex': [
    model('gemini-3-pro', 'Gemini 3 Pro', 2000000),
    model('gemini-3-flash', 'Gemini 3 Flash', 1000000),
    model('gemini-3-flash-lite', 'Gemini 3 Flash-Lite', 1000000),
  ],
  azure: [
    model('gpt-6.1-sol', 'GPT-6.1 Sol', 400000),
    model('gpt-6-luna', 'GPT-6 Luna', 400000),
    model('gpt-5.5', 'GPT-5.5', 272000),
  ],
  compatible: [
    model('llama3.3:70b', 'llama3.3:70b', 131072, plain, false),
    model('qwen3:32b', 'qwen3:32b', 40960, thinking, false),
    model('gemma3:27b', 'gemma3:27b', 131072, plain),
  ],
} satisfies Record<ModelProvider | 'subscription', ModelChoice[]>;

export type Scenario =
  | 'empty'
  | 'chatgpt'
  | 'anthropic'
  | 'openrouter'
  | 'bedrock'
  | 'local'
  | 'many'
  | 'reconnect'
  | 'loading';

export const scenarios: Record<Scenario, string> = {
  empty: 'Nothing connected',
  chatgpt: 'ChatGPT plan',
  anthropic: 'Anthropic API key',
  openrouter: 'OpenRouter (many models)',
  bedrock: 'Bedrock, no model chosen',
  local: 'Local server',
  many: 'Many connections',
  reconnect: 'Needs reconnect',
  loading: 'Connected, models not loaded',
};

export type SignInOutcome = 'page' | 'approve' | 'fail' | 'hang';
export type NewConnection = 'connected' | 'loading' | 'empty';

export interface MockSettings {
  latency: number;
  failNext: string;
  signIn: SignInOutcome;
  newConnection: NewConnection;
  loadFails: boolean;
}

export interface MockState {
  connections: ModelConnection[];
  selection: ModelSelection | null;
}

let counter = 0;
function id() {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

function connection(
  provider: ModelProvider,
  method: ModelMethod,
  label: string,
  extra: Partial<ModelConnection> = {},
): ModelConnection {
  return {
    id: id(),
    provider,
    method,
    label,
    status: 'connected',
    models: method === 'subscription' ? catalogs.subscription : catalogs[provider],
    managed: false,
    ...extra,
  };
}

function select(
  source: ModelConnection | undefined,
  modelId = source?.models[0]?.id,
): ModelSelection | null {
  const choice = source?.models.find((item) => item.id === modelId);
  if (!source || !choice) return null;
  return {
    connectionId: source.id,
    modelId: choice.id,
    effort: choice.efforts.includes('high') ? 'high' : choice.efforts[0],
  };
}

const account = 'ada.lovelace@example.com';

export function scenarioState(scenario: Scenario): MockState {
  switch (scenario) {
    case 'empty':
      return { connections: [], selection: null };
    case 'chatgpt': {
      const source = connection('openai', 'subscription', account);
      return { connections: [source], selection: select(source, 'gpt-6.1-sol') };
    }
    case 'anthropic': {
      const source = connection(
        'anthropic',
        'api_key',
        modelSource({ provider: 'anthropic', method: 'api_key' }),
      );
      return { connections: [source], selection: select(source, 'claude-opus-5-5') };
    }
    case 'openrouter': {
      const source = connection('openrouter', 'oauth', 'OpenRouter');
      return { connections: [source], selection: select(source, 'openai/gpt-6.1-sol') };
    }
    case 'bedrock':
      return {
        connections: [connection('amazon-bedrock', 'api_key', 'eu-north-1')],
        selection: null,
      };
    case 'local': {
      const source = connection('compatible', 'api_key', 'localhost:11434');
      return { connections: [source], selection: select(source) };
    }
    case 'many': {
      const sources = [
        connection('openai', 'subscription', account),
        connection('openai', 'api_key', 'OpenAI API'),
        connection('anthropic', 'api_key', 'Anthropic API'),
        connection('openrouter', 'oauth', 'OpenRouter'),
        connection('google-vertex', 'api_key', 'Google Vertex AI'),
        connection('azure', 'api_key', 'prod-gpt-sol', { models: [catalogs.azure[0]] }),
        connection('compatible', 'api_key', 'localhost:11434'),
        connection('compatible', 'api_key', 'gpu-box.local:8000', { managed: true }),
      ];
      return { connections: sources, selection: select(sources[2], 'claude-opus-5-5') };
    }
    case 'reconnect': {
      const source = connection('openai', 'subscription', account, { status: 'reconnect' });
      return { connections: [source], selection: select(source, 'gpt-6.1-sol') };
    }
    case 'loading':
      return {
        connections: [
          connection('anthropic', 'api_key', 'Anthropic API', { status: 'loading', models: [] }),
        ],
        selection: null,
      };
  }
}

class Rejection extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type Attempt = {
  provider: 'openai' | 'openrouter';
  connectionId?: string;
  status: 'waiting' | 'connected' | 'failed';
  error?: string;
};

export function createMockBackend(initial: MockState, initialSettings: MockSettings) {
  let state = initial;
  let settings = initialSettings;
  const attempts = new Map<string, Attempt>();
  const listeners = new Set<() => void>();
  const channel = new BroadcastChannel('nod-playground');
  channel.onmessage = (event: MessageEvent<{ attempt: string; approved: boolean }>) =>
    finishAttempt(event.data.attempt, event.data.approved);

  function emit() {
    for (const listener of listeners) listener();
  }
  function view(): ModelsResponse {
    return structuredClone(state);
  }
  function arriving(provider: ModelProvider, method: ModelMethod) {
    const models = method === 'subscription' ? catalogs.subscription : catalogs[provider];
    if (settings.newConnection === 'loading') return { status: 'loading' as const, models: [] };
    if (settings.newConnection === 'empty')
      throw new Rejection('This connection has no supported models.');
    return { status: 'connected' as const, models };
  }
  function add(next: ModelConnection) {
    if (state.connections.length >= 20)
      throw new Rejection('Remove an unused model connection before adding another.');
    state = { ...state, connections: [...state.connections, next] };
  }
  function finishAttempt(attemptId: string, approved: boolean) {
    const attempt = attempts.get(attemptId);
    if (!attempt || attempt.status !== 'waiting') return;
    if (!approved) {
      attempt.status = 'failed';
      attempt.error = 'Sign-in was cancelled. Start a new connection.';
      emit();
      return;
    }
    const method: ModelMethod = attempt.provider === 'openai' ? 'subscription' : 'oauth';
    const label = attempt.provider === 'openai' ? account : 'OpenRouter';
    const previous = state.connections.find((item) => item.id === attempt.connectionId);
    if (previous)
      state = {
        ...state,
        connections: state.connections.map((item) =>
          item.id === previous.id ? { ...item, ...arriving(item.provider, item.method) } : item,
        ),
      };
    else
      add({
        id: id(),
        provider: attempt.provider,
        method,
        label,
        managed: false,
        ...arriving(attempt.provider, method),
      });
    attempt.status = 'connected';
    emit();
  }

  async function handle(method: string, path: string, body: Record<string, unknown>) {
    if (method === 'GET' && path === '/api/models') return view();
    if (method === 'GET' && path === '/api/models/azure')
      return { models: catalogs.azure.map(({ id, name }) => ({ id, name })) };
    if (method === 'POST' && path === '/api/models/keys') {
      const provider = body.provider as ModelProvider;
      const key = String(body.key ?? '');
      if (key.includes('bad')) throw new Rejection('The provider rejected this API key.');
      const label =
        provider === 'amazon-bedrock'
          ? String(body.region)
          : provider === 'azure'
            ? String(body.deployment)
            : modelSource({ provider, method: 'api_key' });
      const models =
        provider === 'azure' ? catalogs.azure.filter((item) => item.id === body.model) : undefined;
      const arrived = arriving(provider, 'api_key');
      add({
        id: id(),
        provider,
        method: 'api_key',
        label,
        managed: false,
        ...arrived,
        ...(models && arrived.status === 'connected' ? { models } : {}),
      });
      return view();
    }
    if (method === 'POST' && path === '/api/models/endpoints') {
      const url = URL.parse(String(body.url ?? ''));
      if (!url || String(body.url).includes('bad'))
        throw new Rejection('The server didn’t answer. Check the address and that it is running.');
      add({
        id: id(),
        provider: 'compatible',
        method: 'api_key',
        label: url.host,
        managed: false,
        ...arriving('compatible', 'api_key'),
      });
      return view();
    }
    if (method === 'PUT' && path === '/api/models/selection') {
      const next = body as unknown as ModelSelection;
      const source = state.connections.find((item) => item.id === next.connectionId);
      const choice = source?.models.find((item) => item.id === next.modelId);
      if (!source || source.status !== 'connected' || !choice?.efforts.includes(next.effort))
        throw new Rejection('That model isn’t available. Choose another model.');
      state = { ...state, selection: next };
      return view();
    }
    const refresh = path.match(/^\/api\/models\/connections\/([^/]+)\/refresh$/);
    if (method === 'POST' && refresh) {
      if (settings.loadFails)
        throw new Rejection('The service didn’t return any models. Try again.');
      state = {
        ...state,
        connections: state.connections.map((item) =>
          item.id === refresh[1]
            ? {
                ...item,
                status: 'connected',
                models:
                  item.method === 'subscription' ? catalogs.subscription : catalogs[item.provider],
              }
            : item,
        ),
      };
      return view();
    }
    const remove = path.match(/^\/api\/models\/connections\/([^/]+)$/);
    if (method === 'DELETE' && remove) {
      state = {
        connections: state.connections.filter((item) => item.id !== remove[1]),
        selection: state.selection?.connectionId === remove[1] ? null : state.selection,
      };
      return view();
    }
    if (method === 'POST' && path === '/api/models/oauth') {
      const attemptId = crypto.randomUUID().replaceAll('-', '');
      attempts.set(attemptId, {
        provider: body.provider as Attempt['provider'],
        connectionId: body.connectionId as string | undefined,
        status: 'waiting',
      });
      if (settings.signIn === 'approve') setTimeout(() => finishAttempt(attemptId, true), 1500);
      if (settings.signIn === 'fail') setTimeout(() => finishAttempt(attemptId, false), 1500);
      return {
        attempt: attemptId,
        url: `${window.location.origin}${window.location.pathname}?signin=${attemptId}&provider=${String(body.provider)}`,
      };
    }
    const status = path.match(/^\/api\/models\/oauth\/status\/([^/]+)$/);
    if (method === 'GET' && status) {
      const attempt = attempts.get(status[1]);
      if (!attempt) throw new Rejection('Sign-in expired. Start a new connection.');
      return { status: attempt.status, ...(attempt.error ? { error: attempt.error } : {}) };
    }
    if (method === 'POST' && path === '/api/models/oauth/complete') {
      const waiting = [...attempts.entries()].find(([, attempt]) => attempt.status === 'waiting');
      if (!waiting || !String(body.url).includes('code='))
        throw new Rejection('That address doesn’t finish a sign-in. Start a new connection.');
      finishAttempt(waiting[0], true);
      return view();
    }
    const cancel = path.match(/^\/api\/models\/oauth\/([^/]+)$/);
    if (method === 'DELETE' && cancel) {
      attempts.delete(cancel[1]);
      return view();
    }
    throw new Rejection('The playground doesn’t fake this request.', 404);
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/'))
      return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const polling = url.pathname.startsWith('/api/models/oauth/status/');
    if (settings.latency && !polling)
      await new Promise((done) => setTimeout(done, settings.latency));
    init?.signal?.throwIfAborted();
    const respond = (status: number, value: unknown) => {
      if (method !== 'GET' || url.pathname !== '/api/models') emit();
      return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    if (settings.failNext && method !== 'GET') {
      const error = settings.failNext;
      settings = { ...settings, failNext: '' };
      return respond(400, { error });
    }
    try {
      return respond(200, await handle(method, url.pathname, body));
    } catch (cause) {
      return cause instanceof Rejection
        ? respond(cause.status, { error: cause.message })
        : respond(500, { error: 'The playground request failed.' });
    }
  };

  return {
    state: () => state,
    settings: () => settings,
    reset(next: MockState) {
      state = next;
      attempts.clear();
      emit();
    },
    configure(change: Partial<MockSettings>) {
      settings = { ...settings, ...change };
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
