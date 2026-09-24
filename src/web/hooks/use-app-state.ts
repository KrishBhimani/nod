import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { AppState } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { initialStreamState, streamReducer } from '../lib/streams';

export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  const [streamState, dispatchStream] = useReducer(streamReducer, initialStreamState);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const requestVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const next = await api<AppState>('/api/state');
      if (version !== requestVersion.current) return;
      dispatchStream({
        type: 'persisted',
        streamIds: next.messages.flatMap((message) => (message.streamId ? [message.streamId] : [])),
      });
      setState(next);
      setError('');
    } catch (cause) {
      if (version === requestVersion.current) setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const events = new EventSource('/api/events');
    events.onopen = () => {
      dispatchStream({ type: 'reset' });
      setConnected(true);
      void refresh();
    };
    events.onerror = () => setConnected(false);
    events.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type: string;
          taskId?: string;
          text?: string;
          streamId?: string;
          done?: boolean;
        };
        if (data.type === 'refresh') void refresh();
        if (
          data.type === 'delta' &&
          typeof data.taskId === 'string' &&
          (typeof data.text === 'string' || data.done === true)
        ) {
          dispatchStream({
            type: 'delta',
            taskId: data.taskId,
            text: typeof data.text === 'string' ? data.text : '',
            ...(typeof data.streamId === 'string' ? { streamId: data.streamId } : {}),
            done: data.done === true,
          });
        }
      } catch {
        setError('An update could not be read. Refresh the page to reconnect.');
      }
    };
    return () => events.close();
  }, [refresh]);

  const streams = Object.fromEntries(
    Object.entries(streamState.active).map(([id, stream]) => [id, stream.text]),
  );
  return { state, streams, error, connected, refresh };
}
