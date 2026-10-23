import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ModelProvider } from '../../../shared/models';
import { modelProviderNames } from '../../../shared/models';
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

const main: ModelProvider[] = ['openai', 'anthropic', 'openrouter'];
const more: ModelProvider[] = ['google-vertex', 'amazon-bedrock', 'azure', 'compatible'];

function Options({ c, provider }: { c: Connect; provider: ModelProvider }) {
  if (c.signingIn) return <Waiting c={c} />;
  if (provider === 'compatible') return <ServerForm c={c} autoFocus />;
  if (provider === 'openai' || provider === 'openrouter')
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
        <KeyForm c={c} provider={provider} label={false} />
      </>
    );
  return (
    <>
      <KeyForm c={c} provider={provider} autoFocus />
      {provider === 'anthropic' && (
        <p className="ob-brain-note">Claude Pro and Max plans can’t be used here.</p>
      )}
    </>
  );
}

function Row({
  c,
  provider,
  open,
  onOpen,
}: {
  c: Connect;
  provider: ModelProvider;
  open: boolean;
  onOpen(): void;
}) {
  return (
    <div className="ob-brain-rise pgv-row" data-open={open}>
      <h3 className="ob-brain-heading">
        <button
          type="button"
          className="ob-brain-option"
          aria-expanded={open}
          disabled={c.locked}
          onClick={onOpen}
        >
          <Logo provider={provider} size={20} />
          <span className="ob-brain-option-text">
            <span className="ob-brain-option-name">{modelProviderNames[provider]}</span>
          </span>
          <ChevronDown size={18} className="pgv-chevron" aria-hidden="true" />
        </button>
      </h3>
      {open && (
        <div className="ob-brain-options pgv-options">
          <Options c={c} provider={provider} />
        </div>
      )}
    </div>
  );
}

export function Focused({ intro, onNext, onBack }: VariantProps) {
  const c = useConnect();
  const [open, setOpen] = useState<ModelProvider>();
  const [showMore, setShowMore] = useState(false);
  const toggle = (provider: ModelProvider) => {
    c.clearError();
    setOpen(open === provider ? undefined : provider);
  };
  return (
    <Step
      c={c}
      intro={intro}
      onNext={onNext}
      onBack={onBack}
      messages={[
        'Let’s connect an AI provider.',
        'If you have ChatGPT Plus or Pro, sign in with it. Otherwise, use an API key.',
      ]}
    >
      {c.shown ? (
        <Connected c={c} />
      ) : (
        <div className="ob-brain-list">
          <ExpiredNotice c={c} />
          {main.map((provider) => (
            <Row
              key={provider}
              c={c}
              provider={provider}
              open={open === provider}
              onOpen={() => toggle(provider)}
            />
          ))}
          {showMore || more.includes(open as ModelProvider) ? (
            more.map((provider) => (
              <Row
                key={provider}
                c={c}
                provider={provider}
                open={open === provider}
                onOpen={() => toggle(provider)}
              />
            ))
          ) : (
            <button type="button" className="pgv-more" onClick={() => setShowMore(true)}>
              <span>More providers</span>
              <span className="pgv-more-logos" aria-hidden="true">
                {more.map((provider) => (
                  <Logo key={provider} provider={provider} />
                ))}
              </span>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </Step>
  );
}
