import { useEffect, useState, useSyncExternalStore } from 'react';
import { Moon, RotateCcw, Sun } from 'lucide-react';
import { modelProviderNames, modelSource } from '../../shared/models';
import { ModelPicker, ModelSettings } from '../components/models';
import { Button } from '../components/ui';
import { pageDataCache } from '../lib/page-data-cache';
import { currentTheme, setTheme, subscribeTheme } from '../lib/theme';
import { OnboardingFrame } from '../pages/onboarding/frame';
import { Brain } from '../pages/onboarding/steps/brain';
import {
  createMockBackend,
  scenarioState,
  scenarios,
  type MockSettings,
  type NewConnection,
  type Scenario,
  type SignInOutcome,
} from './mock-models';
import {
  optionLabels,
  optionRequires,
  variants,
  type Variant,
  type VariantOption,
} from './variants';

const defaults: MockSettings = {
  latency: 600,
  failNext: '',
  signIn: 'approve',
  newConnection: 'connected',
  loadFails: false,
};

const stored = (() => {
  try {
    return JSON.parse(localStorage.getItem('nod.playground') ?? '{}') as Partial<{
      scenario: Scenario;
      view: View;
      variant: Variant;
      options: Partial<Record<VariantOption, boolean>>;
      width: Width;
      settings: MockSettings;
    }>;
  } catch {
    return {};
  }
})();

const backend = createMockBackend(scenarioState(stored.scenario ?? 'empty'), {
  ...defaults,
  ...stored.settings,
  failNext: '',
});

type View = 'onboarding' | 'picker' | 'settings';
type Width = 'fluid' | 'tablet' | 'phone';

const views: Record<View, string> = {
  onboarding: 'Onboarding step',
  picker: 'Picker',
  settings: 'Settings panel',
};

const widths: Record<Width, string> = { fluid: 'Fluid', tablet: '768', phone: '375' };

const signIns: Record<SignInOutcome, string> = {
  approve: 'Succeed after 2 s',
  fail: 'Fail after 2 s',
  page: 'Fake sign-in page',
  hang: 'Never finishes',
};

const arrivals: Record<NewConnection, string> = {
  connected: 'Models load',
  loading: 'Models still loading',
  empty: 'No supported models',
};

function save(change: Record<string, unknown>) {
  try {
    const current = JSON.parse(localStorage.getItem('nod.playground') ?? '{}');
    localStorage.setItem('nod.playground', JSON.stringify({ ...current, ...change }));
  } catch {}
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Record<T, string>;
  onChange(value: T): void;
}) {
  return (
    <label className="pg-field">
      <span>{label}</span>
      <select
        className="input"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {(Object.keys(options) as T[]).map((key) => (
          <option key={key} value={key}>
            {options[key]}
          </option>
        ))}
      </select>
    </label>
  );
}

function Segments<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Record<T, string>;
  onChange(value: T): void;
  label: string;
}) {
  return (
    <div className="pg-segments" role="radiogroup" aria-label={label}>
      {(Object.keys(options) as T[]).map((key) => (
        <button
          type="button"
          key={key}
          role="radio"
          aria-checked={value === key}
          onClick={() => onChange(key)}
        >
          {options[key]}
        </button>
      ))}
    </div>
  );
}

export function FakeSignIn({ attempt, provider }: { attempt: string; provider: string }) {
  const [sent, setSent] = useState('');
  function finish(approved: boolean) {
    new BroadcastChannel('nod-playground').postMessage({ attempt, approved });
    setSent(approved ? 'Approved. You can close this tab.' : 'Denied. You can close this tab.');
    setTimeout(() => window.close(), 600);
  }
  const name = provider === 'openai' ? 'ChatGPT' : 'OpenRouter';
  return (
    <main className="pg-signin">
      <h1>Fake {name} sign-in</h1>
      <p>This stands in for the provider’s page. Nothing leaves your computer.</p>
      {sent ? (
        <p>{sent}</p>
      ) : (
        <div className="pg-signin-actions">
          <Button onClick={() => finish(true)}>Approve</Button>
          <Button variant="outline" onClick={() => finish(false)}>
            Deny
          </Button>
        </div>
      )}
    </main>
  );
}

export function Playground() {
  const state = useSyncExternalStore(backend.subscribe, backend.state);
  const settings = useSyncExternalStore(backend.subscribe, backend.settings);
  const theme = useSyncExternalStore(subscribeTheme, currentTheme);
  const [scenario, setScenario] = useState<Scenario>(stored.scenario ?? 'empty');
  const [view, setView] = useState<View>(stored.view ?? 'onboarding');
  const [width, setWidth] = useState<Width>(stored.width ?? 'fluid');
  const [variant, setVariant] = useState<Variant>(stored.variant ?? 'current');
  const [intro, setIntro] = useState(true);
  const [options, setOptions] = useState(stored.options ?? {});
  const [mount, setMount] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [failure, setFailure] = useState(
    'The model connection request failed. Check the service and try again.',
  );

  function remount() {
    void pageDataCache.refresh('/api/models', true);
    setMount((value) => value + 1);
  }
  function load(next: Scenario) {
    setScenario(next);
    save({ scenario: next });
    backend.reset(scenarioState(next));
    remount();
  }
  function configure(change: Partial<MockSettings>) {
    backend.configure(change);
    save({ settings: { ...backend.settings(), failNext: '' } });
  }
  function design(next: Variant) {
    setVariant(next);
    setView('onboarding');
    save({ variant: next, view: 'onboarding' });
  }
  useEffect(() => {
    const keys = Object.keys(variants) as Variant[];
    const press = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target.closest('input, textarea, select')
      )
        return;
      const next = keys[Number(event.key) - 1];
      if (next) design(next);
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, []);
  function note(text: string) {
    setLog((items) => [`${new Date().toLocaleTimeString()} · ${text}`, ...items].slice(0, 6));
  }
  const selected = state.connections.find((item) => item.id === state.selection?.connectionId);
  const chosen = selected?.models.find((item) => item.id === state.selection?.modelId);

  return (
    <div className="pg">
      <aside className="pg-panel">
        <header className="pg-panel-header">
          <strong>Model selection playground</strong>
          <Button
            variant="ghost"
            size="icon"
            aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
            onClick={() => void setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
        </header>

        <section className="pg-group">
          <h2>Design</h2>
          <div className="pg-variants" role="radiogroup" aria-label="Design">
            {(Object.keys(variants) as Variant[]).map((key, index) => (
              <button
                type="button"
                key={key}
                role="radio"
                aria-checked={view === 'onboarding' && variant === key}
                onClick={() => design(key)}
              >
                <span>{variants[key].name}</span>
                <kbd>{index + 1}</kbd>
              </button>
            ))}
          </div>
          <p className="pg-hint">{variants[variant].idea}</p>
          {variants[variant].options
            ?.filter((option) => !optionRequires[option] || options[optionRequires[option]!])
            .map((option) => (
              <label className="pg-check" key={option}>
                <input
                  type="checkbox"
                  checked={!!options[option]}
                  onChange={(event) => {
                    const next = { ...options, [option]: event.target.checked };
                    setOptions(next);
                    save({ options: next });
                  }}
                />
                {optionLabels[option]}
              </label>
            ))}
        </section>

        <section className="pg-group">
          <h2>Starting state</h2>
          <Choice label="Scenario" value={scenario} options={scenarios} onChange={load} />
          <Button variant="outline" size="sm" onClick={() => load(scenario)}>
            <RotateCcw size={14} />
            Reset to this state
          </Button>
        </section>

        <section className="pg-group">
          <h2>Fake service</h2>
          <label className="pg-field">
            <span>Latency · {settings.latency} ms</span>
            <input
              type="range"
              min={0}
              max={3000}
              step={100}
              value={settings.latency}
              onChange={(event) => configure({ latency: Number(event.target.value) })}
            />
          </label>
          <Choice
            label="ChatGPT / OpenRouter sign-in"
            value={settings.signIn}
            options={signIns}
            onChange={(signIn) => configure({ signIn })}
          />
          <Choice
            label="A new connection"
            value={settings.newConnection}
            options={arrivals}
            onChange={(newConnection) => configure({ newConnection })}
          />
          <label className="pg-check">
            <input
              type="checkbox"
              checked={settings.loadFails}
              onChange={(event) => configure({ loadFails: event.target.checked })}
            />
            Refreshing models fails
          </label>
          <label className="pg-field">
            <span>Fail the next change with</span>
            <textarea
              className="input"
              rows={2}
              value={failure}
              onChange={(event) => setFailure(event.target.value)}
            />
          </label>
          <Button
            variant={settings.failNext ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => configure({ failNext: settings.failNext ? '' : failure })}
          >
            {settings.failNext ? 'Armed · click to disarm' : 'Arm failure'}
          </Button>
          <p className="pg-hint">
            Any key works. A key or server address containing “bad” is rejected. A pasted sign-in
            address needs “code=” in it.
          </p>
        </section>

        <section className="pg-group">
          <h2>Saved now</h2>
          <dl className="pg-state">
            <dt>Model</dt>
            <dd>{chosen ? `${chosen.name} · ${state.selection!.effort}` : 'None'}</dd>
            <dt>From</dt>
            <dd>{selected ? `${modelSource(selected)} · ${selected.label}` : '—'}</dd>
            <dt>Connections</dt>
            <dd>
              {state.connections.length
                ? state.connections
                    .map(
                      (item) =>
                        `${modelProviderNames[item.provider]}${item.status === 'connected' ? '' : ` (${item.status})`}`,
                    )
                    .join(', ')
                : 'None'}
            </dd>
          </dl>
          {log.length > 0 && (
            <ol className="pg-log">
              {log.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ol>
          )}
        </section>
      </aside>

      <div className="pg-stage">
        <div className="pg-toolbar">
          <Segments
            label="Component"
            value={view}
            options={views}
            onChange={(next) => {
              setView(next);
              save({ view: next });
            }}
          />
          <div className="pg-toolbar-end">
            {view === 'onboarding' && (
              <label className="pg-check">
                <input
                  type="checkbox"
                  checked={intro}
                  onChange={(event) => setIntro(event.target.checked)}
                />
                Play intro
              </label>
            )}
            <Button variant="ghost" size="sm" onClick={remount}>
              <RotateCcw size={14} />
              Remount
            </Button>
            <Segments
              label="Width"
              value={width}
              options={widths}
              onChange={(next) => {
                setWidth(next);
                save({ width: next });
              }}
            />
          </div>
        </div>
        <div className="pg-viewport">
          <div
            className="pg-device"
            data-width={width}
            key={`${view}:${variant}:${mount}:${intro}`}
          >
            {view === 'onboarding' && (
              <OnboardingFrame step="brain">
                {(() => {
                  const Design = variants[variant].component;
                  const props = {
                    onNext: () => note('Onboarding moved to the next step'),
                    onBack: () => note('Onboarding went back'),
                  };
                  return Design ? (
                    <Design intro={intro} options={options} {...props} />
                  ) : (
                    <Brain arrived={intro ? 'forward' : 'back'} {...props} />
                  );
                })()}
              </OnboardingFrame>
            )}
            {view === 'picker' && (
              <div className="pg-surface">
                <div className="model-current">
                  <div className="model-current-label">
                    <strong>Your model</strong>
                    <span>nod uses it for every reply</span>
                  </div>
                  <ModelPicker surface="settings" />
                </div>
                <p className="pg-hint">
                  The same picker sits in Settings and, in onboarding, appears when the owner has to
                  choose a model themselves.
                </p>
              </div>
            )}
            {view === 'settings' && (
              <div className="pg-surface pg-dialog">
                <h2 className="pg-surface-title">Models</h2>
                <ModelSettings />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
