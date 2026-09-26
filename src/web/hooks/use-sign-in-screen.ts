import { useEffect, useRef, useState } from 'react';

export function useSignInScreen(path: string, revision: number | null, active: boolean) {
  const session = `${path}:${revision}`;
  const [frame, setFrame] = useState<{ session: string; url: string } | null>(null);
  const [error, setError] = useState('');
  const source = useRef('');
  useEffect(() => {
    let stopped = false;
    let visible = !document.hidden && document.hasFocus();
    let generation = 0;
    let request: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      if (source.current) URL.revokeObjectURL(source.current);
      source.current = '';
      setFrame(null);
    };
    clear();
    setError('');
    if (!active || revision === null) return;
    async function capture() {
      if (stopped || !visible) return;
      const current = ++generation;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const response = await fetch(`${path}/sign-in-screen?revision=${revision}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0] !== 'image/png')
          throw new Error('Workspace screen unavailable.');
        const bytes = await response.blob();
        if (stopped || !visible || controller.signal.aborted || generation !== current) return;
        const next = URL.createObjectURL(bytes);
        const previous = source.current;
        source.current = next;
        setFrame({ session, url: next });
        setError('');
        if (previous) URL.revokeObjectURL(previous);
      } catch {
        if (!stopped && !controller.signal.aborted && generation === current) {
          clear();
          setError('The workspace browser is temporarily unavailable.');
        }
      } finally {
        if (!stopped && visible && generation === current)
          timer = setTimeout(() => void capture(), 1000);
      }
    }
    const hide = () => {
      visible = false;
      generation++;
      request?.abort();
      clearTimeout(timer);
      clear();
    };
    const show = () => {
      if (document.hidden || !document.hasFocus() || stopped) return;
      visible = true;
      clearTimeout(timer);
      void capture();
    };
    const visibility = () => (document.hidden ? hide() : show());
    window.addEventListener('blur', hide);
    window.addEventListener('focus', show);
    document.addEventListener('visibilitychange', visibility);
    void capture();
    return () => {
      stopped = true;
      generation++;
      request?.abort();
      clearTimeout(timer);
      if (source.current) URL.revokeObjectURL(source.current);
      source.current = '';
      window.removeEventListener('blur', hide);
      window.removeEventListener('focus', show);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [path, revision, active, session]);
  return { screen: active && frame?.session === session ? frame.url : null, error };
}
