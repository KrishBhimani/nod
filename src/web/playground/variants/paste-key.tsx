import { useState } from 'react';
import {
  Connected,
  ExpiredNotice,
  Problem,
  ServerForm,
  SignInButton,
  SmartKey,
  Step,
  Waiting,
  useConnect,
} from './connect';
import type { VariantProps } from '.';

export function PasteKey({ intro, onNext, onBack }: VariantProps) {
  const c = useConnect();
  const [server, setServer] = useState(false);
  function body() {
    if (c.shown) return <Connected c={c} />;
    if (c.signingIn) return <Waiting c={c} />;
    return (
      <div className="pgv-paste">
        <ExpiredNotice c={c} />
        <div className="pgv-sign-ins">
          <SignInButton c={c} provider="openai" primary />
          <SignInButton c={c} provider="openrouter" />
        </div>
        <p className="ob-brain-note">
          ChatGPT uses your Plus or Pro plan. OpenRouter uses your credits there.
        </p>
        <Problem>{c.models.error}</Problem>
        <p className="ob-brain-or" aria-hidden="true">
          or paste an API key
        </p>
        <SmartKey c={c} />
        {server ? (
          <div className="pgv-server">
            <ServerForm c={c} autoFocus />
          </div>
        ) : (
          <button
            type="button"
            className="ob-link pgv-quiet"
            onClick={() => {
              c.clearError();
              setServer(true);
            }}
          >
            Run models on your own computer or server?
          </button>
        )}
      </div>
    );
  }
  return (
    <Step
      c={c}
      intro={intro}
      onNext={onNext}
      onBack={onBack}
      messages={[
        'Let’s connect an AI provider.',
        'Sign in, or paste any API key and I’ll work out where it’s from.',
      ]}
    >
      {body()}
    </Step>
  );
}
