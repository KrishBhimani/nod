import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Camera, RefreshCw, Terminal, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { InspectorState } from '../../shared/contracts';
import { Button, Loading, Notice } from '../components/ui';
import { StatusIcon, statusLabels } from '../components/task-list';
import { api, errorMessage, post } from '../lib/api';
import { relativeTime } from '../lib/utils';

interface Notification { id: string; summary: string; decision: string; createdAt: string; feedback: null | 'useful' | 'not_useful'; }

export function Inspector() {
  const [data, setData] = useState<InspectorState | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [screen, setScreen] = useState('');
  const [screenState, setScreenState] = useState('Choose a task to view its browser.');
  const [refreshing, setRefreshing] = useState(false);
  const [screenLoading, setScreenLoading] = useState(false);
  const screenRevision = useRef(0);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await api<InspectorState>('/api/inspector');
      setData(next); setError('');
      setSelected(current => current || next.tasks[0]?.id || '');
      const recent = await api<Notification[]>('/api/notifications').catch(() => []);
      setNotifications(recent);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setRefreshing(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { screenRevision.current += 1; setScreenLoading(false); setScreen(''); setScreenState(selected ? 'Refresh to see the latest browser view.' : 'Choose a task to view its browser.'); }, [selected]);
  useEffect(() => () => { if (screen) URL.revokeObjectURL(screen); }, [screen]);
  async function refreshScreen() {
    if (!selected) return;
    const revision = ++screenRevision.current;
    setScreenLoading(true); setScreen('');
    try {
      const response = await fetch(`/api/inspector/screen?taskId=${encodeURIComponent(selected)}`, { cache: 'no-store', credentials: 'same-origin' });
      if (revision !== screenRevision.current) return;
      if (response.status === 423) { setScreenState('The browser is hidden while credentials are entered.'); return; }
      if (response.status === 404) { setScreenState('This task does not have a browser view yet.'); return; }
      if (!response.ok) throw new Error('The browser view could not be loaded.');
      const blob = await response.blob();
      if (revision !== screenRevision.current) return;
      setScreen(URL.createObjectURL(blob));
      setScreenState('');
    } catch (cause) { if (revision === screenRevision.current) setScreenState(errorMessage(cause)); }
    finally { if (revision === screenRevision.current) setScreenLoading(false); }
  }
  async function feedback(notification: Notification, value: 'useful' | 'not_useful') {
    try { await post(`/api/notifications/${encodeURIComponent(notification.id)}/feedback`, { feedback: value }); setNotifications(current => current.map(item => item.id === notification.id ? { ...item, feedback: value } : item)); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  const events = data?.events.filter(event => event.taskId === selected) ?? [];
  return <div className="content-page inspector-page"><header className="page-heading"><div><h1>Under the hood</h1><p>Task events and the computer workspace.</p></div><Button variant="outline" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'spin' : ''} />Refresh</Button></header>{error && <Notice>{error}</Notice>}
    {!data ? !error && <Loading /> : <><div className="runtime-facts"><span><Terminal size={15} />{data.runtime.workspace}</span><span>{data.runtime.browser}</span><span>{data.runtime.database}</span></div><div className="inspector-layout"><section className="inspector-tasks"><h2>Tasks</h2>{data.tasks.length ? data.tasks.map(task => <button key={task.id} className={`inspector-task ${selected === task.id ? 'selected' : ''}`} onClick={() => setSelected(task.id)}><StatusIcon status={task.status} /><span><strong>{task.title}</strong><small>{statusLabels[task.status]}</small></span></button>) : <p className="muted">Tasks will appear here when you start a conversation.</p>}</section><div className="inspector-detail"><section className="inspector-screen"><div className="section-title"><h2><Camera size={16} />Browser</h2><Button variant="ghost" size="sm" disabled={!selected || screenLoading} onClick={() => void refreshScreen()}><RefreshCw size={14} className={screenLoading ? 'spin' : ''} />Refresh view</Button></div>{screen ? <img src={screen} alt="Current browser view for the selected task" /> : <div className="screen-empty"><Camera size={26} strokeWidth={1.4} /><p>{screenLoading ? 'Loading browser view…' : screenState}</p></div>}</section><section className="event-section"><h2><Activity size={16} />Events</h2>{events.length ? <ol className="event-list">{events.map(event => <li key={event.id}><span className="event-dot" /><div><p>{event.summary}</p><small>{event.type} <span className="text-separator">/</span> {relativeTime(event.createdAt)}</small></div></li>)}</ol> : <p className="muted">No events for this task yet.</p>}</section></div></div></>}
    {notifications.length > 0 && <section className="notification-section"><h2>Recent connection updates</h2>{notifications.map(notification => <div className="notification-row" key={notification.id}><div><p>{notification.summary}</p><small>{notification.decision} <span className="text-separator">/</span> {relativeTime(notification.createdAt)}</small></div><Button variant={notification.feedback === 'useful' ? 'secondary' : 'ghost'} size="icon" aria-label="This update was useful" onClick={() => void feedback(notification, 'useful')}><ThumbsUp size={15} /></Button><Button variant={notification.feedback === 'not_useful' ? 'secondary' : 'ghost'} size="icon" aria-label="This update was not useful" onClick={() => void feedback(notification, 'not_useful')}><ThumbsDown size={15} /></Button></div>)}</section>}
  </div>;
}
