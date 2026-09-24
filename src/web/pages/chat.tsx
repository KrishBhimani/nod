import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Sparkles, SlidersHorizontal } from 'lucide-react';
import type { AppState, Artifact, Task } from '../../shared/contracts';
import { Composer } from '../components/composer';
import { MessageBubble, MessageText } from '../components/message';
import { TaskList } from '../components/task-list';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Notice,
} from '../components/ui';
import { errorMessage, post } from '../lib/api';

export function Chat({
  state,
  streams,
  refresh,
}: {
  state: AppState;
  streams: Record<string, string>;
  refresh(): Promise<void>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [replyTo, setReplyTo] = useState<Task | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const hasConversation = state.messages.length > 0 || Object.keys(streams).length > 0;

  useEffect(() => {
    if (stickToBottom.current)
      bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [state.messages, streams]);

  async function send(value: string, attachments: Artifact[]) {
    setSending(true);
    setError('');
    stickToBottom.current = true;
    try {
      await post('/api/messages', {
        text: value,
        attachmentIds: attachments.map((artifact) => artifact.id),
        ...(replyTo ? { taskId: replyTo.id } : {}),
      });
      setReplyTo(null);
      await refresh();
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chat-page">
      <header className="chat-header">
        <div>
          <h1>Your conversation</h1>
          <span>A place to think and get things done.</span>
        </div>
      </header>
      <div
        className="conversation-scroll"
        ref={scroll}
        onScroll={() => {
          const element = scroll.current;
          if (element)
            stickToBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 160;
        }}
      >
        <div className="conversation-column">
          <TaskList
            tasks={state.tasks}
            onContinue={(task) => {
              setReplyTo(task);
              document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
            }}
            onRefresh={refresh}
          />
          {!hasConversation ? (
            <div className="welcome">
              <div className="welcome-mark">
                <Sparkles size={27} strokeWidth={1.5} />
              </div>
              <h2>A little less on your plate.</h2>
              <p>
                Bring a question, a plan, or a task.
                <br />
                We’ll take it from here, together.
              </p>
              <div className="starter-actions">
                <button onClick={() => setText('Help me plan my day.')}>
                  <span>Make a plan</span>
                  <ArrowUpRight size={15} />
                </button>
                <button onClick={() => setText('Help me research ')}>
                  <span>Look into something</span>
                  <ArrowUpRight size={15} />
                </button>
                <button
                  onClick={() =>
                    document.querySelector<HTMLInputElement>('input[type=file]')?.click()
                  }
                >
                  <span>Work with a file</span>
                  <ArrowUpRight size={15} />
                </button>
              </div>
            </div>
          ) : (
            <div
              className="messages"
              role="log"
              aria-label="Conversation"
              aria-live="polite"
              aria-relevant="additions"
            >
              {state.messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  speechReady={state.configuration.speechReady}
                />
              ))}
              {Object.entries(streams)
                .filter(([, value]) => value)
                .map(([id, value]) => (
                  <article
                    className="message message-assistant streaming-message"
                    key={id}
                    aria-label="Sidekick is responding"
                  >
                    <div className="assistant-mark">
                      <Sparkles size={16} />
                    </div>
                    <div className="message-content">
                      <MessageText text={value} />
                      <span className="stream-cursor" />
                    </div>
                  </article>
                ))}
            </div>
          )}
          <div ref={bottom} />
        </div>
      </div>
      <div className="chat-bottom conversation-column">
        {!state.configuration.llmReady && (
          <div className="setup-note">
            <SlidersHorizontal size={16} />
            <span>Connect a model to start your first conversation.</span>
            <Button variant="ghost" size="sm" onClick={() => setSetupOpen(true)}>
              Set up
            </Button>
          </div>
        )}
        {error && <Notice>{error}</Notice>}
        <Composer
          ready={state.configuration.llmReady}
          speechReady={state.configuration.speechReady}
          sending={sending}
          text={text}
          setText={setText}
          replyTo={replyTo}
          clearReply={() => setReplyTo(null)}
          onSend={send}
        />
      </div>
      <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
        <DialogContent>
          <div className="dialog-heading">
            <SlidersHorizontal size={22} />
            <DialogTitle>Connect your model</DialogTitle>
            <DialogDescription>
              Sidekick uses your own OpenAI or Anthropic account.
            </DialogDescription>
          </div>
          <p className="setup-instructions">
            Add your provider’s API key to the local <code>.env</code> file, then restart Sidekick.
            Your key stays on the server.
          </p>
          <Button onClick={() => setSetupOpen(false)}>Got it</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
