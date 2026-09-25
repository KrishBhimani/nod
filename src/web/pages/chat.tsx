import { Fragment, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight } from 'lucide-react';
import type { AppState, Artifact, Message, SubmitMessageResponse } from '../../shared/contracts';
import { Composer, type ComposerHandle } from '../components/composer';
import { MessageBubble, MessageText } from '../components/message';
import { ChatTurnRail } from '../components/chat-turn-rail';
import { BrandMark } from '../components/brand';
import { Button, Notice } from '../components/ui';
import { api, errorMessage, post } from '../lib/api';
import {
  hasVisibleChatActivity,
  messagesAreGrouped,
  visibleConversationTurns,
} from '../lib/chat-messages';
import './chat.css';

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
  resetConversation,
  composerDraft,
}: {
  state: AppState;
  streams: Record<string, string>;
  refresh(): Promise<void>;
  resetConversation(): Promise<number>;
  composerDraft?: { text: string; nonce: number };
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [optimistic, setOptimistic] = useState<Array<{ revision: number; message: Message }>>([]);
  const composer = useRef<ComposerHandle>(null);
  const sendLock = useRef<{ id: string; revision: number } | null>(null);
  const retry = useRef<{ id: string; revision: number; signature: string } | null>(null);
  const historyVersion = useRef(0);
  const revision = state.conversationRevision ?? 0;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const [historyPage, setHistoryPage] = useState<{ revision: number; messages: Message[] }>({
    revision,
    messages: [],
  });
  const older = historyPage.revision === revision ? historyPage.messages : [];
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(true);
  const [activeTurn, setActiveTurn] = useState<string | null>(null);
  const [visibleTurns, setVisibleTurns] = useState<string[]>([]);
  const [scrolledUp, setScrolledUp] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const resetLock = useRef(false);
  const setupAction = useRef(() => {});
  const persistedMessages = [
    ...older.filter((item) => !state.messages.some((message) => message.id === item.id)),
    ...state.messages,
  ];
  const persistedIds = new Set(persistedMessages.map((message) => message.id));
  const acknowledgedIds = useRef(persistedIds);
  acknowledgedIds.current = persistedIds;
  const allMessages = [
    ...persistedMessages,
    ...optimistic
      .filter((item) => item.revision === revision && !persistedIds.has(item.message.id))
      .map((item) => item.message),
  ];
  const working = hasVisibleChatActivity(state.tasks);
  const streamEntries = Object.entries(streams).filter(([, value]) => value);
  const onboardingVisible = allMessages.length === 0 && !working && !resetting;
  useEffect(() => {
    if (stickToBottom.current)
      bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [state.messages, streams, sending, resetting, optimistic]);
  useEffect(() => {
    const ids = new Set(state.messages.map((message) => message.id));
    setOptimistic((current) => {
      const next = current.filter(
        (item) => item.revision === revision && !ids.has(item.message.id),
      );
      return next.length === current.length ? current : next;
    });
  }, [state.messages, revision]);
  useEffect(() => {
    historyVersion.current++;
    setHistoryPage({ revision, messages: [] });
    setLoadingHistory(false);
    setHasEarlier(true);
    setActiveTurn(null);
    setVisibleTurns([]);
    setScrolledUp(false);
    setReplyTo(null);
    setOptimistic([]);
    sendLock.current = null;
    retry.current = null;
    setText('');
    setSending(false);
    setError('');
    stickToBottom.current = true;
  }, [revision]);
  useEffect(() => {
    const restart = () => setupAction.current();
    window.addEventListener('sidekick:restart-setup', restart);
    return () => window.removeEventListener('sidekick:restart-setup', restart);
  }, []);
  useEffect(() => {
    if (!composerDraft) return;
    setText(composerDraft.text);
    requestAnimationFrame(() => composer.current?.focus());
  }, [composerDraft]);
  useEffect(() => {
    const compose = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: unknown }>).detail;
      if (typeof detail?.text !== 'string') return;
      setText(detail.text);
      requestAnimationFrame(() => composer.current?.focus());
    };
    window.addEventListener('sidekick:compose', compose);
    return () => window.removeEventListener('sidekick:compose', compose);
  }, []);
  async function send(value: string, attachments: Artifact[]) {
    if (sendLock.current || resetLock.current) return false;
    const sentRevision = revision;
    const reply = replyTo;
    const signature = JSON.stringify([
      value,
      attachments.map((item) => item.id),
      reply?.id ?? null,
    ]);
    const id =
      retry.current?.revision === sentRevision && retry.current.signature === signature
        ? retry.current.id
        : crypto.randomUUID();
    sendLock.current = { id, revision: sentRevision };
    const message: Message = {
      id,
      role: 'user',
      text: value,
      attachments,
      taskId: null,
      createdAt: new Date().toISOString(),
      ...(reply
        ? {
            replyToMessageId: reply.id,
            replyTo: { id: reply.id, role: reply.role, text: reply.text },
          }
        : {}),
    };
    setOptimistic((current) => [
      ...current.filter((item) => item.message.id !== id),
      { revision: sentRevision, message },
    ]);
    historyVersion.current++;
    setLoadingHistory(false);
    setSending(true);
    setError('');
    setHasEarlier(true);
    stickToBottom.current = true;
    const replyId = reply?.id;
    try {
      const response = await fetch('/api/messages', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationRevision: sentRevision,
          clientMessageId: id,
          text: value,
          attachmentIds: attachments.map((item) => item.id),
          ...(replyId ? { replyToMessageId: replyId } : {}),
        }),
      });
      const result = (await response.json()) as Partial<SubmitMessageResponse> & { error?: string };
      if (!response.ok) {
        throw new Error(result.error || 'The message could not be sent.');
      }
      if (revisionRef.current !== sentRevision) return true;
      if (result.messageId !== id || typeof result.taskId !== 'string')
        throw new Error('The message could not be confirmed. Try sending it again.');
      const taskId = result.taskId;
      retry.current = null;
      setOptimistic((current) =>
        current.map((item) =>
          item.message.id === id ? { ...item, message: { ...item.message, taskId } } : item,
        ),
      );
      setReplyTo((current) => (current?.id === replyId ? null : current));
      void refresh().catch(() => {});
      return true;
    } catch (cause) {
      if (revisionRef.current !== sentRevision) return true;
      if (acknowledgedIds.current.has(id)) {
        retry.current = null;
        setReplyTo((current) => (current?.id === replyId ? null : current));
        return true;
      }
      retry.current = { id, revision: sentRevision, signature };
      setOptimistic((current) => current.filter((item) => item.message.id !== id));
      setError(errorMessage(cause));
      return false;
    } finally {
      if (sendLock.current?.id === id && sendLock.current.revision === sentRevision) {
        sendLock.current = null;
        if (revisionRef.current === sentRevision) setSending(false);
      }
    }
  }
  async function history() {
    const version = ++historyVersion.current;
    setLoadingHistory(true);
    setError('');
    const first = persistedMessages[0];
    const height = scroll.current?.scrollHeight ?? 0;
    try {
      const before = first?.createdAt;
      const query = new URLSearchParams({
        conversationRevision: String(revision),
        ...(before ? { before } : {}),
        ...(first ? { beforeId: first.id } : {}),
      });
      const result = await api<Message[]>(`/api/messages?${query}`);
      if (version !== historyVersion.current || revisionRef.current !== revision) return;
      setHistoryPage((current) => ({
        revision,
        messages: [...result, ...(current.revision === revision ? current.messages : [])],
      }));
      setHasEarlier(result.length === 60);
      requestAnimationFrame(() => {
        if (scroll.current) scroll.current.scrollTop += scroll.current.scrollHeight - height;
      });
    } catch (cause) {
      if (version === historyVersion.current && revisionRef.current === revision)
        setError(errorMessage(cause));
    } finally {
      if (version === historyVersion.current) setLoadingHistory(false);
    }
  }
  function updateActiveTurn() {
    const element = scroll.current;
    if (!element) return;
    const viewport = element.getBoundingClientRect();
    const anchor = viewport.top + Math.min(120, element.clientHeight * 0.25);
    const turns = Array.from(element.querySelectorAll<HTMLElement>('.message-user'));
    const positions = turns.map((turn) => ({
      id: turn.dataset.messageId!,
      top: turn.getBoundingClientRect().top,
    }));
    const visible = visibleConversationTurns(positions, viewport);
    setVisibleTurns((current) =>
      current.length === visible.length && current.every((id, index) => id === visible[index])
        ? current
        : visible,
    );
    const current =
      turns.filter((turn) => turn.getBoundingClientRect().top <= anchor).at(-1) ?? turns[0];
    setActiveTurn(current?.dataset.messageId ?? null);
  }
  useEffect(() => {
    const frame = requestAnimationFrame(updateActiveTurn);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateActiveTurn);
    if (scroll.current) observer?.observe(scroll.current);
    if (scroll.current?.firstElementChild) observer?.observe(scroll.current.firstElementChild);
    window.addEventListener('resize', updateActiveTurn);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', updateActiveTurn);
    };
  }, [state.messages, historyPage, streams, optimistic]);
  async function startOnboarding() {
    if (resetLock.current) return;
    resetLock.current = true;
    setResetting(true);
    setError('');
    try {
      const conversationRevision = await resetConversation();
      revisionRef.current = conversationRevision;
      historyVersion.current++;
      setHistoryPage({ revision: conversationRevision, messages: [] });
      setLoadingHistory(false);
      setReplyTo(null);
      setText('');
      await post('/api/onboarding', {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        conversationRevision,
      });
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      resetLock.current = false;
      setResetting(false);
    }
  }
  setupAction.current = () => void startOnboarding();
  return (
    <div className="chat-page">
      <ChatTurnRail
        messages={allMessages}
        activeId={activeTurn}
        visibleIds={visibleTurns}
        onJump={(id) => {
          const target = Array.from(
            scroll.current?.querySelectorAll<HTMLElement>('.message-user') ?? [],
          ).find((element) => element.dataset.messageId === id);
          if (!target) return;
          stickToBottom.current = false;
          setScrolledUp(true);
          setActiveTurn(id);
          target.scrollIntoView({
            block: 'start',
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
              ? 'instant'
              : 'smooth',
          });
        }}
      />
      <div
        className="conversation-scroll"
        ref={scroll}
        onScroll={() => {
          const element = scroll.current;
          if (element) {
            stickToBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 160;
            setScrolledUp(!stickToBottom.current);
            updateActiveTurn();
          }
        }}
      >
        <div className="conversation-column">
          {persistedMessages.length > 0 && hasEarlier && (
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
          {allMessages.length === 0 && (
            <div className="welcome">
              <BrandMark />
              <h1>What’s on your mind?</h1>
              <div className="starter-actions">
                {['Plan my day', 'Help me research something', 'Start a goal'].map((label) => (
                  <button
                    key={label}
                    onClick={() => {
                      setText(label);
                      composer.current?.focus();
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
                  inspectorEnabled={state.configuration.inspectorEnabled}
                  grouped={messagesAreGrouped(allMessages[index - 1], message)}
                  showTimestamp={!messagesAreGrouped(message, allMessages[index + 1])}
                  onReply={
                    message.taskId || persistedIds.has(message.id)
                      ? () => {
                          setReplyTo(message);
                          composer.current?.focus();
                        }
                      : undefined
                  }
                />
              </Fragment>
            ))}
            {streamEntries.map(([id, value]) => (
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
            {(sending || resetting || working) && streamEntries.length === 0 && (
              <div
                className="thinking"
                role="status"
                aria-label={
                  resetting ? 'Starting setup' : sending ? 'Sending message' : 'Sidekick is typing'
                }
              >
                <div className="assistant-mark">
                  <BrandMark small />
                </div>
                <span className="thinking-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            )}
          </div>
          {onboardingVisible && (
            <section className="onboarding-card">
              <div>
                <h2>Make Sidekick yours.</h2>
                <p>Connect your tools and pick something to work on.</p>
              </div>
              <Button
                variant="outline"
                disabled={sending || resetting}
                onClick={() => window.dispatchEvent(new CustomEvent('sidekick:restart-setup'))}
              >
                Get started
                <ArrowUpRight size={15} />
              </Button>
            </section>
          )}
          <div ref={bottom} />
        </div>
      </div>
      <div className="chat-bottom conversation-column">
        {scrolledUp && (
          <Button
            className="jump-latest"
            variant="outline"
            size="sm"
            onClick={() => {
              historyVersion.current++;
              setLoadingHistory(false);
              setHasEarlier(true);
              stickToBottom.current = true;
              requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: 'end' }));
            }}
          >
            <ArrowDown size={14} />
            Back to latest
          </Button>
        )}
        {error && <Notice>{error}</Notice>}
        {!state.configuration.llmReady && (
          <Notice kind="info">
            The assistant isn’t connected yet. Check the development setup.
          </Notice>
        )}
        <Composer
          key={revision}
          ref={composer}
          ready={state.configuration.llmReady && !resetting}
          sending={sending || resetting}
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
