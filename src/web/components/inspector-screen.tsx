import { useEffect, useRef, useState } from 'react';
import { Monitor, Terminal, FileText, ExternalLink } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogTitle, Notice } from './ui';
import { post, errorMessage } from '../lib/api';
import { BrowserControl } from './browser-control';
import type { BrowserDetail, InspectorDetail } from '../hooks/use-inspector-state';
import { browserErrorMessage } from '../../shared/browser-errors';

export function InspectorScreen({
  data,
  active,
  onStopped,
  allowDetach = false,
  showDetails = true,
  screenPath = '/api/inspector/screen',
}: {
  data: (BrowserDetail & Partial<Pick<InspectorDetail, 'runtime' | 'artifacts'>>) | null;
  active: boolean;
  onStopped(taskId: string): void;
  allowDetach?: boolean;
  showDetails?: boolean;
  screenPath?: string;
}) {
  const browserId = data?.currentBrowser?.taskId;
  const activity = useRef(data?.currentBrowser?.lastActivityAt);
  activity.current = data?.currentBrowser?.lastActivityAt;
  const activeRef = useRef(active);
  activeRef.current = active;
  const [error, setError] = useState('');
  const [detached, setDetached] = useState(false);
  const detachedRef = useRef(detached);
  detachedRef.current = detached;
  const popup = useRef<Window | null>(null);
  const [stoppingBrowser, setStoppingBrowser] = useState<string>();
  const [screen, setScreen] = useState('');
  const [screenTask, setScreenTask] = useState<string>();
  const currentScreen = screenTask === browserId ? screen : '';
  const [screenState, setScreenState] = useState('Waiting for a browser session.');
  const [frameKind, setFrameKind] = useState('live');
  const [updated, setUpdated] = useState<Date | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const [captureAttempt, setCaptureAttempt] = useState(0);
  const [capturePaused, setCapturePaused] = useState(false);
  const imageUrl = useRef('');
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    let blockedActivity: string | null = null;
    const controller = new AbortController();
    setScreen('');
    setUpdated(null);
    setCapturePaused(false);
    if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    imageUrl.current = '';
    setScreenState(
      browserId ? 'Opening the browser view…' : 'The browser appears when Sidekick uses it.',
    );
    async function frame() {
      if (
        !browserId ||
        !activeRef.current ||
        detachedRef.current ||
        document.hidden ||
        (blockedActivity !== null && blockedActivity === (activity.current ?? ''))
      ) {
        if (!stopped) timer = setTimeout(() => void frame(), 1000);
        return;
      }
      blockedActivity = null;
      setCapturePaused(false);
      const requestedActivity = activity.current ?? '';
      try {
        const response = await fetch(`${screenPath}?taskId=${encodeURIComponent(browserId)}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (stopped || detachedRef.current) return;
        if (!response.ok) {
          setScreen('');
          setUpdated(null);
          if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
          imageUrl.current = '';
          setFrameKind('unavailable');
          const payload = response.status === 409 ? await response.json().catch(() => null) : null;
          if (stopped || detachedRef.current) return;
          const message = browserErrorMessage(payload?.code);
          if (message || response.status === 423) {
            blockedActivity = requestedActivity;
            setCapturePaused(true);
          }
          setScreenState(
            message
              ? message
              : response.status === 423
                ? 'Screen hidden while sign-in details are entered.'
                : response.status === 404
                  ? 'No browser view is available yet.'
                  : 'The browser view is temporarily unavailable.',
          );
        } else {
          const bytes = await response.blob();
          if (stopped || detachedRef.current) return;
          const next = URL.createObjectURL(bytes),
            previous = imageUrl.current;
          imageUrl.current = next;
          setScreenTask(browserId);
          setScreen(next);
          setFrameKind(response.headers.get('X-Screen-State') ?? 'live');
          setUpdated(new Date(response.headers.get('X-Screen-Captured-At') ?? Date.now()));
          setScreenState('');
          if (previous) URL.revokeObjectURL(previous);
        }
      } catch {
        if (!stopped) {
          setScreen('');
          setUpdated(null);
          setFrameKind('unavailable');
          if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
          imageUrl.current = '';
          setScreenState('Reconnecting to the browser…');
        }
      } finally {
        if (!stopped) timer = setTimeout(() => void frame(), 1000);
      }
    }
    void frame();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
      imageUrl.current = '';
    };
  }, [browserId, captureAttempt, screenPath]);
  useEffect(() => {
    if (!detached) return;
    const timer = setInterval(() => {
      if (!popup.current || popup.current.closed) {
        popup.current = null;
        setDetached(false);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [detached]);
  function openBrowserWindow(event: React.MouseEvent<HTMLAnchorElement>) {
    if (popup.current && !popup.current.closed) {
      event.preventDefault();
      popup.current.focus();
      return;
    }
    let opened: Window | null;
    try {
      opened = window.open('/browser', 'sidekick-browser', 'popup,width=1200,height=800');
    } catch {
      return;
    }
    if (!opened) return;
    event.preventDefault();
    opened.opener = null;
    opened.focus();
    popup.current = opened;
    detachedRef.current = true;
    setDetached(true);
    setScreen('');
    setUpdated(null);
    if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    imageUrl.current = '';
  }
  if (!active) return null;
  return (
    <>
      {error && <Notice>{error}</Notice>}
      {allowDetach && (
        <div className="inspector-screen-toolbar">
          <a href="/browser" target="sidekick-browser" rel="noreferrer" onClick={openBrowserWindow}>
            <ExternalLink size={14} />
            Open browser window
          </a>
        </div>
      )}
      {detached ? (
        <div className="inspector-browser-detached">
          <Monitor size={24} />
          <p>The browser is open in a separate window.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              popup.current?.close();
              popup.current = null;
              setDetached(false);
            }}
          >
            Show here
          </Button>
        </div>
      ) : (
        <>
          <section className="live-screen">
            {browserId ? (
              <BrowserControl
                key={browserId}
                taskId={browserId}
                screen={currentScreen}
                emptyMessage={screenState}
                live={frameKind === 'live'}
                actions={
                  <>
                    {capturePaused && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCaptureAttempt((value) => value + 1)}
                      >
                        Retry view
                      </Button>
                    )}
                    {data?.currentBrowser?.status === 'running' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={stoppingBrowser === browserId}
                        aria-label="Stop browser task"
                        onClick={() => {
                          const id = browserId;
                          setStoppingBrowser(id);
                          void post(`/api/tasks/${encodeURIComponent(id)}/cancel`)
                            .then(() => onStopped(id))
                            .catch((cause) => setError(errorMessage(cause)))
                            .finally(() => setStoppingBrowser(undefined));
                        }}
                      >
                        Stop
                      </Button>
                    )}
                  </>
                }
                heading={
                  currentScreen && (
                    <span className="browser-live-label">
                      <i className={`connection-dot ${frameKind === 'live' ? 'connected' : ''}`} />
                      {frameKind === 'last_known' ? 'Last view' : 'Live'}
                    </span>
                  )
                }
                onEnlarge={() => setEnlarged(true)}
              />
            ) : (
              <div className="screen-empty">
                <Monitor size={26} />
                <p>{screenState}</p>
              </div>
            )}
            {updated && (
              <div className="screen-caption">Updated {updated.toLocaleTimeString()}</div>
            )}
          </section>
          {showDetails && (
            <details className="inspector-system">
              <summary>
                <Terminal size={14} />
                Computer details
              </summary>
              <dl>
                <dt>Workspace</dt>
                <dd>{data?.runtime?.workspace ?? 'Connecting'}</dd>
                <dt>Browser</dt>
                <dd>{data?.runtime?.browser ?? 'Connecting'}</dd>
                <dt>State</dt>
                <dd>{data?.runtime?.database ?? 'Connecting'}</dd>
              </dl>
            </details>
          )}
          {showDetails &&
            (data?.artifacts ?? []).filter((item) => item.taskId === browserId).length > 0 && (
              <section className="inspector-section">
                <h3>Files</h3>
                {data?.artifacts
                  ?.filter((item) => item.taskId === browserId)
                  .map((item) => (
                    <a
                      className="inspector-file"
                      key={item.id}
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <FileText size={14} />
                      {item.name}
                    </a>
                  ))}
              </section>
            )}

          <Dialog open={enlarged && Boolean(currentScreen)} onOpenChange={setEnlarged}>
            <DialogContent className="screen-dialog">
              <DialogTitle>Browser screen</DialogTitle>
              <img src={currentScreen} alt="Enlarged browser screen" />
              <p className="field-hint">
                {frameKind === 'last_known' ? 'Last captured view' : 'Live view'}
                {updated && ` · ${updated.toLocaleTimeString()}`}
              </p>
            </DialogContent>
          </Dialog>
        </>
      )}
    </>
  );
}
