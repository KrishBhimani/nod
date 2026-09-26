import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Hand, Maximize2, Monitor, Play } from 'lucide-react';
import { api, post, errorMessage } from '../lib/api';
import { Button, Notice } from './ui';
import { useSignInScreen } from '../hooks/use-sign-in-screen';
import { useBrowserInput } from '../hooks/use-browser-input';

interface ControlState {
  paused: boolean;
  active: boolean;
  revision: number | null;
  mode: 'manual' | 'sign_in' | null;
  signInAvailable: boolean;
  resumable?: boolean;
}
const initialState: ControlState = {
  paused: false,
  active: false,
  revision: null,
  mode: null,
  signInAvailable: false,
};

export function BrowserControl({
  taskId,
  screen,
  emptyMessage,
  live,
  onEnlarge,
  actions,
  onControlChange,
}: {
  taskId?: string;
  screen: string | null;
  emptyMessage: string;
  live: boolean;
  onEnlarge(): void;
  actions?: ReactNode;
  onControlChange?(active: boolean, privateView: boolean): void;
}) {
  const path = `/api/browser/control/${encodeURIComponent(taskId ?? 'workspace')}`;
  const [control, setControl] = useState({ path, value: initialState });
  const state = control.path === path ? control.value : initialState;
  const setState = (value: ControlState | ((previous: ControlState) => ControlState)) => {
    setControl((current) => ({
      path,
      value:
        typeof value === 'function'
          ? value(current.path === path ? current.value : initialState)
          : value,
    }));
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controls = useRef<HTMLDivElement>(null);
  const inputHint = useId();
  const signingIn = state.active && state.mode === 'sign_in';
  const resumable = Boolean(taskId) && state.resumable !== false;
  const operation = useRef(0);
  const busyRef = useRef(false);
  const signIn = useSignInScreen(path, state.revision, signingIn);
  const currentScreen = signingIn ? signIn.screen : screen;
  const currentLive = signingIn ? Boolean(signIn.screen) : live;
  const canInteract = Boolean(currentScreen) && currentLive && !busy;
  const input = useBrowserInput({
    path,
    revision: state.revision,
    enabled: state.active && canInteract,
    onError: setError,
    onExit: () => controls.current?.querySelector('button')?.focus(),
  });
  const placeholder = signingIn ? signIn.error || 'Opening the workspace browser…' : emptyMessage;
  useEffect(() => {
    onControlChange?.(state.active || busy, signingIn || (busy && !state.active));
  }, [state.active, signingIn, busy, onControlChange]);
  useEffect(() => {
    let stopped = false;
    operation.current++;
    busyRef.current = false;
    setBusy(false);
    setState({ paused: false, active: false, revision: null, mode: null, signInAvailable: false });
    setError('');
    const refresh = () => {
      if (busyRef.current) return;
      const version = operation.current;
      void api<ControlState>(path)
        .then((value) => {
          if (!stopped && operation.current === version) setState(value);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 2500);
    return () => {
      stopped = true;
      operation.current++;
      clearInterval(timer);
    };
  }, [path]);
  async function action(kind: 'start' | 'resume') {
    if (busyRef.current) return;
    busyRef.current = true;
    const version = ++operation.current;
    if (kind === 'resume' && !(await input.flush())) {
      if (operation.current === version) busyRef.current = false;
      return;
    }
    if (operation.current !== version) return;
    if (kind === 'start') onControlChange?.(true, true);
    setBusy(true);
    setError('');
    try {
      const result = await post<{
        ok?: boolean;
        revision?: number;
        mode?: ControlState['mode'];
        resumable?: boolean;
      }>(`${path}/${kind}`, kind === 'start' ? {} : { revision: state.revision });
      if (operation.current !== version) return;
      if (result.ok === false) throw new Error('The browser could not continue. Try again.');
      if (kind === 'start' && typeof result.revision === 'number')
        setState((previous) => ({
          ...previous,
          paused: true,
          active: true,
          revision: result.revision!,
          mode: result.mode ?? (previous.signInAvailable ? 'sign_in' : 'manual'),
          resumable: result.resumable,
        }));
      const next = await api<ControlState>(path);
      if (operation.current === version) setState(next);
    } catch (cause) {
      if (operation.current === version) setError(errorMessage(cause));
    } finally {
      if (operation.current === version) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <div className="browser-control">
      <div
        ref={controls}
        className="browser-control-heading"
        role="group"
        aria-label="Browser controls"
      >
        <Button
          variant={state.active ? 'secondary' : 'outline'}
          size="sm"
          disabled={busy}
          onClick={() => void action(state.active ? 'resume' : 'start')}
        >
          {state.active ? <Play size={14} /> : <Hand size={14} />}
          {busy
            ? 'Please wait…'
            : state.active
              ? resumable
                ? 'Resume agent'
                : 'Done'
              : state.paused
                ? 'Take control again'
                : 'Take control'}
        </Button>
        {state.paused && !state.active && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void action('resume')}>
            Resume agent
          </Button>
        )}
        {screen && !signingIn && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Enlarge browser screen"
            disabled={busy}
            onClick={onEnlarge}
          >
            <Maximize2 size={15} />
          </Button>
        )}
        {actions}
      </div>
      {currentScreen ? (
        state.active ? (
          <div className="screen-preview screen-interactive">
            <img
              ref={input.image}
              src={currentScreen}
              alt={signingIn ? 'Private workspace browser' : 'Browser screen'}
              draggable={false}
            />
            <textarea
              ref={input.surface}
              className="browser-input-surface"
              aria-label="Control workspace browser"
              aria-describedby={inputHint}
              disabled={!canInteract}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              rows={1}
            />
          </div>
        ) : (
          <button
            className="screen-preview"
            disabled={busy}
            aria-label="Enlarge browser screen"
            onClick={onEnlarge}
          >
            <img src={currentScreen} alt="Browser screen" draggable={false} />
          </button>
        )
      ) : placeholder ? (
        <div className="screen-empty">
          <Monitor size={26} />
          <p>{placeholder}</p>
        </div>
      ) : null}
      {state.active && currentScreen && (
        <p id={inputHint} className="browser-input-hint">
          Click the browser to type. Shift + Esc returns to the controls.
        </p>
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}
