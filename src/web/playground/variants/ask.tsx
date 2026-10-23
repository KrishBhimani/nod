import { useState, type ReactNode } from 'react';
import type { ModelProvider } from '../../../shared/models';
import { modelProviderNames } from '../../../shared/models';
import { Bubble, Messages, UserBubble } from '../../pages/onboarding/motion';
import {
  Connected,
  ExpiredNotice,
  KeyForm,
  Logo,
  Problem,
  ServerForm,
  SignInButton,
  SmartKey,
  Step,
  Waiting,
  useConnect,
  type Connect,
} from './connect';
import type { VariantProps } from '.';

type Answer = 'chatgpt' | 'claude' | 'key' | 'none' | 'own';

const answers: Record<Answer, string> = {
  chatgpt: 'ChatGPT Plus or Pro',
  claude: 'Claude Pro or Max',
  key: 'An API key',
  none: 'None of these',
  own: 'My own server or cloud account',
};

const own: ModelProvider[] = ['compatible', 'amazon-bedrock', 'google-vertex', 'azure'];

function Reply({ c, answer }: { c: Connect; answer: Answer }) {
  const [picked, setPicked] = useState<ModelProvider>();
  const said: Record<Answer, ReactNode[]> = {
    chatgpt: ['Sign in with ChatGPT and I’ll use your plan. No API key needed.'],
    claude: [
      'Claude plans only work in Anthropic’s own apps, so I can’t use yours.',
      'An Anthropic API key works. It’s billed separately, by what you use.',
    ],
    key: ['Paste it here. I’ll work out which service it’s from.'],
    none: [
      'The easiest start is OpenRouter. Sign in, add a few dollars of credit, and you can use models from every major lab.',
    ],
    own: ['Which one?'],
  };
  return (
    <>
      <Messages
        items={said[answer].map((line, index) => (
          <Bubble key={index}>{line}</Bubble>
        ))}
      />
      <div className="pgv-reply">
        {answer === 'chatgpt' && (
          <>
            <SignInButton c={c} provider="openai" primary />
            <Problem>{c.models.error}</Problem>
          </>
        )}
        {answer === 'claude' && <KeyForm c={c} provider="anthropic" autoFocus />}
        {answer === 'key' && <SmartKey c={c} autoFocus />}
        {answer === 'none' && (
          <>
            <SignInButton c={c} provider="openrouter" primary />
            <Problem>{c.models.error}</Problem>
          </>
        )}
        {answer === 'own' &&
          (picked ? (
            picked === 'compatible' ? (
              <ServerForm c={c} autoFocus />
            ) : (
              <KeyForm c={c} provider={picked} autoFocus />
            )
          ) : (
            <div className="pgv-own">
              {own.map((provider) => (
                <button
                  type="button"
                  key={provider}
                  className="pgv-tile pgv-tile-row"
                  onClick={() => setPicked(provider)}
                >
                  <Logo provider={provider} size={20} />
                  <span className="pgv-tile-name">
                    {provider === 'compatible' ? 'A server I run' : modelProviderNames[provider]}
                  </span>
                  {provider === 'compatible' && (
                    <span className="pgv-tile-sub">Ollama, LM Studio, vLLM</span>
                  )}
                </button>
              ))}
            </div>
          ))}
      </div>
    </>
  );
}

export function Ask({ intro, onNext, onBack }: VariantProps) {
  const c = useConnect();
  const [answer, setAnswer] = useState<Answer>();
  function body() {
    if (c.shown) return <Connected c={c} />;
    if (c.signingIn) return <Waiting c={c} />;
    if (!answer)
      return (
        <>
          <ExpiredNotice c={c} />
          <div className="pgv-answers" role="group" aria-label="What do you have?">
            {(Object.keys(answers) as Answer[]).map((key) => (
              <button
                type="button"
                key={key}
                className="pgv-answer"
                onClick={() => {
                  c.clearError();
                  setAnswer(key);
                }}
              >
                {answers[key]}
              </button>
            ))}
          </div>
        </>
      );
    return (
      <div className="pgv-thread">
        <div className="pgv-sent">
          <UserBubble>{answers[answer]}</UserBubble>
        </div>
        <Reply key={answer} c={c} answer={answer} />
        <button
          type="button"
          className="ob-link pgv-quiet"
          onClick={() => {
            c.clearError();
            setAnswer(undefined);
          }}
        >
          Pick another answer
        </button>
      </div>
    );
  }
  return (
    <Step
      c={c}
      intro={intro}
      onNext={onNext}
      onBack={onBack}
      messages={['I need an AI provider to think with.', 'Which of these do you already have?']}
    >
      {body()}
    </Step>
  );
}
