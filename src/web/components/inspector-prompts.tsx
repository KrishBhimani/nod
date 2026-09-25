import { useEffect, useState } from 'react';
import { ChevronDown, Copy, Check } from 'lucide-react';
import type { InspectorPromptsResponse } from '../../shared/inspector-prompts';
import { api, errorMessage } from '../lib/api';
import { Button, Notice } from './ui';
import { compactActivityText } from '../lib/inspector-observations';

function PromptText({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <details className="inspector-prompt-text">
      <summary>
        {label}
        <span>{text.length.toLocaleString()} characters</span>
      </summary>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          void navigator.clipboard
            .writeText(text)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copied' : `Copy ${label.toLowerCase()}`}
      </Button>
      <pre>{text}</pre>
    </details>
  );
}

export function InspectorPrompts({ taskId }: { taskId?: string }) {
  const [data, setData] = useState<InspectorPromptsResponse | null>(null);
  const [error, setError] = useState('');
  const [older, setOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => {
    if (older) return;
    let stopped = false;
    const controller = new AbortController();
    async function refresh() {
      try {
        const next = await api<InspectorPromptsResponse>(
          '/api/inspector/prompts' + (taskId ? '?taskId=' + encodeURIComponent(taskId) : ''),
          { signal: controller.signal },
        );
        if (stopped) return;
        setData(next);
        setError('');
      } catch (cause) {
        if (!stopped) setError(errorMessage(cause));
      }
    }
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [taskId, older]);
  async function loadEarlier() {
    if (!data?.nextBefore || !data.nextBeforeId || loadingOlder) return;
    setLoadingOlder(true);
    setOlder(true);
    try {
      const params = new URLSearchParams({
        before: data.nextBefore,
        beforeId: data.nextBeforeId,
        ...(taskId ? { taskId } : {}),
      });
      const next = await api<InspectorPromptsResponse>('/api/inspector/prompts?' + params);
      setOlder(true);
      setData((current) => ({
        ...next,
        prompts: [
          ...new Map(
            [...(current?.prompts ?? []), ...next.prompts].map((prompt) => [prompt.id, prompt]),
          ).values(),
        ],
      }));
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingOlder(false);
    }
  }
  return (
    <div className="inspector-prompts">
      <p className="inspector-data-note">
        Effective instructions and context. Private, redacted, retained for seven days.
      </p>
      {error && <Notice>{error}</Notice>}
      {older && (
        <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={() => setOlder(false)}>
          Back to latest prompts
        </Button>
      )}
      {Boolean(data?.dropped) && (
        <Notice kind="info">Some prompt snapshots could not be recorded.</Notice>
      )}
      {data?.prompts.length === 0 && (
        <p className="muted">Prompts appear when the agent next runs.</p>
      )}
      {data?.prompts.map((prompt) => (
        <details className="inspector-prompt" key={prompt.id}>
          <summary>
            <ChevronDown size={14} />
            <span>
              <strong>{compactActivityText(prompt.title, 90)}</strong>
              <small>
                {new Date(prompt.createdAt).toLocaleString()} · {prompt.provider} / {prompt.model}
              </small>
            </span>
          </summary>
          <div className="inspector-prompt-body">
            <p className="inspector-data-note">
              {prompt.resumed
                ? 'Continued session. The provider also receives its saved transcript.'
                : 'New session.'}{' '}
              {prompt.imageCount
                ? `${prompt.imageCount} attached images; image bytes are omitted.`
                : ''}
            </p>
            <PromptText label="System instructions" text={prompt.system} />
            <PromptText label="Latest instruction" text={prompt.instruction} />
          </div>
        </details>
      ))}
      {data?.hasOlder && (
        <Button
          variant="ghost"
          size="sm"
          disabled={loadingOlder}
          onClick={() => void loadEarlier()}
        >
          Load earlier prompts
        </Button>
      )}
    </div>
  );
}
