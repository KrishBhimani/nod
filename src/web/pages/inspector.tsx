import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Monitor,
  X,
  Pause,
  Play,
  Maximize2,
  Clock3,
  Layers,
  Terminal,
  FileText,
} from 'lucide-react';
import type { InspectorState, Artifact } from '../../shared/contracts';
import { Button, Dialog, DialogContent, DialogTitle, Notice } from '../components/ui';
import { statusLabels, StatusIcon } from '../components/task-list';
import { api, errorMessage } from '../lib/api';
import { relativeTime } from '../lib/utils';

type Detail = InspectorState & { artifacts?: (Artifact & { taskId: string })[] };
export function Inspector({ onClose }: { onClose(): void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState<'screen' | 'activity' | 'tasks'>('screen');
  const [error, setError] = useState('');
  const [screen, setScreen] = useState('');
  const [screenState, setScreenState] = useState('Waiting for a browser session.');
  const [paused, setPaused] = useState(false);
  const [frameKind, setFrameKind] = useState('live');
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  followRef.current = follow;
  const [updated, setUpdated] = useState<Date | null>(null);
  const [wide, setWide] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [notifications, setNotifications] = useState<
    { id: string; summary: string; decision: string; reason?: string; createdAt: string }[]
  >([]);
  const imageUrl = useRef('');
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const [next, recent] = await Promise.all([
          api<Detail>('/api/inspector'),
          api<typeof notifications>('/api/notifications').catch(() => []),
        ]);
        if (stopped) return;
        setData(next);
        setNotifications(recent);
        setError('');
        setSelected((current) => {
          if (!followRef.current && current) return current;
          return (
            next.tasks.find((task) => ['running', 'queued'].includes(task.status))?.id ||
            next.tasks.find((task) =>
              next.events.some(
                (event) =>
                  event.taskId === task.id &&
                  /browser|login|credential/i.test(event.type + ' ' + event.summary),
              ),
            )?.id ||
            current ||
            next.tasks[0]?.id ||
            ''
          );
        });
      } catch (cause) {
        if (!stopped) setError(errorMessage(cause));
      } finally {
        if (!stopped) timer = setTimeout(() => void refresh(), 2500);
      }
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    setScreen('');
    setUpdated(null);
    if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    imageUrl.current = '';
    setScreenState(selected ? 'Opening the browser view…' : 'Waiting for a browser session.');
    async function frame() {
      if (!selected || pausedRef.current || tab !== 'screen' || document.hidden) {
        if (!stopped) timer = setTimeout(() => void frame(), 1000);
        return;
      }
      try {
        const response = await fetch(
          `/api/inspector/screen?taskId=${encodeURIComponent(selected)}`,
          { cache: 'no-store', credentials: 'same-origin', signal: controller.signal },
        );
        if (stopped || pausedRef.current) return;
        if (!response.ok) {
          setScreen('');
          setUpdated(null);
          if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
          imageUrl.current = '';
          setScreenState(
            response.status === 423
              ? 'Screen hidden while sign-in details are entered.'
              : response.status === 404
                ? 'This task hasn’t opened a browser yet.'
                : 'The browser view is temporarily unavailable.',
          );
        } else {
          const bytes = await response.blob();
          if (stopped || pausedRef.current) return;
          const next = URL.createObjectURL(bytes),
            previous = imageUrl.current;
          imageUrl.current = next;
          setScreen(next);
          setFrameKind(response.headers.get('X-Screen-State') ?? 'live');
          setUpdated(new Date(response.headers.get('X-Screen-Captured-At') ?? Date.now()));
          setScreenState('');
          if (previous) URL.revokeObjectURL(previous);
        }
      } catch {
        if (!stopped) setScreenState('Reconnecting to the browser…');
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
  }, [selected, tab]);
  const task = data?.tasks.find((item) => item.id === selected);
  const events = data?.events.filter((event) => event.taskId === selected) ?? [];
  return (
    <aside
      ref={panel}
      className={`inspector-panel ${wide ? 'inspector-wide' : ''}`}
      aria-label="Developer inspector"
    >
      <header className="inspector-heading">
        <div>
          <Monitor size={17} />
          <h2>Inspector</h2>
          <span className="dev-label">DEV</span>
        </div>
        <div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={wide ? 'Narrow inspector' : 'Widen inspector'}
            onClick={() => setWide(!wide)}
          >
            <Maximize2 size={15} />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Close inspector" onClick={onClose}>
            <X size={17} />
          </Button>
        </div>
      </header>
      <div className="inspector-tabs" role="tablist" aria-label="Inspector views">
        {(
          [
            ['screen', 'Screen', Monitor],
            ['activity', 'Activity', Activity],
            ['tasks', 'Tasks', Layers],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            role="tab"
            aria-selected={tab === value}
            key={value}
            onClick={() => setTab(value)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>
      {error && <Notice>{error}</Notice>}
      <div className="inspector-body">
        <label className="inspector-follow">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
          />
          Follow current activity
        </label>
        {tab !== 'tasks' && (
          <label className="inspector-task-select">
            <span>Task</span>
            <select
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value);
                setFollow(false);
              }}
              aria-label="Inspect task"
            >
              <option value="" disabled>
                Choose a task
              </option>
              {data?.tasks.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {statusLabels[item.status]}
                </option>
              ))}
            </select>
          </label>
        )}
        {tab === 'screen' && (
          <>
            <section className="live-screen">
              <div className="screen-toolbar">
                <span>
                  <i
                    className={`connection-dot ${screen && !paused && frameKind === 'live' ? 'connected' : ''}`}
                  />
                  {paused
                    ? 'Paused'
                    : screen
                      ? frameKind === 'last_known'
                        ? 'Last captured view'
                        : 'Live view'
                      : 'Browser'}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={paused ? 'Resume live screen' : 'Pause live screen'}
                  onClick={() => setPaused(!paused)}
                >
                  {paused ? <Play size={13} /> : <Pause size={13} />}
                </Button>
              </div>
              {screen ? (
                <button
                  className="screen-preview"
                  aria-label="Enlarge browser screen"
                  onClick={() => setEnlarged(true)}
                >
                  <img src={screen} alt="Browser screen" />
                </button>
              ) : (
                <div className="screen-empty">
                  <Monitor size={26} />
                  <p>{screenState}</p>
                </div>
              )}
              <div className="screen-caption">
                {updated
                  ? `Updated ${updated.toLocaleTimeString()}`
                  : 'The screen appears when this task uses the browser.'}
              </div>
            </section>
            {task && (
              <section className="inspector-section">
                <h3>Current task</h3>
                <p className="inspector-task-title">{task.title}</p>
                <div className="task-detail-status">
                  <StatusIcon status={task.status} />
                  {statusLabels[task.status]}
                </div>
                {task.error && <Notice>{task.error}</Notice>}
                <dl>
                  <dt>Started</dt>
                  <dd>{new Date(task.createdAt).toLocaleString()}</dd>
                  <dt>Last change</dt>
                  <dd>{relativeTime(task.updatedAt)}</dd>
                </dl>
              </section>
            )}
            <section className="inspector-section">
              <h3>
                <Terminal size={14} />
                Computer
              </h3>
              <dl>
                <dt>Workspace</dt>
                <dd>{data?.runtime.workspace ?? 'Connecting'}</dd>
                <dt>Browser</dt>
                <dd>{data?.runtime.browser ?? 'Connecting'}</dd>
                <dt>State</dt>
                <dd>{data?.runtime.database ?? 'Connecting'}</dd>
                <dt>Working</dt>
                <dd>
                  {data?.tasks.filter((item) => item.status === 'running').length ?? 0} running ·{' '}
                  {data?.tasks.filter((item) => item.status === 'queued').length ?? 0} queued
                </dd>
              </dl>
            </section>
            {(data?.artifacts ?? []).filter((item) => item.taskId === selected).length > 0 && (
              <section className="inspector-section">
                <h3>Files</h3>
                {data?.artifacts
                  ?.filter((item) => item.taskId === selected)
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
          </>
        )}
        {tab === 'activity' && (
          <>
            <section className="inspector-section">
              <h3>
                Task timeline <span>{events.length}</span>
              </h3>
              {events.length ? (
                <ol className="event-list">
                  {[...events].reverse().map((event) => (
                    <li key={event.id}>
                      <span className="event-dot" />
                      <div>
                        <p>{event.summary}</p>
                        <small>
                          {event.type} · {new Date(event.createdAt).toLocaleTimeString()}
                        </small>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted">No events yet.</p>
              )}
            </section>
            <section className="inspector-section">
              <h3>
                <Clock3 size={14} />
                Background checks
              </h3>
              {notifications.length ? (
                notifications.slice(0, 15).map((item) => (
                  <div className="background-event" key={item.id}>
                    <span className="subtle-badge">{item.decision}</span>
                    <p>{item.summary}</p>
                    {item.reason && <small>{item.reason}</small>}
                    <small>{relativeTime(item.createdAt)}</small>
                  </div>
                ))
              ) : (
                <p className="muted">No connection updates to review.</p>
              )}
            </section>
          </>
        )}
        {tab === 'tasks' && (
          <div className="inspector-task-list">
            {data?.tasks.map((item) => (
              <button
                className={`inspector-task ${selected === item.id ? 'selected' : ''}`}
                key={item.id}
                onClick={() => {
                  setSelected(item.id);
                  setFollow(false);
                  setTab('activity');
                }}
              >
                <StatusIcon status={item.status} />
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {statusLabels[item.status]} · {relativeTime(item.updatedAt)}
                  </small>
                </span>
              </button>
            ))}
            {data?.tasks.length === 0 && <p className="muted">Tasks appear as you chat.</p>}
          </div>
        )}
      </div>
      <Dialog open={enlarged && Boolean(screen)} onOpenChange={setEnlarged}>
        <DialogContent className="screen-dialog">
          <DialogTitle>Browser screen</DialogTitle>
          <img src={screen} alt="Enlarged browser screen" />
          <p className="field-hint">
            {paused ? 'Paused' : frameKind === 'last_known' ? 'Last captured view' : 'Live view'}
            {updated && ` · ${updated.toLocaleTimeString()}`}
          </p>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
