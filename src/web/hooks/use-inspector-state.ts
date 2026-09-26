import { useEffect, useState } from 'react';
import type { Artifact, InspectorState } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';

export type InspectorDetail = InspectorState & { artifacts?: (Artifact & { taskId: string })[] };

export type BrowserDetail = { currentBrowser?: InspectorDetail['currentBrowser'] | null };

function useBrowserSnapshot<T extends BrowserDetail>(path: string, enabled: boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setData(null);
    setError('');
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await api<T>(path, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setData(next);
          setError('');
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setData(null);
          setError(errorMessage(cause));
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 2500);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, path]);
  function browserStopped(taskId: string) {
    setData((current) =>
      current?.currentBrowser?.taskId === taskId
        ? {
            ...current,
            currentBrowser: { ...current.currentBrowser, status: 'cancelled' },
          }
        : current,
    );
  }
  return { data, error, browserStopped };
}

export function useInspectorState(enabled = true) {
  return useBrowserSnapshot<InspectorDetail>('/api/inspector', enabled);
}

export function useBrowserState() {
  return useBrowserSnapshot<BrowserDetail>('/api/browser', true);
}
