import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight } from '../../components/icons';
import { Button } from '../../components/ui';
import { Connected, ExpiredNotice, Logo, Step, useConnect } from './connect';
import { Card, Setup, depth, firstUncommon, rest, type Entry, type View } from './one-card';
import type { VariantProps } from '.';

const entries: Entry[] = [
  { id: 'openai', provider: 'openai', name: 'OpenAI', common: true },
  ...rest,
];

const signs: Partial<Record<string, 'openai' | 'openrouter'>> = {
  openai: 'openai',
  openrouter: 'openrouter',
};

type Picked = { id: string; mode: 'key' | 'sign-in' };

export function RowActions({ intro, onNext, onBack, options = {} }: VariantProps) {
  const c = useConnect();
  const [picked, setPicked] = useState<Picked>();
  const [expanded, setExpanded] = useState(false);
  const firstMore = useRef<HTMLButtonElement>(null);
  const folded = options.collapse && !expanded;
  const listed = folded ? entries.filter((item) => item.common) : entries;
  useEffect(() => {
    if (expanded) firstMore.current?.focus();
  }, [expanded]);
  const entry = entries.find((item) => item.id === picked?.id);
  const view: View = c.shown ? 'done' : entry ? 'setup' : 'list';
  const page = view === 'setup' ? `setup:${picked!.id}:${picked!.mode}` : view;
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

  function open(item: Entry, mode: Picked['mode']) {
    c.clearError();
    setPicked({ id: item.id, mode });
    const provider = signs[item.id];
    if (mode === 'sign-in' && provider) c.signIn(provider);
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
                {picked!.mode === 'sign-in'
                  ? entry!.provider === 'openai'
                    ? 'Sign in with ChatGPT'
                    : `Sign in to ${entry!.name}`
                  : signs[entry!.id]
                    ? `${entry!.name} API key`
                    : entry!.name}
              </h3>
            </header>
            <div className="pgv-card-body">
              <Setup
                c={c}
                entry={{ ...entry!, signIn: picked!.mode === 'sign-in' }}
                separate={['openai', 'openrouter']}
              />
            </div>
          </>
        ) : (
          <ul className="pgv-card-list" aria-label="AI providers">
            {listed.map((item) => (
              <li key={item.id}>
                {signs[item.id] && options.column ? (
                  <div className="pgv-card-split" data-divider={!options.noDivider}>
                    <button
                      type="button"
                      className="pgv-card-main"
                      disabled={c.locked}
                      aria-label={
                        item.provider === 'openai'
                          ? 'OpenAI: Sign in with ChatGPT'
                          : `${item.name}: Sign in`
                      }
                      onClick={() => open(item, 'sign-in')}
                    >
                      <Logo provider={item.provider} size={20} />
                      <span className="pgv-card-name">{item.name}</span>
                      <span className="button button-sm button-secondary pgv-sign-in-row">
                        {item.provider === 'openai' ? 'Sign in with ChatGPT' : 'Sign in'}
                        <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
                      </span>
                    </button>
                    {!options.noDivider && <span className="pgv-card-divider" aria-hidden="true" />}
                    <button
                      type="button"
                      className="pgv-card-key"
                      disabled={c.locked}
                      aria-label={`Use an API key for ${item.name}`}
                      onClick={() => open(item, 'key')}
                    >
                      <span className="pgv-card-hint">API key</span>
                      <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </div>
                ) : signs[item.id] ? (
                  <div className="pgv-card-row">
                    <Logo provider={item.provider} size={20} />
                    <span className="pgv-card-name">{item.name}</span>
                    <span className="pgv-card-buttons">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={c.locked}
                        aria-label={`Use an API key for ${item.name}`}
                        onClick={() => open(item, 'key')}
                      >
                        API key
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="pgv-sign-in-row"
                        disabled={c.locked}
                        aria-label={
                          item.provider === 'openai'
                            ? 'Sign in with ChatGPT'
                            : `Sign in to ${item.name}`
                        }
                        onClick={() => open(item, 'sign-in')}
                      >
                        Sign in
                        <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
                      </Button>
                    </span>
                  </div>
                ) : (
                  <button
                    ref={item.id === firstUncommon ? firstMore : undefined}
                    type="button"
                    className="pgv-card-option"
                    disabled={c.locked}
                    onClick={() => open(item, 'key')}
                  >
                    <Logo provider={item.provider} size={20} />
                    <span className="pgv-card-name">{item.name}</span>
                    <span className="pgv-card-hint">
                      {item.provider === 'compatible' ? 'Server address' : 'API key'}
                    </span>
                    <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )}
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
