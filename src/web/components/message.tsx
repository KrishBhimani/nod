import { useRef, useState } from 'react';
import { FileText, Volume2, LoaderCircle, Sparkles, ExternalLink } from 'lucide-react';
import type { Artifact, Message } from '../../shared/contracts';
import { Button, Notice } from './ui';
import { errorMessage, post } from '../lib/api';
import { parseMessageText } from '../lib/message-links';
import { speechParts } from '../lib/speech';

export function MessageText({ text }: { text: string }) {
  const parts = parseMessageText(text, window.location.origin);
  return (
    <div className="message-text">
      {parts.map((part, index) =>
        part.type === 'text' ? (
          <span key={index}>{part.text}</span>
        ) : (
          <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.text}
            {(part.kind === 'credential' || part.kind === 'approval') && <ExternalLink size={13} />}
          </a>
        ),
      )}
    </div>
  );
}

export function Attachment({ artifact }: { artifact: Artifact }) {
  const url = artifact.url.startsWith('/api/artifacts/') ? artifact.url : '';
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
}: {
  message: Message;
  speechReady: boolean;
}) {
  const [audio, setAudio] = useState<Artifact | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState('');
  const [part, setPart] = useState(0);
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
  return (
    <article
      className={`message message-${message.role}`}
      aria-label={message.role === 'user' ? 'You' : 'Sidekick'}
    >
      {message.role === 'assistant' && (
        <div className="assistant-mark">
          <Sparkles size={16} />
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
        {message.role === 'assistant' && parts.length > 0 && speechReady && (
          <Button
            size="icon"
            variant="ghost"
            className="read-aloud"
            onClick={() => void speak()}
            disabled={speaking}
            aria-label="Read this reply aloud"
            title="Read aloud"
          >
            {speaking ? <LoaderCircle size={15} className="spin" /> : <Volume2 size={15} />}
          </Button>
        )}
        {audio && audio.url.startsWith('/api/artifacts/') && (
          <div>
            <audio
              ref={player}
              key={audio.id}
              src={audio.url}
              controls
              autoPlay
              className="audio-attachment"
              aria-label="Spoken reply"
              onEnded={() => {
                if (part + 1 < parts.length) void speak(part + 1);
              }}
            />
            {parts.length > 1 && (
              <small className="speech-part">
                Part {part + 1} of {parts.length}
              </small>
            )}
          </div>
        )}
        {error && <Notice>{error}</Notice>}
      </div>
    </article>
  );
}
