import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUp, Mic } from 'lucide-react';
import type { StepProps } from '..';
import {
  interviewLabels,
  type InterviewResponse,
  type InterviewSave,
} from '../../../../shared/onboarding';
import { api, errorMessage } from '../../../lib/api';
import {
  Bubble,
  Footer,
  Messages,
  prefersReducedMotion,
  Rise,
  UserBubble,
  useReveal,
} from '../motion';
import { readStep, readStored, writeStored } from '../storage';

type Turn = { ack: string[]; question: string };
type Talk = { answers: string[]; turns: Turn[] };

const first: Turn = {
  ack: [
    'I’m curious about you.',
    'I’m great at helping you launch that side project, grow your business, or take on the busywork you don’t have capacity for.',
  ],
  question: 'So, what are you working on these days?',
};
const scripted: Turn[] = [
  first,
  {
    ack: ['Got it, thanks.'],
    question:
      'What’s the next concrete win you’re aiming for? A launch, a milestone, a first group of people?',
  },
  { ack: ['That’s a clear target.'], question: 'What’s getting in the way of it right now?' },
  {
    ack: ['Makes sense.'],
    question: 'If I could take one recurring thing off your plate, what would it be?',
  },
];
const wrapUp: Turn = { ack: [], question: '' };
const owner = () => readStep<{ owner: string }>()?.owner;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function restore(): Talk {
  const saved = readStored<(Talk & { owner?: string }) | null>('about');
  if (
    !saved ||
    saved.owner !== owner() ||
    !Array.isArray(saved.answers) ||
    !Array.isArray(saved.turns)
  )
    return { answers: [], turns: [first] };
  const answers = saved.answers.slice(0, 4);
  return { answers, turns: [first, ...saved.turns.slice(0, answers.length)] };
}

export function About({ arrived, onNext }: StepProps) {
  const [{ answers, turns }, setTalk] = useState(restore);
  const [draft, setDraft] = useState('');
  const [fresh, setFresh] = useState(arrived === 'forward');
  const [introDone, setIntroDone] = useState(
    () => answers.length > 0 || arrived !== 'forward' || prefersReducedMotion(),
  );
  const [shown, setShown] = useState(false);
  const [waited, setWaited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const index = turns.length - 1;
  const thinking = turns.length === answers.length;
  const wrapped = turns.length === 5;

  useEffect(() => {
    writeStored('about', { owner: owner(), answers, turns: turns.slice(1) });
  }, [answers, turns]);

  useEffect(() => {
    const count = answers.length;
    if (!count || turns.length > count) return;
    const controller = new AbortController();
    const started = Date.now();
    const next: Promise<Turn> =
      count === 4
        ? wait(1000).then(() => wrapUp)
        : api<InterviewResponse>('/api/onboarding/interview', {
            method: 'POST',
            body: JSON.stringify({ answers }),
            signal: controller.signal,
          })
            .then((reply) => ({ ack: reply.ack ? [reply.ack] : [], question: reply.question }))
            .catch(() => scripted[count]);
    void next.then(async (turn) => {
      await wait(Math.max(0, 700 - (Date.now() - started)));
      if (controller.signal.aborted) return;
      setTalk((talk) =>
        talk.answers.length === count
          ? { ...talk, turns: [...talk.turns.slice(0, count), turn] }
          : talk,
      );
    });
    return () => controller.abort();
  }, [answers]);

  useEffect(() => {
    if (introDone && !thinking && !wrapped) input.current?.focus();
  }, [introDone, index]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || thinking || wrapped) return;
    setDraft('');
    setShown(false);
    setWaited(true);
    setTalk({ answers: [...answers, text], turns });
  }

  function restart() {
    setError('');
    setShown(false);
    setFresh(true);
    setWaited(false);
    setTalk({ answers: [], turns: [first] });
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const body: InterviewSave = { answers: answers as InterviewSave['answers'] };
      await api('/api/onboarding/interview', { method: 'PUT', body: JSON.stringify(body) });
      onNext();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  const generated = index > 0 || undefined;
  const lines: ReactNode[] = wrapped
    ? [
        <Bubble>So good to meet you.</Bubble>,
        <Bubble>
          So this is you:
          <span className="ob-about-summary" data-analytics-private>
            {interviewLabels.map((label, at) => (
              <span key={label}>
                <span>{label}</span>
                <strong>{answers[at]}</strong>
              </span>
            ))}
          </span>
        </Bubble>,
        <Bubble>
          I’ll keep all of this in mind. Next, let’s connect your email so I can start helping.
        </Bubble>,
      ]
    : [
        ...turns[index].ack.map((text) => (
          <Bubble data-analytics-private={generated}>{text}</Bubble>
        )),
        <Bubble className="ob-about-question" data-analytics-private={generated}>
          {turns[index].question}
        </Bubble>,
      ];
  const previous = thinking ? answers.at(-1) : index > 0 && !wrapped ? answers[index - 1] : '';

  return (
    <section className="ob-step ob-about" data-analytics-public>
      <div className="ob-about-chat">
        {previous && (
          <UserBubble key={`answer-${answers.length}`} className="ob-about-answer">
            {previous}
          </UserBubble>
        )}
        {thinking ? (
          <Messages key="thinking" items={[]} typing />
        ) : (
          <Reveal
            key={`turn-${index}`}
            lines={lines}
            animate={fresh || index > 0}
            open={waited}
            onDone={() => {
              setIntroDone(true);
              setShown(true);
            }}
          />
        )}
      </div>
      {!wrapped && (
        <Rise show={introDone} className="ob-about-compose">
          <form className="ob-composer" onSubmit={submit}>
            <input
              ref={input}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Type your answer…"
              aria-label="Your answer"
              autoComplete="off"
              maxLength={560}
              data-analytics-private
            />
            <div className="ob-composer-actions">
              <button
                type="button"
                className="ob-composer-mic"
                disabled
                title="Voice input is coming soon"
                aria-label="Voice input is coming soon"
              >
                <Mic size={16} aria-hidden="true" />
              </button>
              <button
                type="submit"
                className="ob-composer-send"
                aria-label="Send"
                disabled={!draft.trim() || thinking}
              >
                <ArrowUp size={18} aria-hidden="true" />
              </button>
            </div>
          </form>
          <p className="ob-about-hint">
            Question {Math.min(turns.length, 4)} of 4 · type your answer
          </p>
        </Rise>
      )}
      {wrapped && (
        <Footer
          show={shown}
          onBack={restart}
          backLabel="Change my answers"
          onNext={() => void save()}
          busy={saving}
        />
      )}
      {error && (
        <p className="ob-about-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function Reveal({
  lines,
  animate,
  open,
  onDone,
}: {
  lines: ReactNode[];
  animate: boolean;
  open: boolean;
  onDone(): void;
}) {
  const { revealed, typing, done } = useReveal(
    [...lines.map((_, at) => (at ? { wait: 240, typing: 560 } : { typing: 560 })), { wait: 240 }],
    { enabled: animate, open },
  );
  useEffect(() => {
    if (done) onDone();
  }, [done]);
  return <Messages items={lines} revealed={revealed} typing={typing} />;
}
