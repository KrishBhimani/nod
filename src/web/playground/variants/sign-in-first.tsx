import { useState } from 'react';
import { ArrowLeft } from '../../components/icons';
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
} from './connect';
import type { VariantProps } from '.';

const tiles: { provider: ModelProvider; name: string; sub: string }[] = [
  { provider: 'anthropic', name: 'Anthropic', sub: 'API key' },
  { provider: 'openrouter', name: 'OpenRouter', sub: 'Sign in or API key' },
  { provider: 'openai', name: 'OpenAI API', sub: 'API key' },
  { provider: 'google-vertex', name: 'Google Vertex AI', sub: 'API key' },
  { provider: 'amazon-bedrock', name: 'Amazon Bedrock', sub: 'API key and region' },
  { provider: 'azure', name: 'Azure OpenAI', sub: 'Deployment' },
  { provider: 'compatible', name: 'Your own server', sub: 'Ollama, LM Studio' },
];

export function SignInFirst({ intro, onNext, onBack }: VariantProps) {
  const c = useConnect();
  const [picked, setPicked] = useState<ModelProvider>();
  function body() {
    if (c.shown) return <Connected c={c} />;
    if (c.signingIn) return <Waiting c={c} />;
    if (picked)
      return (
        <div className="pgv-panel">
          <button
            type="button"
            className="pgv-back"
            onClick={() => {
              c.clearError();
              setPicked(undefined);
            }}
          >
            <ArrowLeft size={16} aria-hidden="true" />
            All providers
          </button>
          <h3 className="pgv-panel-title">
            <Logo provider={picked} size={20} />
            {tiles.find((tile) => tile.provider === picked)!.name}
          </h3>
          {picked === 'compatible' ? (
            <ServerForm c={c} autoFocus />
          ) : (
            <>
              {picked === 'openrouter' && (
                <>
                  <div className="ob-brain-oauth">
                    <SignInButton c={c} provider="openrouter" />
                    <p className="ob-brain-note">Creates a key for me. Uses your credits.</p>
                  </div>
                  <Problem>{c.models.error}</Problem>
                  <p className="ob-brain-or" aria-hidden="true">
                    or use an API key
                  </p>
                </>
              )}
              <KeyForm c={c} provider={picked} autoFocus label={picked !== 'openrouter'} />
              {picked === 'anthropic' && (
                <p className="ob-brain-note">
                  Claude Pro and Max plans only work in Anthropic’s own apps.
                </p>
              )}
            </>
          )}
        </div>
      );
    return (
      <>
        <ExpiredNotice c={c} />
        <div className="pgv-hero">
          <span className="pgv-hero-logo">
            <Logo provider="openai" size={28} />
          </span>
          <div className="pgv-hero-text">
            <h3>Use your ChatGPT plan</h3>
            <p>Plus or Pro. No API key, nothing else to set up.</p>
          </div>
          <SignInButton c={c} provider="openai" primary />
          <Problem>{c.models.error}</Problem>
        </div>
        <p className="pgv-section">Or connect another provider</p>
        <div className="pgv-tiles">
          {tiles.map((tile) => (
            <button
              type="button"
              key={tile.provider + tile.name}
              className="pgv-tile"
              disabled={c.locked}
              onClick={() => {
                c.clearError();
                setPicked(tile.provider);
              }}
            >
              <Logo provider={tile.provider} size={22} />
              <span className="pgv-tile-name">{tile.name}</span>
              <span className="pgv-tile-sub">{tile.sub}</span>
            </button>
          ))}
        </div>
      </>
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
        'The quickest way is your ChatGPT plan. Any of the others work too.',
      ]}
    >
      {body()}
    </Step>
  );
}
