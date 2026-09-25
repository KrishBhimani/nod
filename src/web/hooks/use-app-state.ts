import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { AppState } from '../../shared/contracts';
import { api, errorMessage, post } from '../lib/api';
import { initialStreamState, streamReducer } from '../lib/streams';
import { pageDataCache } from '../lib/page-data-cache';

export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  const [streamState, dispatchStream] = useReducer(streamReducer, initialStreamState);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const requestVersion = useRef(0);
  const conversationRevision = useRef(0);
  const resetRequest = useRef<Promise<number> | null>(null);
  const advanceConversation = useCallback((revision: number) => {
    if (revision <= conversationRevision.current) return;
    conversationRevision.current = revision;
    requestVersion.current++;
    dispatchStream({ type: 'conversation', conversationRevision: revision });
    setState((current) =>
      current
        ? {
            ...current,
            conversationRevision: revision,
            messages: [],
            tasks: current.tasks.map((task) => ({ ...task, showTyping: false })),
          }
        : current,
    );
  }, []);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const next = await api<AppState>('/api/state');
      if (version !== requestVersion.current) return;
      const revision = next.conversationRevision ?? 0;
      if (revision < conversationRevision.current) return;
      advanceConversation(revision);
      dispatchStream({
        type: 'persisted',
        conversationRevision: revision,
        streamIds: next.messages.flatMap((message) => (message.streamId ? [message.streamId] : [])),
      });
      setState(next);
      setError('');
    } catch (cause) {
      if (version === requestVersion.current) setError(errorMessage(cause));
    }
  }, [advanceConversation]);

  const resetConversation = useCallback(() => {
    if (resetRequest.current) return resetRequest.current;
    const request = (async () => {
      requestVersion.current++;
      const result = await post<{ ok: true; conversationRevision: number }>(
        '/api/conversation/reset',
      );
      if (!Number.isSafeInteger(result.conversationRevision) || result.conversationRevision < 0)
        throw new Error('The conversation could not be restarted. Try again.');
      advanceConversation(result.conversationRevision);
      setError('');
      return result.conversationRevision;
    })();
    resetRequest.current = request;
    void request
      .finally(() => {
        if (resetRequest.current === request) resetRequest.current = null;
      })
      .catch(() => {});
    return request;
  }, [advanceConversation]);

  useEffect(() => {
    void refresh();
    const events = new EventSource('/api/events');
    events.onopen = () => {
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
          conversationRevision?: number;
        };
        if (data.type === 'refresh') {
          pageDataCache.revalidateActive();
          void refresh();
        }
        if (
          data.type === 'delta' &&
          typeof data.taskId === 'string' &&
          (typeof data.text === 'string' || data.done === true)
        ) {
          const revision = data.conversationRevision ?? 0;
          if (revision < conversationRevision.current) return;
          if (revision > conversationRevision.current) {
            advanceConversation(revision);
            void refresh();
          }
          dispatchStream({
            type: 'delta',
            conversationRevision: revision,
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
  }, [refresh, advanceConversation]);

  const streams = Object.fromEntries(
    Object.entries(streamState.active).map(([id, stream]) => [id, stream.text]),
  );
  return { state, streams, error, connected, refresh, resetConversation };
}
