import { useEffect, useRef } from 'react';
import {
  browserInputSchema,
  browserKeySchema,
  type BrowserInput,
} from '../../shared/browser-input';
import { api } from '../lib/api';

export function useBrowserInput(options: {
  path: string;
  session: number | null;
  enabled: boolean;
  onError(message: string): void;
  onExit(): void;
}) {
  const surface = useRef<HTMLTextAreaElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const latest = useRef(options);
  const rejected = useRef<string | null>(null);
  latest.current = options;
  const flush = useRef<() => Promise<boolean>>(async () => true);
  useEffect(() => {
    const element = surface.current;
    if (!element || !options.enabled || options.session === null) return;
    const queue: BrowserInput[] = [];
    const session = `${options.path}:${options.session}`;
    let stopped = false;
    let generation = 0;
    let composing = false;
    let committed = '';
    let sending: Promise<boolean> | undefined;
    const focused = () =>
      !stopped &&
      rejected.current !== session &&
      !document.hidden &&
      document.hasFocus() &&
      document.activeElement === element;
    const clear = () => {
      element.value = '';
      composing = false;
      committed = '';
    };
    const discard = () => {
      generation++;
      queue.length = 0;
      clear();
    };
    const report = () =>
      latest.current.onError(
        'Browser input stopped. Finish this session, then take control again.',
      );
    function drain(): Promise<boolean> {
      if (sending) return sending;
      const version = generation;
      sending = (async () => {
        while (!stopped && version === generation && queue.length) {
          if (rejected.current === session) {
            discard();
            return false;
          }
          const input = queue.shift()!;
          try {
            const result = await api<{ ok: boolean }>(`${options.path}/input`, {
              method: 'POST',
              body: JSON.stringify({ input }),
              signal: AbortSignal.timeout(15_000),
            });
            if (!result.ok) throw new Error();
          } catch {
            if (
              latest.current.path === options.path &&
              latest.current.session === options.session
            ) {
              discard();
              rejected.current = session;
              report();
            }
            return false;
          }
        }
        return !stopped && version === generation;
      })().finally(() => {
        sending = undefined;
        if (!stopped && queue.length) void drain();
      });
      return sending;
    }
    flush.current = drain;
    function send(input: BrowserInput) {
      if (!focused()) return;
      if (!browserInputSchema.safeParse(input).success) {
        latest.current.onError('This input is too large or unsupported. Try a shorter value.');
        return;
      }
      const previous = queue.at(-1);
      if (
        input.action === 'type' &&
        previous?.action === 'type' &&
        previous.text.length + input.text.length <= 8192
      )
        previous.text += input.text;
      else if (input.action === 'wheel' && previous?.action === 'wheel') {
        previous.deltaX = Math.max(-2000, Math.min(2000, previous.deltaX + input.deltaX));
        previous.deltaY = Math.max(-2000, Math.min(2000, previous.deltaY + input.deltaY));
      } else if (queue.length < 64) queue.push(input);
      else {
        discard();
        rejected.current = session;
        report();
        return;
      }
      void drain();
    }
    const type = (text: string) => {
      if (text) send({ action: 'type', text });
    };
    const keydown = (event: KeyboardEvent) => {
      if (!focused()) return;
      event.stopPropagation();
      if (
        event.isComposing ||
        composing ||
        event.key === 'Process' ||
        event.key === 'Dead' ||
        event.keyCode === 229
      )
        return;
      committed = '';
      if (event.key === 'Escape' && event.shiftKey) {
        event.preventDefault();
        clear();
        latest.current.onExit();
        return;
      }
      const shortcut =
        (event.ctrlKey || event.metaKey || event.altKey) && !event.getModifierState('AltGraph');
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v')
        return;
      if (event.key.length === 1 && !shortcut) return;
      const key = browserKeySchema.safeParse(
        event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toLowerCase() : event.key,
      );
      if (!key.success) return;
      event.preventDefault();
      const modifiers: Array<'Control' | 'Alt' | 'Shift'> = [];
      if (event.ctrlKey || event.metaKey) modifiers.push('Control');
      if (event.altKey) modifiers.push('Alt');
      if (event.shiftKey) modifiers.push('Shift');
      send({ action: 'press', key: key.data, ...(modifiers.length ? { modifiers } : {}) });
    };
    const beforeinput = (event: InputEvent) => {
      if (
        !focused() ||
        composing ||
        event.isComposing ||
        event.inputType === 'insertCompositionText'
      )
        return;
      const text = event.data;
      if (event.inputType.startsWith('insert') && text !== null) {
        event.preventDefault();
        if (text !== committed) type(text);
        committed = '';
        clear();
      } else {
        const keys: Record<string, 'Backspace' | 'Delete' | 'Enter'> = {
          deleteContentBackward: 'Backspace',
          deleteContentForward: 'Delete',
          insertLineBreak: 'Enter',
          insertParagraph: 'Enter',
        };
        const key = keys[event.inputType];
        if (key) {
          event.preventDefault();
          send({ action: 'press', key });
        }
      }
    };
    const input = (event: Event) => {
      if (composing || (event as InputEvent).isComposing) return;
      const text = element.value;
      element.value = '';
      if (!focused()) return;
      if (text !== committed) type(text);
      committed = '';
    };
    const compositionstart = () => {
      if (!focused()) return;
      composing = true;
      committed = '';
    };
    const compositionend = (event: CompositionEvent) => {
      if (!focused()) return clear();
      composing = false;
      committed = event.data;
      element.value = '';
      type(committed);
    };
    const paste = (event: ClipboardEvent) => {
      if (!focused()) return;
      event.preventDefault();
      event.stopPropagation();
      clear();
      type(event.clipboardData?.getData('text/plain') ?? '');
    };
    const click = (event: MouseEvent) => {
      if (!focused() || event.detail === 0) return;
      const target = image.current;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const ratio =
        target.naturalWidth && target.naturalHeight
          ? target.naturalWidth / target.naturalHeight
          : rect.width / rect.height;
      const width = Math.min(rect.width, rect.height * ratio);
      const height = width / ratio;
      if (!(width > 0 && height > 0)) return;
      const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
      const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      send({ action: 'click', x, y });
    };
    const wheel = (event: WheelEvent) => {
      if (!focused()) return;
      event.preventDefault();
      event.stopPropagation();
      const scale =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight || 800 : 1;
      const clamp = (value: number) => Math.max(-2000, Math.min(2000, Math.round(value * scale)));
      send({ action: 'wheel', deltaX: clamp(event.deltaX), deltaY: clamp(event.deltaY) });
    };
    const visibility = () => {
      if (document.hidden) discard();
    };
    element.addEventListener('keydown', keydown);
    element.addEventListener('beforeinput', beforeinput);
    element.addEventListener('input', input);
    element.addEventListener('compositionstart', compositionstart);
    element.addEventListener('compositionend', compositionend);
    element.addEventListener('paste', paste);
    element.addEventListener('click', click);
    element.addEventListener('wheel', wheel, { passive: false });
    element.addEventListener('blur', clear);
    window.addEventListener('blur', discard);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      stopped = true;
      discard();
      flush.current = async () => true;
      element.removeEventListener('keydown', keydown);
      element.removeEventListener('beforeinput', beforeinput);
      element.removeEventListener('input', input);
      element.removeEventListener('compositionstart', compositionstart);
      element.removeEventListener('compositionend', compositionend);
      element.removeEventListener('paste', paste);
      element.removeEventListener('click', click);
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('blur', clear);
      window.removeEventListener('blur', discard);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [options.path, options.session, options.enabled]);
  return { surface, image, flush: () => flush.current() };
}
