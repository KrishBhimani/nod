import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from '../../components/icons';
import {
  Connected,
  ExpiredNotice,
  KeyForm,
  Logo,
  Problem,
  SignInButton,
  Step,
  Waiting,
  useConnect,
  type Connect,
} from './connect';
import { Card, Setup, depth, firstUncommon, rest, type Entry, type View } from './one-card';
import type { VariantProps } from '.';

const entries: Entry[] = [
  { id: 'openai', provider: 'openai', name: 'OpenAI', common: true },
  ...rest,
];

function SignInFirst({ c, provider }: { c: Connect; provider: 'openai' | 'openrouter' }) {
  const [key, setKey] = useState(false);
  if (c.signingIn) return <Waiting c={c} />;
  return (
    <div className="pgv-signin-page">
      <div className="ob-brain-oauth">
        <SignInButton c={c} provider={provider} primary />
        <p className="ob-brain-note">
          {provider === 'openai'
            ? 'Uses your ChatGPT Plus or Pro plan.'
            : 'Creates a key for me and uses your OpenRouter credits.'}
        </p>
      </div>
      <Problem>{c.models.error}</Problem>
      {key ? (
        <div className="pgv-key-reveal">
          <KeyForm c={c} provider={provider} autoFocus compact />
        </div>
      ) : (
        <button
          type="button"
          className="ob-link pgv-quiet"
          onClick={() => {
            c.clearError();
            setKey(true);
          }}
        >
          Use an API key instead
        </button>
      )}
    </div>
  );
}

export function ChevronPages({ intro, onNext, onBack, options = {} }: VariantProps) {
  const c = useConnect();
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
              {entry!.provider === 'openai' || entry!.provider === 'openrouter' ? (
                <SignInFirst c={c} provider={entry!.provider} />
              ) : (
                <Setup c={c} entry={entry!} separate={[]} compact />
              )}
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
                  onClick={() => {
                    c.clearError();
                    setPicked(item.id);
                  }}
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
