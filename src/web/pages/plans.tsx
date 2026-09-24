import { useEffect, useState } from 'react';
import { CalendarClock, Flag, Pencil, Plus, Trash2, Pause, Play } from 'lucide-react';
import type { Goal, Schedule } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { scheduleLabel } from '../lib/schedules';
import { Button, Loading, Notice } from '../components/ui';
import { GoalEditor } from '../components/goal-editor';
import { ScheduleEditor } from '../components/schedule-editor';

export function Plans({ type }: { type: 'goals' | 'schedules' }) {
  const [items, setItems] = useState<(Goal | Schedule)[] | null>(null);
  const [editing, setEditing] = useState<Goal | Schedule | null | undefined>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  async function refresh() {
    try {
      setItems(await api<(Goal | Schedule)[]>(`/api/${type}`));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  useEffect(() => {
    setItems(null);
    void refresh();
  }, [type]);
  async function change(id: string, value?: unknown) {
    setBusy(id);
    setError('');
    try {
      await api(`/api/${type}/${id}`, {
        method: value ? 'PATCH' : 'DELETE',
        ...(value ? { body: JSON.stringify(value) } : {}),
      });
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="content-page">
      <header className="page-heading">
        <div>
          <h1>{type === 'goals' ? 'Goals' : 'Schedule'}</h1>
          <p>
            {type === 'goals'
              ? 'What you’re working towards.'
              : 'Your recurring tasks, at a glance.'}
          </p>
        </div>
        <Button onClick={() => setEditing(null)}>
          <Plus size={16} />
          {type === 'goals' ? 'New goal' : 'New schedule'}
        </Button>
      </header>
      {error && <Notice>{error}</Notice>}
      {!items ? (
        <Loading />
      ) : !items.length ? (
        <div className="page-empty">
          {type === 'goals' ? <Flag size={28} /> : <CalendarClock size={28} />}
          <h2>{type === 'goals' ? 'Make room for a goal.' : 'Put something on repeat.'}</h2>
          <p>
            {type === 'goals'
              ? 'Tell Sidekick what you want to achieve, or add a goal here.'
              : 'Ask in chat, or create your first scheduled task.'}
          </p>
        </div>
      ) : (
        <div className="plan-list">
          {items.map((item) => (
            <article key={item.id} className="plan-row">
              <div className="plan-body">
                <div className="plan-title">
                  <h2>{item.title}</h2>
                  <span className="subtle-badge">
                    {'progress' in item ? item.status : item.enabled ? 'Active' : 'Paused'}
                  </span>
                </div>
                {'progress' in item ? (
                  <>
                    <p>{item.description}</p>
                    <div className="goal-progress">
                      <progress max={100} value={item.progress} />
                      <span>{item.progress}%</span>
                    </div>
                    {item.nextAction && <p className="next-action">Next: {item.nextAction}</p>}
                    {item.targetDate && <small>By {item.targetDate}</small>}
                  </>
                ) : (
                  <>
                    <p>{item.prompt}</p>
                    <small>
                      {scheduleLabel(item.cron)} · {item.timeZone}
                    </small>
                  </>
                )}
              </div>
              <div className="row-actions">
                {'enabled' in item && (
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busy === item.id}
                    onClick={() => void change(item.id, { enabled: !item.enabled })}
                    aria-label={item.enabled ? 'Pause schedule' : 'Resume schedule'}
                  >
                    {item.enabled ? <Pause size={16} /> : <Play size={16} />}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${item.title}`}
                  onClick={() => setEditing(item)}
                >
                  <Pencil size={16} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${item.title}`}
                  disabled={busy === item.id}
                  onClick={() => {
                    if (window.confirm(`Delete “${item.title}”?`)) void change(item.id);
                  }}
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      {editing !== undefined &&
        (type === 'goals' ? (
          <GoalEditor
            goal={editing as Goal | null}
            onClose={() => setEditing(undefined)}
            onSaved={refresh}
          />
        ) : (
          <ScheduleEditor
            schedule={editing as Schedule | null}
            onClose={() => setEditing(undefined)}
            onSaved={refresh}
          />
        ))}
    </div>
  );
}
