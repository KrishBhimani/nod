import { Fragment, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUpRight,
  CalendarDays,
  ChevronDown,
  ListTodo,
  Plus,
  X,
} from 'lucide-react';
import type { AppState, Artifact, Message, Task } from '../../shared/contracts';
import { Composer } from '../components/composer';
import { MessageBubble, MessageText } from '../components/message';
import { TaskList, activeStatuses } from '../components/task-list';
import { BrandMark } from '../components/brand';
import { Button, Notice } from '../components/ui';
import { api, errorMessage, post } from '../lib/api';

function dayLabel(date: string) {
  const value = new Date(date);
  const today = new Date();
  if (value.toDateString() === today.toDateString()) return 'Today';
  today.setDate(today.getDate() - 1);
  if (value.toDateString() === today.toDateString()) return 'Yesterday';
  return value.toLocaleDateString([], {
    day: 'numeric',
    month: 'long',
    year: value.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}
export function Chat({
  state,
  streams,
  refresh,
  onboarding,
  onOnboarded,
}: {
  state: AppState;
  streams: Record<string, string>;
  refresh(): Promise<void>;
  onboarding: number;
  onOnboarded(): void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [replyTo, setReplyTo] = useState<Task | null>(null);
  const [forceNew, setForceNew] = useState(false);
  const historyVersion = useRef(0);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [older, setOlder] = useState<Message[]>([]);
  const [archive, setArchive] = useState<Message[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(true);
  const [date, setDate] = useState('');
  const [scrolledUp, setScrolledUp] = useState(false);
  const [choices, setChoices] = useState<{ id: string; title: string }[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const onboardingSent = useRef(0);
  const allMessages = archive ?? [
    ...older.filter((item) => !state.messages.some((message) => message.id === item.id)),
    ...state.messages,
  ];
  const active = state.tasks.filter((task) => activeStatuses.includes(task.status));
  const working = active.filter((task) => ['queued', 'running'].includes(task.status));
  const streamEntries = Object.entries(streams).filter(([, value]) => value);
  const onboardingVisible = onboarding > 0 || state.messages.length === 0;
  useEffect(() => {
    if (stickToBottom.current && !archive)
      bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [state.messages, streams, sending, archive]);
  useEffect(() => {
    if (onboarding && onboardingSent.current !== onboarding) {
      onboardingSent.current = onboarding;
      historyVersion.current++;
      setLoadingHistory(false);
      setArchive(null);
      stickToBottom.current = true;
    }
  }, [onboarding]);
  async function send(value: string, attachments: Artifact[]) {
    historyVersion.current++;
    setLoadingHistory(false);
    setSending(true);
    setError('');
    setChoices([]);
    setArchive(null);
    stickToBottom.current = true;
    try {
      const response = await fetch('/api/messages', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: value,
          attachmentIds: attachments.map((item) => item.id),
          ...(replyTo ? { taskId: replyTo.id } : {}),
          forceNew,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (result.code === 'task_selection_required') setChoices(result.choices ?? []);
        throw new Error(result.error || 'The message could not be sent.');
      }
      setReplyTo(null);
      setForceNew(false);
      await refresh();
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setSending(false);
    }
  }
  async function history(jump?: string) {
    const version = ++historyVersion.current;
    setLoadingHistory(true);
    setError('');
    const first = allMessages[0];
    const height = scroll.current?.scrollHeight ?? 0;
    try {
      const before = jump ? new Date(`${jump}T23:59:59.999`).toISOString() : first?.createdAt;
      const query = new URLSearchParams({
        ...(before ? { before } : {}),
        ...(!jump && first ? { beforeId: first.id } : {}),
      });
      const result = await api<Message[]>(`/api/messages?${query}`);
      if (version !== historyVersion.current) return;
      if (jump) {
        setArchive(result);
        stickToBottom.current = false;
        setHasEarlier(result.length === 60);
        requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: 'end' }));
      } else {
        if (archive) setArchive([...result, ...archive]);
        else setOlder((current) => [...result, ...current]);
        setHasEarlier(result.length === 60);
        requestAnimationFrame(() => {
          if (scroll.current) scroll.current.scrollTop += scroll.current.scrollHeight - height;
        });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      if (version === historyVersion.current) setLoadingHistory(false);
    }
  }
  async function startOnboarding() {
    setSending(true);
    setError('');
    try {
      await post('/api/onboarding', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      onOnboarded();
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="chat-page">
      <div className="chat-toolbar">
        <span>{archive ? 'Conversation history' : 'Conversation'}</span>
        <div className="chat-toolbar-actions">
          <label className="date-jump" title="Jump to date">
            <CalendarDays size={15} />
            <input
              type="date"
              aria-label="Jump to date"
              value={date}
              max={new Date().toLocaleDateString('en-CA')}
              onChange={(event) => {
                setDate(event.target.value);
                if (event.target.value) void history(event.target.value);
              }}
            />
          </label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTasksOpen(!tasksOpen)}
            aria-expanded={tasksOpen}
          >
            <ListTodo size={16} />
            {active.length ? `${active.length} active` : 'Tasks'}
            <ChevronDown size={13} />
          </Button>
        </div>
      </div>
      <div
        className="conversation-scroll"
        ref={scroll}
        onScroll={() => {
          const element = scroll.current;
          if (element) {
            stickToBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 160;
            setScrolledUp(!stickToBottom.current);
          }
        }}
      >
        <div className="conversation-column">
          {archive && allMessages.length === 0 && (
            <div className="page-empty">
              <CalendarDays size={24} />
              <p>No messages on or before this date.</p>
            </div>
          )}
          {allMessages.length > 0 && hasEarlier && (
            <div className="history-control">
              <Button
                variant="ghost"
                size="sm"
                disabled={loadingHistory}
                onClick={() => void history()}
              >
                {loadingHistory ? 'Loading…' : 'Load earlier messages'}
              </Button>
            </div>
          )}
          {allMessages.length === 0 && !archive && (
            <div className="welcome">
              <BrandMark />
              <h1>What’s on your mind?</h1>
              <div className="starter-actions">
                {['Plan my day', 'Help me research something', 'Start a goal'].map((label) => (
                  <button
                    key={label}
                    onClick={() => {
                      setText(label);
                      document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
                    }}
                  >
                    {label}
                    <ArrowUpRight size={15} />
                  </button>
                ))}
              </div>
            </div>
          )}
          <div
            className="messages"
            role="log"
            aria-label="Conversation"
            aria-live="polite"
            aria-relevant="additions"
          >
            {allMessages.map((message, index) => (
              <Fragment key={message.id}>
                {(!index ||
                  new Date(allMessages[index - 1].createdAt).toDateString() !==
                    new Date(message.createdAt).toDateString()) && (
                  <div className="day-divider">
                    <span>{dayLabel(message.createdAt)}</span>
                  </div>
                )}
                <MessageBubble
                  message={message}
                  speechReady={state.configuration.speechReady}
                  onReply={
                    message.taskId
                      ? () => {
                          void api<Task>(`/api/tasks/${message.taskId}`)
                            .then((task) => {
                              setReplyTo(task);
                              setForceNew(false);
                              document
                                .querySelector<HTMLTextAreaElement>('.composer textarea')
                                ?.focus();
                            })
                            .catch((cause) => setError(errorMessage(cause)));
                        }
                      : undefined
                  }
                />
              </Fragment>
            ))}
            {!archive &&
              streamEntries.map(([id, value]) => (
                <article
                  className="message message-assistant streaming-message"
                  key={id}
                  aria-label="Sidekick is responding"
                >
                  <div className="assistant-mark">
                    <BrandMark small />
                  </div>
                  <div className="message-content">
                    <MessageText text={value} />
                    <span className="stream-cursor" />
                  </div>
                </article>
              ))}
            {!archive && (sending || working.length > 0) && streamEntries.length === 0 && (
              <div className="thinking" role="status">
                <span className="thinking-dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  {sending
                    ? 'Sending'
                    : working.length > 1
                      ? `Working on ${working.length} tasks`
                      : 'Working on it'}
                </span>
              </div>
            )}
          </div>
          {onboardingVisible && (
            <section className="onboarding-card">
              <div>
                <h2>{state.messages.length ? 'Let’s get you set up.' : 'Make Sidekick yours.'}</h2>
                <p>Connect your tools and pick something to work on.</p>
              </div>
              <Button variant="outline" disabled={sending} onClick={() => void startOnboarding()}>
                Get started
                <ArrowUpRight size={15} />
              </Button>
              {onboarding > 0 && (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Dismiss setup"
                  onClick={onOnboarded}
                >
                  <X size={15} />
                </Button>
              )}
            </section>
          )}
          <div ref={bottom} />
        </div>
      </div>
      <div className="chat-bottom conversation-column">
        {(scrolledUp || archive) && (
          <Button
            className="jump-latest"
            variant="outline"
            size="sm"
            onClick={() => {
              historyVersion.current++;
              setLoadingHistory(false);
              setArchive(null);
              setDate('');
              setHasEarlier(true);
              stickToBottom.current = true;
              requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: 'end' }));
            }}
          >
            <ArrowDown size={14} />
            Back to latest
          </Button>
        )}
        {tasksOpen && (
          <div className="task-drawer">
            <div className="section-title">
              <h2>Tasks</h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setForceNew(true);
                  setReplyTo(null);
                  setChoices([]);
                  setError('');
                  setTasksOpen(false);
                  document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
                }}
              >
                <Plus size={14} />
                New request
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close tasks"
                onClick={() => setTasksOpen(false)}
              >
                <X size={16} />
              </Button>
            </div>
            <TaskList
              tasks={state.tasks}
              onContinue={(task) => {
                setReplyTo(task);
                setForceNew(false);
                setTasksOpen(false);
                document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
              }}
              onRefresh={refresh}
            />
          </div>
        )}
        {error && <Notice>{error}</Notice>}
        {choices.length > 0 && (
          <div className="task-choices">
            {choices.map((choice) => (
              <Button
                key={choice.id}
                variant="outline"
                size="sm"
                onClick={() => {
                  void api<Task>(`/api/tasks/${choice.id}`)
                    .then((task) => {
                      setReplyTo(task);
                      setForceNew(false);
                      setChoices([]);
                      setError('');
                    })
                    .catch((cause) => setError(errorMessage(cause)));
                }}
              >
                {choice.title}
              </Button>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setForceNew(true);
                setReplyTo(null);
                setChoices([]);
                setError('');
              }}
            >
              New request
            </Button>
          </div>
        )}
        {!state.configuration.llmReady && (
          <Notice kind="info">
            The assistant isn’t connected yet. Check the development setup.
          </Notice>
        )}
        {forceNew && (
          <div className="reply-context">
            <span>Starting a new request</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Use automatic task routing"
              onClick={() => setForceNew(false)}
            >
              <X size={14} />
            </Button>
          </div>
        )}
        <Composer
          ready={state.configuration.llmReady}
          sending={sending}
          text={text}
          setText={setText}
          replyTo={replyTo}
          clearReply={() => setReplyTo(null)}
          onSend={send}
        />
      </div>
    </div>
  );
}
