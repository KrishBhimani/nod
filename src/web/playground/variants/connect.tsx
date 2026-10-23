import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, LoaderCircle } from '../../components/icons';
import type { ModelConnection, ModelProvider, ModelsResponse } from '../../../shared/models';
import { modelProviderNames, modelSource } from '../../../shared/models';
import { agentModels } from '../../../shared/model-defaults';
import { Button, Input } from '../../components/ui';
import { CloudKeyFields, ModelPicker } from '../../components/models';
import {
  keyConnection,
  keySettingsReady,
  localServerAddress,
  modelReady,
  modelSelection,
  noKeySettings,
  useModelSignIn,
  useModels,
  type KeySettings,
} from '../../hooks/use-models';
import { api, ApiError, errorMessage } from '../../lib/api';
import { pageDataCache } from '../../lib/page-data-cache';
import { Rise } from '../../components/motion';
import {
  Bubble,
  Footer,
  Messages,
  useReveal,
  type RevealStep,
} from '../../pages/onboarding/motion';

export const keyLinks: Record<ModelProvider, string> = {
  openai: 'platform.openai.com/api-keys',
  anthropic: 'console.anthropic.com/settings/keys',
  openrouter: 'openrouter.ai/keys',
  'amazon-bedrock': 'console.aws.amazon.com/bedrock',
  'google-vertex': 'console.cloud.google.com/apis/credentials',
  azure: 'ai.azure.com',
  compatible: '',
};

export const keyPlaceholders: Partial<Record<ModelProvider, string>> = {
  openai: 'sk-…',
  anthropic: 'sk-ant-…',
  openrouter: 'sk-or-…',
  'google-vertex': 'AIza…',
  'amazon-bedrock': 'ABSK…',
};

const invalidKey = 'That key didn’t work. Check it and try again.';

export function detectKey(key: string): ModelProvider | undefined {
  const value = key.trim();
  if (value.startsWith('sk-ant-')) return 'anthropic';
  if (value.startsWith('sk-or-')) return 'openrouter';
  if (value.startsWith('sk-')) return 'openai';
  if (value.startsWith('AIza')) return 'google-vertex';
  if (value.startsWith('ABSK')) return 'amazon-bedrock';
  return undefined;
}

function noDefault(source: ModelConnection) {
  return (
    (source.provider === 'amazon-bedrock' || source.provider === 'google-vertex') &&
    source.models.length > 1
  );
}

export function ownerChooses(source: ModelConnection) {
  return noDefault(source) || (source.provider === 'compatible' && source.models.length > 1);
}

function recommended(source: ModelConnection) {
  return (
    (source.method === 'subscription' && source.models.find((item) => item.id === 'gpt-6-sol')) ||
    source.models.find((item) => item.id === agentModels[source.provider]) ||
    (noDefault(source) ? undefined : source.models[0])
  );
}

export function useConnect() {
  const models = useModels();
  const [fresh, setFresh] = useState<string>();
  const [another, setAnother] = useState(false);
  const flow = useModelSignIn(models, (provider) => {
    const latest = pageDataCache
      .getSnapshot<ModelsResponse>('/api/models')
      .data?.connections.filter((item) => item.provider === provider)
      .at(-1);
    setAnother(false);
    setFresh(latest?.id);
  });
  const [checking, setChecking] = useState(false);
  const [keyError, setKeyError] = useState('');
  const submitting = useRef(false);
  const data = models.data;
  const connections = data?.connections ?? [];
  const selected = connections.find((item) => item.id === data?.selection?.connectionId);
  const usable = connections.filter((item) => item.status !== 'reconnect');
  const shown = another
    ? undefined
    : (usable.find((item) => item.id === fresh) ??
      usable.find((item) => item.id === selected?.id) ??
      usable[0]);
  const ready = modelReady(data) && selected?.id === shown?.id;
  const recommendation = shown?.status === 'connected' ? recommended(shown) : undefined;
  const signingIn = !!flow.signIn || flow.pending;
  const locked = models.busy || checking || flow.pending;

  useEffect(() => {
    if (!shown || !recommendation || ready || models.busy || models.error || signingIn || checking)
      return;
    void models.change('/api/models/selection', 'PUT', modelSelection(shown, recommendation.id));
  }, [shown, recommendation, ready, models.busy, models.error, signingIn, checking]);

  async function save(
    provider: ModelProvider,
    key: string,
    settings: KeySettings = noKeySettings,
    url = '',
  ) {
    if (submitting.current) return false;
    const value = key.trim();
    const endpoint = provider === 'compatible';
    const detailed = endpoint || provider === 'amazon-bedrock' || provider === 'azure';
    if (endpoint && !url.trim()) return (setKeyError('Enter the server address first.'), false);
    if (!keySettingsReady(provider, settings))
      return (setKeyError('Fill in every field first.'), false);
    if (!endpoint && !value) return (setKeyError('Paste your API key first.'), false);
    if (!endpoint && value.length < 8) return (setKeyError(invalidKey), false);
    setKeyError('');
    models.setError('');
    submitting.current = true;
    setChecking(true);
    try {
      const result = await api<ModelsResponse>(
        endpoint ? '/api/models/endpoints' : '/api/models/keys',
        {
          method: 'POST',
          body: JSON.stringify(
            endpoint ? { url: url.trim(), key: value } : keyConnection(provider, value, settings),
          ),
        },
      );
      models.update(() => result);
      setAnother(false);
      setFresh(result.connections.at(-1)?.id);
      return true;
    } catch (cause) {
      setKeyError(
        cause instanceof ApiError && cause.status === 400 && !detailed
          ? invalidKey
          : errorMessage(cause),
      );
      return false;
    } finally {
      submitting.current = false;
      setChecking(false);
    }
  }

  function signIn(provider: 'openai' | 'openrouter') {
    setKeyError('');
    void flow.connect(provider);
  }

  return {
    models,
    flow,
    data,
    shown,
    ready,
    recommendation,
    signingIn,
    locked,
    checking,
    keyError,
    clearError: () => {
      setKeyError('');
      models.setError('');
    },
    save,
    signIn,
    expired: connections.filter((item) => item.status === 'reconnect'),
    addAnother: () => {
      models.setError('');
      setAnother(true);
    },
    cancelAnother: usable.length ? () => setAnother(false) : undefined,
  };
}

export type Connect = ReturnType<typeof useConnect>;

export function Logo({ provider, size }: { provider: ModelProvider; size?: number }) {
  return (
    <span
      className={`ob-brain-logo ${provider}`}
      style={size ? { width: size, height: size } : undefined}
      aria-hidden="true"
    />
  );
}

export function Problem({ children }: { children?: string }) {
  return children ? (
    <p className="ob-brain-error" role="alert">
      {children}
    </p>
  ) : null;
}

export function Waiting({ c }: { c: Connect }) {
  const [callback, setCallback] = useState('');
  return (
    <div className="ob-brain-status">
      <span className="ob-brain-icon">
        <LoaderCircle size={18} className="spin" aria-hidden="true" />
      </span>
      <p className="ob-brain-wait">Finish signing in, then come back here.</p>
      <Button
        variant="ghost"
        size="sm"
        disabled={c.flow.pending}
        onClick={() => void c.flow.cancel().then((done) => done && setCallback(''))}
      >
        Cancel
      </Button>
      {c.flow.signIn && (
        <details className="ob-brain-fallback">
          <summary>Sign-in page didn’t open?</summary>
          <p>
            <button type="button" className="ob-link" onClick={c.flow.reopen}>
              Open it again
            </button>{' '}
            or paste the address your browser ended up on.
          </p>
          <form
            className="ob-brain-row"
            onSubmit={(event) => {
              event.preventDefault();
              const url = callback;
              setCallback('');
              void c.flow.complete(url);
            }}
          >
            <Input
              type="url"
              required
              autoComplete="off"
              placeholder="Paste the address here"
              aria-label="Sign-in address"
              value={callback}
              disabled={c.models.busy}
              onChange={(event) => setCallback(event.target.value)}
            />
            <Button type="submit" variant="outline" disabled={c.models.busy}>
              Finish
            </Button>
          </form>
        </details>
      )}
      <Problem>{c.models.error}</Problem>
    </div>
  );
}

export function Connected({ c }: { c: Connect }) {
  const shown = c.shown!;
  const choosing = shown.status === 'connected' && !c.ready && ownerChooses(shown);
  const missing = shown.status === 'connected' && !c.ready && !c.recommendation && !choosing;
  return (
    <div className="pgv-connected">
      <div className="ob-brain-status">
        <span className="ob-brain-icon ob-brain-done" aria-hidden="true">
          <Check size={18} strokeWidth={2.5} />
        </span>
        <div className="ob-brain-status-text">
          <p className="ob-brain-title">
            Connected to {shown.provider === 'compatible' ? shown.label : modelSource(shown)}
          </p>
          <p className="ob-brain-note">
            {shown.status === 'loading'
              ? 'Load the models for this account to continue.'
              : choosing
                ? 'Choose the model I should use.'
                : missing
                  ? 'The default model isn’t available for this account.'
                  : 'I’ll use this model for every reply. You can change it any time.'}
          </p>
        </div>
      </div>
      {shown.status === 'connected' && (c.ready || choosing) && (
        <div className="pgv-model">
          <span className="pgv-model-label">{choosing ? 'Model' : 'Using'}</span>
          <ModelPicker manageConnections={false} surface="onboarding" />
        </div>
      )}
      {(shown.status === 'loading' || missing || c.models.error) && (
        <Button
          variant="outline"
          disabled={c.models.busy}
          onClick={() =>
            void c.models.change(`/api/models/connections/${shown.id}/refresh`, 'POST')
          }
        >
          {c.models.busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
          Load models
        </Button>
      )}
      <Problem>{c.models.error}</Problem>
      <button type="button" className="ob-link pgv-another" onClick={c.addAnother}>
        Use a different provider
      </button>
    </div>
  );
}

export function KeyForm({
  c,
  provider,
  autoFocus,
  label = true,
  compact,
}: {
  c: Connect;
  provider: ModelProvider;
  autoFocus?: boolean;
  label?: boolean;
  compact?: boolean;
}) {
  const [key, setKey] = useState('');
  const [settings, setSettings] = useState<KeySettings>(noKeySettings);
  const id = `pgv-key-${provider}`;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await c.save(provider, key, settings)) {
      setKey('');
      setSettings(noKeySettings);
    }
  }
  return (
    <form className="ob-brain-form" onSubmit={(event) => void submit(event)} noValidate>
      <CloudKeyFields
        provider={provider}
        value={settings}
        onChange={(next) => {
          setSettings(next);
          c.clearError();
        }}
        disabled={c.checking}
      />
      {label && (
        <label className="ob-brain-label" htmlFor={id}>
          {compact ? 'API key' : `${modelProviderNames[provider]} API key`}
        </label>
      )}
      <div className="ob-brain-row">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={32000}
          placeholder={keyPlaceholders[provider]}
          aria-label={label ? undefined : `${modelProviderNames[provider]} API key`}
          autoFocus={autoFocus && provider !== 'amazon-bedrock' && provider !== 'azure'}
          value={key}
          disabled={c.checking}
          aria-invalid={!!c.keyError}
          onChange={(event) => {
            setKey(event.target.value);
            c.clearError();
          }}
        />
        <ConnectButton c={c} />
      </div>
      <Problem>{c.keyError}</Problem>
      {compact ? (
        <p className="ob-brain-note pgv-key-note">
          Get a key at{' '}
          <a href={`https://${keyLinks[provider]}`} target="_blank" rel="noreferrer">
            {keyLinks[provider].split('/')[0]}
          </a>{' '}
          · Encrypted on this computer. Never shown to the AI.
        </p>
      ) : (
        <p className="ob-brain-note">
          Get one at{' '}
          <a href={`https://${keyLinks[provider]}`} target="_blank" rel="noreferrer">
            {keyLinks[provider]}
          </a>
          . It’s encrypted, stays on this computer and is never shown to the AI.
        </p>
      )}
    </form>
  );
}

export function ServerForm({
  c,
  autoFocus,
  compact,
}: {
  c: Connect;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const [url, setUrl] = useState(localServerAddress);
  const [key, setKey] = useState('');
  return (
    <form
      className="ob-brain-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void c.save('compatible', key, noKeySettings, url).then((saved) => saved && setKey(''));
      }}
    >
      <label className="ob-brain-label" htmlFor="pgv-url">
        Server address
      </label>
      <Input
        id="pgv-url"
        type="url"
        autoComplete="off"
        spellCheck={false}
        maxLength={2000}
        placeholder={localServerAddress}
        autoFocus={autoFocus}
        value={url}
        disabled={c.checking}
        aria-invalid={!!c.keyError}
        aria-describedby={compact ? 'pgv-url-hint' : undefined}
        onChange={(event) => {
          setUrl(event.target.value);
          c.clearError();
        }}
      />
      {compact && (
        <p className="ob-brain-note pgv-server-hint" id="pgv-url-hint">
          Ollama, LM Studio, vLLM or any OpenAI-compatible server.
        </p>
      )}
      <label className="ob-brain-label" htmlFor="pgv-server-key">
        API key <span className="ob-brain-optional">optional</span>
      </label>
      <div className="ob-brain-row">
        <Input
          id="pgv-server-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={32000}
          value={key}
          disabled={c.checking}
          onChange={(event) => {
            setKey(event.target.value);
            c.clearError();
          }}
        />
        <ConnectButton c={c} />
      </div>
      <Problem>{c.keyError}</Problem>
      {compact ? (
        <p className="ob-brain-note">
          This model also decides when I ask before acting. Small models can get that wrong.
        </p>
      ) : (
        <p className="ob-brain-note">
          Ollama, LM Studio, vLLM or any OpenAI-compatible server. I also use this model to decide
          when to ask you before acting, and smaller models decide less reliably.
        </p>
      )}
    </form>
  );
}

export function SignInButton({
  c,
  provider,
  primary,
}: {
  c: Connect;
  provider: 'openai' | 'openrouter';
  primary?: boolean;
}) {
  return (
    <Button
      variant={primary ? 'default' : 'outline'}
      disabled={c.locked}
      onClick={() => c.signIn(provider)}
      className="pgv-sign-in"
    >
      <Logo provider={provider} />
      {provider === 'openai' ? 'Sign in with ChatGPT' : 'Sign in to OpenRouter'}
    </Button>
  );
}

function ConnectButton({ c }: { c: Connect }) {
  return (
    <Button type="submit" variant="outline" disabled={c.checking}>
      {c.checking && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
      {c.checking ? 'Checking' : 'Connect'}
    </Button>
  );
}

const keyProviders: ModelProvider[] = [
  'openai',
  'anthropic',
  'openrouter',
  'google-vertex',
  'amazon-bedrock',
  'azure',
];

export function SmartKey({ c, autoFocus }: { c: Connect; autoFocus?: boolean }) {
  const [key, setKey] = useState('');
  const [override, setOverride] = useState<ModelProvider>();
  const [changing, setChanging] = useState(false);
  const [settings, setSettings] = useState<KeySettings>(noKeySettings);
  const detected = detectKey(key);
  const provider = override ?? detected;
  const typed = key.trim().length >= 4;
  return (
    <form
      className="ob-brain-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!provider) return;
        void c.save(provider, key, settings).then((saved) => {
          if (!saved) return;
          setKey('');
          setOverride(undefined);
          setSettings(noKeySettings);
        });
      }}
    >
      <div className="ob-brain-row">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={32000}
          placeholder="Paste an API key"
          aria-label="API key"
          autoFocus={autoFocus}
          value={key}
          disabled={c.checking}
          aria-invalid={!!c.keyError}
          onChange={(event) => {
            setKey(event.target.value);
            c.clearError();
          }}
        />
        <Button type="submit" variant="outline" disabled={c.checking || !provider || !typed}>
          {c.checking && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
          {c.checking ? 'Checking' : 'Connect'}
        </Button>
      </div>
      {typed &&
        (provider && !changing ? (
          <p className="pgv-detected">
            <Logo provider={provider} />
            <span>
              {modelProviderNames[provider]} key{override ? '' : ' detected'}
            </span>
            <button type="button" className="ob-link" onClick={() => setChanging(true)}>
              Change
            </button>
          </p>
        ) : (
          <label className="pgv-which">
            <span>Which service is this key for?</span>
            <select
              className="input"
              value={provider ?? ''}
              onChange={(event) => {
                setOverride(event.target.value as ModelProvider);
                setSettings(noKeySettings);
                setChanging(false);
              }}
            >
              <option value="" disabled>
                Choose a service
              </option>
              {keyProviders.map((item) => (
                <option key={item} value={item}>
                  {modelProviderNames[item]}
                </option>
              ))}
            </select>
          </label>
        ))}
      {provider && key.trim().length >= 16 && (
        <CloudKeyFields
          provider={provider}
          value={settings}
          onChange={(next) => {
            setSettings(next);
            c.clearError();
          }}
          disabled={c.checking}
        />
      )}
      <Problem>{c.keyError}</Problem>
      <p className="ob-brain-note">
        It’s encrypted, stays on this computer and is never shown to the AI.
      </p>
      <details className="ob-brain-fallback">
        <summary>Where do I get one?</summary>
        <ul className="pgv-links">
          {keyProviders.map((item) => (
            <li key={item}>
              {modelProviderNames[item]}:{' '}
              <a href={`https://${keyLinks[item]}`} target="_blank" rel="noreferrer">
                {keyLinks[item]}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </form>
  );
}

const typed: RevealStep[] = [{ typing: 450 }, { wait: 300, typing: 550 }];

export function Step({
  c,
  intro,
  messages,
  onNext,
  onBack,
  children,
}: {
  c: Connect;
  intro: boolean;
  messages: ReactNode[];
  onNext(): void;
  onBack(): void;
  children: ReactNode;
}) {
  const sequence = [...typed.slice(0, messages.length), { wait: 200 }, { wait: 300 }];
  const { revealed, typing, done, skip } = useReveal(sequence, { enabled: intro });
  return (
    <section className="ob-step ob-brain pgv" onClick={done ? undefined : skip}>
      <Messages
        revealed={revealed}
        typing={typing}
        className="ob-brain-messages"
        items={messages.map((message, index) => (
          <Bubble key={index}>{message}</Bubble>
        ))}
      />
      <Rise show={revealed > messages.length} className="pgv-body">
        {!c.data ? (
          <div className="ob-brain-status">
            <span className="ob-brain-icon">
              <LoaderCircle size={18} className="spin" aria-hidden="true" />
            </span>
            <p className="ob-brain-wait">{c.models.error || 'Loading…'}</p>
          </div>
        ) : (
          children
        )}
      </Rise>
      <Footer
        show={revealed > messages.length + 1}
        onBack={c.cancelAnother && !c.shown ? c.cancelAnother : onBack}
        backLabel={c.cancelAnother && !c.shown ? 'Keep current' : 'Back'}
        onNext={onNext}
        nextDisabled={!c.ready || c.models.busy || c.checking || c.signingIn}
      />
    </section>
  );
}

export function ExpiredNotice({ c }: { c: Connect }) {
  const expired = c.expired[0];
  if (!expired) return null;
  return (
    <p className="pgv-expired">
      Your {modelSource(expired)} sign-in for {expired.label} expired. Sign in again to keep using
      it.
    </p>
  );
}
