import { memo, useRef, useState } from 'react';
import {
  FileText,
  Volume2,
  LoaderCircle,
  ExternalLink,
  Copy,
  Check,
  Heart,
  ThumbsUp,
  ThumbsDown,
  MoreHorizontal,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import type { Artifact, Message } from '../../shared/contracts';
import { Button, Notice } from './ui';
import { BrandMark } from './brand';
import { errorMessage, post } from '../lib/api';
import { safeMessageLink } from '../lib/message-links';
import { remarkLocalLinks } from '../lib/markdown';
import { speechParts } from '../lib/speech';

export const MessageText = memo(function MessageText({ text }: { text: string }) {
  return (
    <div className="message-text">
      <Markdown
        remarkPlugins={[remarkGfm, remarkLocalLinks]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={{
          a: ({ href, children }) => {
            const link = safeMessageLink(
              href ?? '',
              typeof window === 'undefined' ? 'http://localhost:4310' : window.location.origin,
            );
            if (!link) return <span>{children}</span>;
            const label =
              link.kind === 'credential'
                ? 'Continue securely'
                : link.kind === 'approval'
                  ? 'Review action'
                  : children;
            return (
              <a href={link.href} target="_blank" rel="noopener noreferrer">
                {label}
                {['credential', 'approval'].includes(link.kind) && <ExternalLink size={12} />}
              </a>
            );
          },
          img: ({ src, alt }) =>
            typeof src === 'string' && /^\/api\/artifacts\/[a-f0-9-]+$/.test(src) ? (
              <img src={src} alt={alt ?? ''} loading="lazy" />
            ) : (
              <span>{alt || 'Image'}</span>
            ),
          input: ({ checked }) => (
            <input type="checkbox" checked={checked ?? false} readOnly disabled />
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});

export function Attachment({ artifact }: { artifact: Artifact }) {
  const url = /^\/api\/artifacts\/[a-f0-9-]+$/.test(artifact.url) ? artifact.url : '';
  if (!url) return null;
  if (artifact.mimeType.startsWith('image/'))
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="image-attachment">
        <img src={url} alt={artifact.name} loading="lazy" />
      </a>
    );
  if (artifact.mimeType.startsWith('audio/'))
    return <audio className="audio-attachment" controls src={url} aria-label={artifact.name} />;
  return (
    <a className="file-attachment" href={url} target="_blank" rel="noopener noreferrer">
      <FileText size={18} />
      <span>
        {artifact.name}
        <small>{Math.max(1, Math.round(artifact.size / 1024))} KB</small>
      </span>
    </a>
  );
}

export function MessageBubble({
  message,
  speechReady,
  onReply,
}: {
  message: Message;
  speechReady: boolean;
  onReply?(): void;
}) {
  const [audio, setAudio] = useState<Artifact | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState('');
  const [part, setPart] = useState(0);
  const [copied, setCopied] = useState(false);
  const [reaction, setReaction] = useState(message.reaction ?? null);
  const [reacting, setReacting] = useState(false);
  const requestVersion = useRef(0);
  const player = useRef<HTMLAudioElement>(null);
  const parts = speechParts(message.text);
  async function speak(index = 0) {
    if (!parts[index]) return;
    player.current?.pause();
    const version = ++requestVersion.current;
    setSpeaking(true);
    setError('');
    try {
      const artifact = await post<Artifact>('/api/speech/speak', { text: parts[index] });
      if (version === requestVersion.current) {
        setPart(index);
        setAudio(artifact);
      }
    } catch (cause) {
      if (version === requestVersion.current) setError(errorMessage(cause));
    } finally {
      if (version === requestVersion.current) setSpeaking(false);
    }
  }
  async function react(value: NonNullable<Message['reaction']>) {
    if (reacting) return;
    const next = reaction === value ? null : value;
    setReacting(true);
    setError('');
    try {
      await post(`/api/messages/${message.id}/reaction`, { reaction: next });
      setReaction(next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setReacting(false);
    }
  }
  const sent = new Date(message.createdAt);
  return (
    <article
      className={`message message-${message.role}`}
      aria-label={message.role === 'user' ? 'You' : 'Sidekick'}
      data-message-id={message.id}
    >
      {message.role === 'assistant' && (
        <div className="assistant-mark">
          <BrandMark small />
        </div>
      )}
      <div className="message-content">
        {message.attachments.length > 0 && (
          <div className="message-attachments">
            {message.attachments.map((artifact) => (
              <Attachment key={artifact.id} artifact={artifact} />
            ))}
          </div>
        )}
        <MessageText text={message.text} />
        <div className="message-meta">
          <time dateTime={message.createdAt} title={sent.toLocaleString()}>
            {sent.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
          {reaction && (
            <button
              className="selected-reaction"
              onClick={() => void react(reaction)}
              aria-label={`Remove ${reaction} reaction`}
            >
              {reaction === 'heart' ? (
                <Heart size={13} fill="currentColor" />
              ) : reaction === 'like' ? (
                <ThumbsUp size={13} />
              ) : (
                <ThumbsDown size={13} />
              )}
            </button>
          )}
          <div className="message-actions">
            {message.role === 'assistant' && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Helpful reply"
                  aria-pressed={reaction === 'like'}
                  disabled={reacting}
                  onClick={() => void react('like')}
                >
                  <ThumbsUp size={14} />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Unhelpful reply"
                  aria-pressed={reaction === 'dislike'}
                  disabled={reacting}
                  onClick={() => void react('dislike')}
                >
                  <ThumbsDown size={14} />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Love reply"
                  aria-pressed={reaction === 'heart'}
                  disabled={reacting}
                  onClick={() => void react('heart')}
                >
                  <Heart size={14} />
                </Button>
              </>
            )}
            <Button
              size="icon"
              variant="ghost"
              aria-label="Copy message"
              onClick={() =>
                void navigator.clipboard
                  .writeText(message.text)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  })
                  .catch(() => setError('The message could not be copied.'))
              }
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </Button>
            <details className="message-more">
              <summary aria-label="More message options">
                <MoreHorizontal size={16} />
              </summary>
              <div className="message-menu">
                {onReply && <button onClick={onReply}>Reply to this task</button>}
                {message.role === 'assistant' && speechReady && (
                  <button onClick={() => void speak()} disabled={speaking}>
                    {speaking ? <LoaderCircle className="spin" size={14} /> : <Volume2 size={14} />}
                    Read aloud
                  </button>
                )}
                <span>{sent.toLocaleString()}</span>
              </div>
            </details>
          </div>
        </div>
        {audio && (
          <audio
            ref={player}
            controls
            autoPlay
            src={audio.url}
            className="audio-attachment"
            aria-label="Read aloud"
            onEnded={() => {
              if (part + 1 < parts.length) void speak(part + 1);
            }}
          />
        )}
        {error && <Notice>{error}</Notice>}
      </div>
    </article>
  );
}
