import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';

export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  const [streams, setStreams] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const knownMessages = useRef(new Set<string>());
  const requestVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const next = await api<AppState>('/api/state');
      if (version !== requestVersion.current) return;
      const completed = new Set(next.messages.filter(message => message.role === 'assistant' && !knownMessages.current.has(message.id)).map(message => message.taskId));
      for (const task of next.tasks) if (!['queued', 'running'].includes(task.status)) completed.add(task.id);
      knownMessages.current = new Set(next.messages.map(message => message.id));
      setStreams(current => Object.fromEntries(Object.entries(current).filter(([id]) => !completed.has(id))));
      setState(next);
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const events = new EventSource('/api/events');
    events.onopen = () => { setConnected(true); void refresh(); };
    events.onerror = () => setConnected(false);
    events.onmessage = event => {
      try {
        const data = JSON.parse(event.data) as { type: string; taskId?: string; text?: string };
        if (data.type === 'refresh') void refresh();
        if (data.type === 'delta' && data.taskId && typeof data.text === 'string') {
          const taskId = data.taskId;
          const text = data.text;
          setStreams(current => ({ ...current, [taskId]: (current[taskId] ?? '') + text }));
        }
      } catch {
        setError('An update could not be read. Refresh the page to reconnect.');
      }
    };
    return () => events.close();
  }, [refresh]);

  return { state, streams, error, connected, refresh };
}
