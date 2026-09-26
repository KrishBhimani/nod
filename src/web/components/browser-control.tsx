import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Hand, Maximize2, Monitor, Play } from 'lucide-react';
import { api, post, errorMessage } from '../lib/api';
import { Button, Notice } from './ui';
import { useSignInScreen } from '../hooks/use-sign-in-screen';

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
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const signingIn = state.active && state.mode === 'sign_in';
  const resumable = Boolean(taskId) && state.resumable !== false;
  const operation = useRef(0);
  const busyRef = useRef(false);
  const signIn = useSignInScreen(path, state.revision, signingIn);
  const currentScreen = signingIn ? signIn.screen : screen;
  const currentLive = signingIn ? Boolean(signIn.screen) : live;
  const canInteract = Boolean(currentScreen) && currentLive && !busy;
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
    setText('');
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
  useEffect(() => {
    const clear = () => setText('');
    const visibility = () => {
      if (document.hidden) clear();
    };
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  async function action(kind: 'start' | 'resume' | 'input', input?: unknown) {
    if (busyRef.current) return;
    busyRef.current = true;
    if (kind === 'start') onControlChange?.(true, true);
    const version = ++operation.current;
    setBusy(true);
    setError('');
    try {
      const result = await post<{
        ok?: boolean;
        revision?: number;
        mode?: ControlState['mode'];
        resumable?: boolean;
      }>(
        `${path}/${kind}`,
        kind === 'start' ? {} : { revision: state.revision, ...(input ? { input } : {}) },
      );
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
        setText('');
      }
    }
  }
  return (
    <div className="browser-control">
      <div className="browser-control-heading" role="group" aria-label="Browser controls">
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
        <button
          className={`screen-preview ${state.active ? 'screen-interactive' : ''}`}
          disabled={busy || (state.active && !canInteract)}
          aria-label={state.active ? 'Click inside the browser' : 'Enlarge browser screen'}
          onClick={(event) => {
            if (!state.active) return onEnlarge();
            const image = event.currentTarget.querySelector('img');
            if (!image || !currentLive) return;
            const rect = image.getBoundingClientRect();
            void action('input', {
              action: 'click',
              x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
              y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
            });
          }}
        >
          <img
            src={currentScreen}
            alt={signingIn ? 'Private workspace browser' : 'Browser screen'}
            draggable={false}
          />
        </button>
      ) : placeholder ? (
        <div className="screen-empty">
          <Monitor size={26} />
          <p>{placeholder}</p>
        </div>
      ) : null}
      {state.active && (
        <div className="manual-controls">
          <p>You’re in control. Click the page, then enter text below.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (text && canInteract) void action('input', { action: 'type', text });
            }}
          >
            <input
              type="password"
              disabled={!canInteract}
              aria-label="Private browser text"
              autoComplete="off"
              placeholder="Type or paste privately"
              value={text}
              maxLength={8192}
              onChange={(event) => setText(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={!canInteract || !text}>
              Enter text
            </Button>
          </form>
          <div className="manual-keys">
            {(['Tab', 'Shift+Tab', 'Enter', 'Escape', 'Backspace', 'ControlOrMeta+A'] as const).map(
              (key) => (
                <Button
                  key={key}
                  variant="outline"
                  size="sm"
                  disabled={!canInteract}
                  onClick={() => void action('input', { action: 'press', key })}
                >
                  {key === 'ControlOrMeta+A'
                    ? 'Select all'
                    : key === 'Shift+Tab'
                      ? 'Previous'
                      : key}
                </Button>
              ),
            )}
            {(['up', 'down'] as const).map((direction) => (
              <Button
                key={direction}
                variant="outline"
                size="sm"
                disabled={!canInteract}
                onClick={() => void action('input', { action: 'scroll', direction })}
              >
                Scroll {direction}
              </Button>
            ))}
          </div>
          <small>
            Text stays out of chat and inspector recordings. Choose{' '}
            {resumable ? 'Resume agent' : 'Done'} when you’re finished.
          </small>
        </div>
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}
