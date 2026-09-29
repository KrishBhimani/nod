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
  mode: 'manual' | 'sign_in' | null;
  signInAvailable: boolean;
  resumable?: boolean;
}
const initialState: ControlState = {
  paused: false,
  active: false,
  mode: null,
  signInAvailable: false,
};

export function BrowserControl({
  threadId,
  screen,
  emptyMessage,
  live,
  onEnlarge,
  actions,
  onControlChange,
  controlPath,
  startLabel,
  finishLabel,
  onCompleted,
}: {
  threadId?: string;
  screen: string | null;
  emptyMessage: string;
  live: boolean;
  onEnlarge(): void;
  actions?: ReactNode;
  onControlChange?(
    active: boolean,
    privateView: boolean,
    phase: 'opening' | 'open' | 'checking' | 'closed',
  ): void;
  controlPath?: string;
  startLabel?: string;
  finishLabel?: string;
  onCompleted?(result: { loginSaved?: boolean }): void;
}) {
  const path = controlPath ?? '/api/browser/control';
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
  const resumable = Boolean(threadId) && state.resumable !== false;
  const operation = useRef(0);
  const busyRef = useRef(false);
  const [session, setSession] = useState(0);
  const activeSession = state.active ? session : null;
  const signIn = useSignInScreen(path, activeSession, signingIn);
  const signInScreenReady = Boolean(signIn.screen);
  const currentScreen = signingIn ? signIn.screen : screen;
  const currentLive = signingIn ? Boolean(signIn.screen) : live;
  const canInteract = Boolean(currentScreen) && currentLive && !busy;
  const input = useBrowserInput({
    path,
    session: activeSession,
    enabled: state.active && canInteract,
    onError: setError,
    onExit: () => controls.current?.querySelector('button')?.focus(),
  });
  const placeholder = signingIn ? signIn.error || 'Opening the private browser…' : emptyMessage;
  useEffect(() => {
    onControlChange?.(
      state.active || busy,
      signingIn || (busy && !state.active),
      busy
        ? state.active
          ? 'checking'
          : 'opening'
        : state.active
          ? signingIn && !signInScreenReady
            ? 'opening'
            : 'open'
          : 'closed',
    );
  }, [state.active, signingIn, signInScreenReady, busy, onControlChange]);
  useEffect(() => {
    let stopped = false;
    operation.current++;
    busyRef.current = false;
    setBusy(false);
    setState({ paused: false, active: false, mode: null, signInAvailable: false });
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
    if (kind === 'start') onControlChange?.(true, true, 'opening');
    setBusy(true);
    setError('');
    try {
      const result = await post<{
        ok?: boolean;
        mode?: ControlState['mode'];
        resumable?: boolean;
        loginSaved?: boolean;
      }>(`${path}/${kind}`, {});
      if (operation.current !== version) return;
      if (result.ok === false) throw new Error('The browser could not continue. Try again.');
      if (kind === 'start') setSession((value) => value + 1);
      if (kind === 'start' && result.mode)
        setState((previous) => ({
          ...previous,
          paused: true,
          active: true,
          mode: result.mode ?? (previous.signInAvailable ? 'sign_in' : 'manual'),
          resumable: result.resumable,
        }));
      if (kind === 'resume' && controlPath) {
        setState(initialState);
        onCompleted?.(result);
        return;
      }
      const next = await api<ControlState>(path);
      if (operation.current === version) setState(next);
      if (kind === 'resume' && operation.current === version) onCompleted?.(result);
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
                : (finishLabel ?? 'Done')
              : state.paused
                ? 'Take control again'
                : (startLabel ?? 'Take control')}
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
