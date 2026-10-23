import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from '../../components/icons';
import type { ModelProvider } from '../../../shared/models';
import {
  Connected,
  ExpiredNotice,
  KeyForm,
  Logo,
  Problem,
  ServerForm,
  SignInButton,
  Step,
  Waiting,
  useConnect,
  type Connect,
} from './connect';
import type { VariantProps } from '.';

export type Entry = {
  id: string;
  provider: ModelProvider;
  name: string;
  common?: boolean;
  signIn?: boolean;
};

export const rest: Entry[] = [
  { id: 'anthropic', provider: 'anthropic', name: 'Anthropic', common: true },
  { id: 'openrouter', provider: 'openrouter', name: 'OpenRouter', common: true },
  { id: 'google-vertex', provider: 'google-vertex', name: 'Google Vertex AI' },
  { id: 'amazon-bedrock', provider: 'amazon-bedrock', name: 'Amazon Bedrock' },
  { id: 'azure', provider: 'azure', name: 'Azure OpenAI' },
  { id: 'compatible', provider: 'compatible', name: 'Your own server' },
];

const joined: Entry[] = [
  { id: 'openai', provider: 'openai', name: 'OpenAI', common: true },
  ...rest,
];

const split: Entry[] = [
  { id: 'chatgpt', provider: 'openai', name: 'Sign in with ChatGPT', common: true, signIn: true },
  { id: 'openai', provider: 'openai', name: 'OpenAI API', common: true },
  ...rest,
];

export const firstUncommon = rest.find((item) => !item.common)?.id;

export const depth = { list: 0, setup: 1, done: 2 } as const;

export type View = keyof typeof depth;

export function Setup({
  c,
  entry,
  separate,
  compact,
}: {
  c: Connect;
  entry: Entry;
  separate: ModelProvider[];
  compact?: boolean;
}) {
  const { provider } = entry;
  if (c.signingIn) return <Waiting c={c} />;
  if (entry.signIn)
    return (
      <>
        <div className="ob-brain-oauth">
          <SignInButton c={c} provider={provider as 'openai' | 'openrouter'} primary />
          <p className="ob-brain-note">
            {provider === 'openai'
              ? 'Uses your ChatGPT Plus or Pro plan.'
              : 'Creates a key for me and uses your OpenRouter credits.'}
          </p>
        </div>
        <Problem>{c.models.error}</Problem>
      </>
    );
  if (provider === 'compatible') return <ServerForm c={c} autoFocus compact={compact} />;
  if ((provider === 'openai' || provider === 'openrouter') && !separate.includes(provider))
    return (
      <>
        <div className="ob-brain-oauth">
          <SignInButton c={c} provider={provider} primary={provider === 'openai'} />
          {provider === 'openrouter' && (
            <p className="ob-brain-note">Creates a key for me and uses your OpenRouter credits.</p>
          )}
        </div>
        <Problem>{c.models.error}</Problem>
        <p className="ob-brain-or" aria-hidden="true">
          or use an API key
        </p>
        <KeyForm c={c} compact={compact} provider={provider} label={false} />
      </>
    );
  return (
    <>
      <KeyForm c={c} compact={compact} provider={provider} autoFocus />
      {provider === 'anthropic' && !compact && (
        <p className="ob-brain-note">Claude Pro and Max plans can’t be used here.</p>
      )}
    </>
  );
}

export function Card({
  page,
  direction,
  children,
}: {
  page: string;
  direction: 'forward' | 'back';
  children: ReactNode;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const node = inner.current!;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    setHeight(node.offsetHeight);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="pgv-card" style={height ? { height } : undefined}>
      <div ref={inner}>
        <div key={page} className="pgv-card-page" data-direction={direction}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function OneCard({ intro, onNext, onBack, options = {} }: VariantProps) {
  const c = useConnect();
  const entries = options.split ? split : joined;
  const [picked, setPicked] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const firstMore = useRef<HTMLButtonElement>(null);
  const folded = options.collapse && !expanded;
  const listed = folded ? entries.filter((item) => item.common) : entries;
  useEffect(() => {
    if (expanded) firstMore.current?.focus();
  }, [expanded]);
  const entry = entries.find((item) => item.id === picked);
  const view: View = c.shown ? 'done' : entry ? 'setup' : 'list';
  const page = view === 'setup' ? `setup:${entry!.id}` : view;
  const [motion, setMotion] = useState({ page, view, direction: 'forward' as 'forward' | 'back' });
  if (motion.page !== page) {
    setMotion({
      page,
      view,
      direction: depth[view] >= depth[motion.view] ? 'forward' : 'back',
    });
    if (view === 'done' && picked) setPicked(undefined);
  }

  function back() {
    c.clearError();
    if (c.flow.signIn) void c.flow.cancel();
    setPicked(undefined);
  }

  function choose(item: Entry) {
    c.clearError();
    setPicked(item.id);
    if (item.signIn) c.signIn('openai');
  }

  return (
    <Step
      c={c}
      intro={intro}
      onNext={onNext}
      onBack={onBack}
      messages={['Let’s connect an AI provider. Which one do you want me to use?']}
    >
      <ExpiredNotice c={c} />
      <Card page={page} direction={motion.direction}>
        {view === 'done' ? (
          <Connected c={c} />
        ) : view === 'setup' ? (
          <>
            <header className="pgv-card-header">
              <button
                type="button"
                className="pgv-card-back"
                aria-label="All providers"
                disabled={c.flow.pending || c.checking}
                onClick={back}
              >
                <ChevronLeft size={20} aria-hidden="true" />
              </button>
              <h3>
                <Logo provider={entry!.provider} size={20} />
                {entry!.name}
              </h3>
            </header>
            <div className="pgv-card-body">
              <Setup c={c} entry={entry!} separate={options.split ? ['openai'] : []} />
            </div>
          </>
        ) : (
          <ul className="pgv-card-list" aria-label="AI providers">
            {listed.map((item) => (
              <li key={item.id}>
                <button
                  ref={item.id === firstUncommon ? firstMore : undefined}
                  type="button"
                  className="pgv-card-option"
                  disabled={c.locked}
                  onClick={() => choose(item)}
                >
                  <Logo provider={item.provider} size={20} />
                  <span className="pgv-card-name">{item.name}</span>
                  <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </li>
            ))}
            {folded && (
              <li>
                <button
                  type="button"
                  className="pgv-card-option pgv-card-more"
                  aria-expanded={false}
                  disabled={c.locked}
                  onClick={() => setExpanded(true)}
                >
                  <span className="pgv-card-lead" aria-hidden="true">
                    <ChevronDown size={16} strokeWidth={1.75} />
                  </span>
                  <span className="pgv-card-name">More providers</span>
                  <span className="pgv-more-logos" aria-hidden="true">
                    {rest
                      .filter((item) => !item.common)
                      .map((item) => (
                        <Logo key={item.id} provider={item.provider} />
                      ))}
                  </span>
                </button>
              </li>
            )}
          </ul>
        )}
      </Card>
    </Step>
  );
}
