import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Paperclip, Mic, Square, X, FileText, LoaderCircle } from 'lucide-react';
import type { Artifact, Task } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { Button, Notice } from './ui';

interface ComposerProps {
  ready: boolean;
  speechReady: boolean;
  sending: boolean;
  text: string;
  setText(value: string): void;
  replyTo: Task | null;
  clearReply(): void;
  onSend(text: string, attachments: Artifact[]): Promise<boolean>;
}

export function Composer({ ready, speechReady, sending, text, setText, replyTo, clearReply, onSend }: ComposerProps) {
  const [attachments, setAttachments] = useState<Artifact[]>([]);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const mediaStream = useRef<MediaStream | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (recorder.current?.state === 'recording') recorder.current.stop(); mediaStream.current?.getTracks().forEach(track => track.stop()); };
  }, []);
  useEffect(() => {
    if (textarea.current) { textarea.current.style.height = 'auto'; textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 180)}px`; }
  }, [text]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError('');
    try {
      const uploaded: Artifact[] = [];
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append('file', file);
        uploaded.push(await api<Artifact>('/api/uploads', { method: 'POST', body }));
      }
      setAttachments(current => [...current, ...uploaded]);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  }

  async function startRecording() {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('Audio recording is not available in this browser. You can attach an audio file.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) { stream.getTracks().forEach(track => track.stop()); return; }
      mediaStream.current = stream;
      const mimeType = ['audio/webm', 'audio/mp4', 'audio/ogg'].find(type => MediaRecorder.isTypeSupported(type));
      const next = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];
      next.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      next.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        if (!mounted.current) return;
        setRecording(false);
        setTranscribing(true);
        try {
          const type = next.mimeType || 'audio/webm';
          const body = new FormData();
          body.append('audio', new Blob(chunks, { type }), `recording.${type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm'}`);
          const result = await api<{ text: string }>('/api/speech/transcribe', { method: 'POST', body });
          if (mounted.current) setText([textarea.current?.value ?? '', result.text].filter(Boolean).join(' '));
        } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
        finally { if (mounted.current) setTranscribing(false); }
      };
      recorder.current = next;
      next.start();
      setRecording(true);
    } catch { setError('Microphone access is unavailable. Allow it in your browser settings and try again.'); }
  }

  async function submit() {
    if (!ready || sending || uploading || recording || transcribing || (!text.trim() && !attachments.length)) return;
    if (await onSend(text.trim(), attachments)) { setText(''); setAttachments([]); textarea.current?.focus(); }
  }

  return <div className="composer-wrap">
    {error && <Notice>{error}</Notice>}
    {replyTo && <div className="reply-context"><span>Continuing <strong>{replyTo.title}</strong></span><Button variant="ghost" size="icon" onClick={clearReply} aria-label="Start a separate task"><X size={14} /></Button></div>}
    <form className="composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {attachments.length > 0 && <div className="pending-attachments">{attachments.map(artifact => <div className="pending-attachment" key={artifact.id}>{artifact.mimeType.startsWith('image/') ? <img src={artifact.url} alt="" /> : <FileText size={16} />}<span>{artifact.name}</span><button type="button" onClick={() => setAttachments(current => current.filter(item => item.id !== artifact.id))} aria-label={`Remove ${artifact.name}`}><X size={13} /></button></div>)}</div>}
      <textarea ref={textarea} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} placeholder={replyTo ? 'Add what this task needs…' : 'Ask anything, or give me something to do…'} aria-label="Message Sidekick" rows={2} disabled={sending} />
      <div className="composer-tools">
        <div className="composer-left">
          <input ref={fileInput} type="file" multiple className="sr-only" aria-label="Attach files" onChange={event => void upload(event.target.files)} />
          <Button type="button" variant="ghost" size="icon" aria-label="Attach files" title="Attach files or images" onClick={() => fileInput.current?.click()} disabled={uploading || sending}>{uploading ? <LoaderCircle size={18} className="spin" /> : <Paperclip size={18} />}</Button>
          <Button type="button" variant="ghost" size="icon" className={recording ? 'recording' : ''} aria-label={recording ? 'Stop recording' : 'Record a voice message'} title={speechReady ? 'Record a voice message' : 'Voice needs an OpenAI API key'} disabled={!speechReady || transcribing || sending} onClick={() => recording ? recorder.current?.stop() : void startRecording()}>{transcribing ? <LoaderCircle size={18} className="spin" /> : recording ? <Square size={16} fill="currentColor" /> : <Mic size={18} />}</Button>
          {recording ? <span className="composer-hint recording">Recording…</span> : transcribing ? <span className="composer-hint">Transcribing…</span> : <span className="composer-hint">Files, images, or a thought</span>}
        </div>
        <Button type="submit" size="icon" className="send-button" aria-label="Send message" disabled={!ready || sending || uploading || recording || transcribing || (!text.trim() && !attachments.length)}>{sending ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={20} />}</Button>
      </div>
    </form>
  </div>;
}
