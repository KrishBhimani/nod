import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Paperclip,
  X,
  FileText,
  LoaderCircle,
  Bold,
  Italic,
  Code,
  List,
  TextCursorInput,
  Eye,
} from 'lucide-react';
import type { Artifact, Task } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { Button, Notice } from './ui';
import { MessageText } from './message';

interface ComposerProps {
  ready: boolean;
  sending: boolean;
  text: string;
  setText(value: string): void;
  replyTo: Task | null;
  clearReply(): void;
  onSend(text: string, attachments: Artifact[]): Promise<boolean>;
}

export function Composer({
  ready,
  sending,
  text,
  setText,
  replyTo,
  clearReply,
  onSend,
}: ComposerProps) {
  const [attachments, setAttachments] = useState<Artifact[]>([]);
  const [uploading, setUploading] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const uploadLock = useRef(false);
  const sendLock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = 'auto';
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 220)}px`;
    }
  }, [text, preview]);

  async function upload(files: File[]) {
    if (!files.length || uploadLock.current) return;
    if (files.length + attachments.length > 5) {
      setError('Attach up to five files per message.');
      return;
    }
    if (files.some((file) => file.size > 15 * 1024 * 1024)) {
      setError('Each file must be 15 MB or smaller.');
      return;
    }
    uploadLock.current = true;
    setUploading(true);
    setError('');
    try {
      for (const file of files) {
        const body = new FormData();
        body.append('file', file);
        const artifact = await api<Artifact>('/api/uploads', { method: 'POST', body });
        if (mounted.current) setAttachments((current) => [...current, artifact]);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      uploadLock.current = false;
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
      textarea.current?.focus();
    }
  }
  function format(before: string, after = before) {
    const field = textarea.current;
    if (!field) return;
    const start = field.selectionStart,
      end = field.selectionEnd;
    const selected = text.slice(start, end) || 'text';
    setText(text.slice(0, start) + before + selected + after + text.slice(end));
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  }
  async function submit() {
    if (
      !ready ||
      sending ||
      sendLock.current ||
      uploadLock.current ||
      (!text.trim() && !attachments.length)
    )
      return;
    sendLock.current = true;
    const sentText = text;
    const sentAttachments = attachments;
    setText('');
    setAttachments([]);
    setPreview(false);
    textarea.current?.focus();
    try {
      if (!(await onSend(sentText.trim(), sentAttachments))) {
        setText(textarea.current?.value ? `${sentText}\n${textarea.current.value}` : sentText);
        setAttachments((current) => [...sentAttachments, ...current]);
      }
    } finally {
      sendLock.current = false;
      textarea.current?.focus();
    }
  }
  return (
    <div className="composer-wrap">
      {error && <Notice>{error}</Notice>}
      {replyTo && (
        <div className="reply-context">
          <span>
            Replying to <strong>{replyTo.title}</strong>
          </span>
          <Button variant="ghost" size="icon" onClick={clearReply} aria-label="Clear task reply">
            <X size={14} />
          </Button>
        </div>
      )}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void upload(Array.from(event.dataTransfer.files));
        }}
      >
        {attachments.length > 0 && (
          <div className="pending-attachments">
            {attachments.map((artifact) => (
              <div className="pending-attachment" key={artifact.id}>
                {artifact.mimeType.startsWith('image/') ? (
                  <img src={artifact.url} alt="" />
                ) : (
                  <FileText size={16} />
                )}
                <span>{artifact.name}</span>
                <button
                  type="button"
                  onClick={() =>
                    setAttachments((current) => current.filter((item) => item.id !== artifact.id))
                  }
                  aria-label={`Remove ${artifact.name}`}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        {formatting && (
          <div className="format-toolbar" aria-label="Text formatting">
            {[
              [Bold, 'Bold', '**', '**'],
              [Italic, 'Italic', '_', '_'],
              [Code, 'Code', '`', '`'],
              [List, 'List', '- ', ''],
            ].map(([Icon, label, before, after]) => {
              const Glyph = Icon as typeof Bold;
              return (
                <Button
                  key={String(label)}
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={String(label)}
                  onClick={() => format(String(before), String(after))}
                  disabled={preview}
                >
                  <Glyph size={15} />
                </Button>
              );
            })}
            <Button type="button" variant="ghost" size="sm" onClick={() => setPreview(!preview)}>
              <Eye size={14} />
              {preview ? 'Edit' : 'Preview'}
            </Button>
          </div>
        )}
        {preview ? (
          <div className="composer-preview">
            <MessageText text={text || 'Nothing to preview yet.'} />
          </div>
        ) : (
          <textarea
            ref={textarea}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onPaste={(event) => {
              const images = Array.from(event.clipboardData.items)
                .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
                .map((item) => item.getAsFile())
                .filter((file): file is File => Boolean(file));
              if (images.length) {
                event.preventDefault();
                void upload(images);
              }
            }}
            onKeyDown={(event) => {
              if (
                (event.metaKey || event.ctrlKey) &&
                ['b', 'i'].includes(event.key.toLowerCase())
              ) {
                event.preventDefault();
                format(event.key.toLowerCase() === 'b' ? '**' : '_');
              } else if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="Message Sidekick…"
            aria-label="Message Sidekick"
            rows={1}
          />
        )}
        <div className="composer-tools">
          <div className="composer-left">
            <input
              ref={fileInput}
              type="file"
              tabIndex={-1}
              multiple
              className="sr-only"
              aria-label="Attach files"
              onChange={(event) => void upload(Array.from(event.target.files ?? []))}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Attach files"
              title="Attach files or paste an image"
              onClick={() => fileInput.current?.click()}
              disabled={uploading || attachments.length >= 5}
            >
              {uploading ? <LoaderCircle size={18} className="spin" /> : <Paperclip size={18} />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Format message"
              aria-expanded={formatting}
              onClick={() => {
                setFormatting(!formatting);
                setPreview(false);
              }}
            >
              <TextCursorInput size={18} />
            </Button>
          </div>
          <Button
            type="submit"
            size="icon"
            className="send-button"
            aria-label="Send message"
            disabled={!ready || sending || uploading || (!text.trim() && !attachments.length)}
          >
            {sending ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={19} />}
          </Button>
        </div>
      </form>
    </div>
  );
}
