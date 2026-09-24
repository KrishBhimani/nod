import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Brain,
  CalendarClock,
  Check,
  CircleCheck,
  Flag,
  Heart,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  UserRound,
} from 'lucide-react';
import type { Goal, MemoryFact, Profile, Schedule } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { scheduleLabel } from '../lib/schedules';
import { GoalEditor } from '../components/goal-editor';
import { ScheduleEditor } from '../components/schedule-editor';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  Input,
  Loading,
  Notice,
  Textarea,
} from '../components/ui';

export function You() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [memories, setMemories] = useState<MemoryFact[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [goalEditor, setGoalEditor] = useState<{ goal: Goal | null } | null>(null);
  const [scheduleEditor, setScheduleEditor] = useState<{ schedule: Schedule | null } | null>(null);
  const [deleting, setDeleting] = useState<{
    kind: 'schedule' | 'memory';
    id: string;
    label: string;
  } | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [busy, setBusy] = useState('');
  const dirty = useRef(false);
  const requestVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    const results = await Promise.allSettled([
      api<Profile>('/api/profile'),
      api<Goal[]>('/api/goals'),
      api<Schedule[]>('/api/schedules'),
      api<MemoryFact[]>('/api/memory'),
    ]);
    if (version !== requestVersion.current) return;
    const [profileResult, goalsResult, schedulesResult, memoryResult] = results;
    if (profileResult.status === 'fulfilled' && !dirty.current) setProfile(profileResult.value);
    if (goalsResult.status === 'fulfilled') setGoals(goalsResult.value);
    if (schedulesResult.status === 'fulfilled') setSchedules(schedulesResult.value);
    if (memoryResult.status === 'fulfilled') setMemories(memoryResult.value);
    const failed = results.find((result) => result.status === 'rejected');
    setError(failed?.status === 'rejected' ? errorMessage(failed.reason) : '');
    setLoaded(true);
  }, []);
  useEffect(() => {
    void load();
    const events = new EventSource('/api/events');
    events.onmessage = (event) => {
      try {
        if (JSON.parse(event.data).type === 'refresh') void load();
      } catch {}
    };
    const focus = () => {
      void load();
    };
    window.addEventListener('focus', focus);
    return () => {
      requestVersion.current++;
      events.close();
      window.removeEventListener('focus', focus);
    };
  }, [load]);
  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await api('/api/profile', { method: 'PUT', body: JSON.stringify(profile) });
      dirty.current = false;
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  async function toggleSchedule(schedule: Schedule) {
    setBusy(schedule.id);
    setError('');
    try {
      await api(`/api/schedules/${encodeURIComponent(schedule.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !schedule.enabled }),
      });
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(deleting.id);
    setDeleteError('');
    try {
      await api(
        `/api/${deleting.kind === 'schedule' ? 'schedules' : 'memory'}/${encodeURIComponent(deleting.id)}`,
        { method: 'DELETE' },
      );
      setDeleting(null);
      await load();
    } catch (cause) {
      setDeleteError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  function update(key: keyof Profile, value: string) {
    dirty.current = true;
    if (profile) setProfile({ ...profile, [key]: value });
    setSaved(false);
  }
  function confirmDelete(kind: 'schedule' | 'memory', id: string, label: string) {
    setDeleteError('');
    setDeleting({ kind, id, label });
  }
  return (
    <div className="content-page you-page">
      <header className="page-heading">
        <div>
          <h1>A little about you.</h1>
          <p>The context that makes your Sidekick yours.</p>
        </div>
        <span className="heading-icon">
          <UserRound size={23} />
        </span>
      </header>
      {error && <Notice>{error}</Notice>}
      {profile ? (
        <form className="form-stack profile-form" onSubmit={(event) => void saveProfile(event)}>
          <div className="profile-fields">
            <Field label="What should I call you?">
              <Input
                autoComplete="given-name"
                disabled={saving}
                maxLength={100}
                value={profile.name}
                onChange={(event) => update('name', event.target.value)}
                placeholder="Your name"
              />
            </Field>
            <Field label="Where are you based?">
              <Input
                autoComplete="address-level2"
                disabled={saving}
                maxLength={200}
                value={profile.location}
                onChange={(event) => update('location', event.target.value)}
                placeholder="City or region"
              />
            </Field>
          </div>
          <Field
            label="Phone number"
            hint="Optional. Only used when it helps with a task you request."
          >
            <Input
              autoComplete="tel"
              disabled={saving}
              type="tel"
              maxLength={40}
              value={profile.phone}
              onChange={(event) => update('phone', event.target.value)}
              placeholder="+351…"
            />
          </Field>
          <Field label="What should I keep in mind?">
            <Textarea
              rows={4}
              disabled={saving}
              maxLength={4000}
              value={profile.preferences}
              onChange={(event) => update('preferences', event.target.value)}
              placeholder="Your preferences, routines, and how you like things done."
            />
          </Field>
          <div className="preferences-actions">
            <Button variant="secondary" disabled={saving}>
              {saving ? 'Saving…' : 'Save details'}
            </Button>
            {saved && (
              <span className="saved-state" role="status">
                <Check size={15} />
                Saved
              </span>
            )}
          </div>
        </form>
      ) : (
        !error && <Loading label="Loading your details…" />
      )}
      <section className="personal-section">
        <div className="section-heading">
          <Flag size={19} />
          <div>
            <h2>Things you’re working towards</h2>
            <p>A clear next step makes it easier to move forward.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setGoalEditor({ goal: null })}>
            <Plus size={15} />
            Add goal
          </Button>
        </div>
        {goals.length ? (
          <div className="goals-list">
            {goals.map((goal) => {
              const progress = Math.max(0, Math.min(100, Number(goal.progress) || 0));
              return (
                <article className="goal-row" key={goal.id}>
                  <div className="goal-heading">
                    <h3>{goal.title}</h3>
                    <span>
                      {goal.status === 'completed' ? (
                        <>
                          <CircleCheck size={14} />
                          Completed
                        </>
                      ) : goal.status === 'paused' ? (
                        'Paused'
                      ) : (
                        `${progress}%`
                      )}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit goal ${goal.title}`}
                      onClick={() => setGoalEditor({ goal })}
                    >
                      <Pencil size={15} />
                    </Button>
                  </div>
                  {goal.description && <p>{goal.description}</p>}
                  <div
                    className="goal-progress"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                    aria-label={goal.title}
                  >
                    <span style={{ width: `${progress}%` }} />
                  </div>
                  {goal.nextAction && <small>Next: {goal.nextAction}</small>}
                  {goal.targetDate && (
                    <small>
                      By{' '}
                      {new Date(`${goal.targetDate}T12:00:00Z`).toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                        timeZone: 'UTC',
                      })}
                    </small>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          loaded && (
            <div className="quiet-empty">
              <Heart size={18} />
              <p>No goals yet. Add one here or talk it through in your conversation.</p>
            </div>
          )
        )}
      </section>
      <section className="personal-section">
        <div className="section-heading">
          <CalendarClock size={19} />
          <div>
            <h2>On your schedule</h2>
            <p>Small routines, at the right time.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setScheduleEditor({ schedule: null })}>
            <Plus size={15} />
            Add schedule
          </Button>
        </div>
        {schedules.length ? (
          <div className="schedules-list">
            {schedules.map((schedule) => (
              <article className="schedule-row" key={schedule.id}>
                <div className="schedule-details">
                  <h3>{schedule.title}</h3>
                  <p>{schedule.prompt}</p>
                  <small>
                    {!schedule.enabled && <strong>Paused · </strong>}
                    {scheduleLabel(schedule.cron)} <span className="text-separator">/</span>{' '}
                    {schedule.timeZone}
                  </small>
                </div>
                <div className="row-actions">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit schedule ${schedule.title}`}
                    disabled={busy === schedule.id}
                    onClick={() => setScheduleEditor({ schedule })}
                  >
                    <Pencil size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${schedule.enabled ? 'Pause' : 'Resume'} schedule ${schedule.title}`}
                    title={schedule.enabled ? 'Pause' : 'Resume'}
                    disabled={busy === schedule.id}
                    onClick={() => void toggleSchedule(schedule)}
                  >
                    {schedule.enabled ? <Pause size={15} /> : <Play size={15} />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete schedule ${schedule.title}`}
                    disabled={busy === schedule.id}
                    onClick={() => confirmDelete('schedule', schedule.id, schedule.title)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          loaded && (
            <div className="quiet-empty">
              <CalendarClock size={18} />
              <p>No scheduled tasks yet. Add a daily or weekly routine here.</p>
            </div>
          )
        )}
      </section>
      <section className="personal-section">
        <div className="section-heading">
          <Brain size={19} />
          <div>
            <h2>What Sidekick remembers</h2>
            <p>Saved details you can review and remove.</p>
          </div>
        </div>
        {memories.length ? (
          <div>
            {memories.map((memory) => (
              <article className="memory-row" key={memory.id}>
                <p>{memory.text}</p>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Forget ${memory.text.slice(0, 70)}`}
                  onClick={() => confirmDelete('memory', memory.id, memory.text)}
                >
                  <Trash2 size={15} />
                </Button>
              </article>
            ))}
          </div>
        ) : (
          loaded && (
            <div className="quiet-empty">
              <Brain size={18} />
              <p>No saved details yet.</p>
            </div>
          )
        )}
      </section>
      {goalEditor && (
        <GoalEditor goal={goalEditor.goal} onClose={() => setGoalEditor(null)} onSaved={load} />
      )}
      {scheduleEditor && (
        <ScheduleEditor
          schedule={scheduleEditor.schedule}
          onClose={() => setScheduleEditor(null)}
          onSaved={load}
        />
      )}
      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
      >
        <DialogContent>
          <div className="dialog-heading">
            <DialogTitle>
              {deleting?.kind === 'memory' ? 'Forget this detail?' : 'Delete this schedule?'}
            </DialogTitle>
            <DialogDescription>
              {deleting?.kind === 'memory'
                ? 'This saved detail will be removed. Your conversation history stays unchanged.'
                : 'This schedule will be removed and will no longer run automatically.'}
            </DialogDescription>
          </div>
          <p className="delete-preview">{deleting?.label}</p>
          {deleteError && <Notice>{deleteError}</Notice>}
          <div className="dialog-actions">
            <Button variant="ghost" disabled={Boolean(busy)} onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button variant="destructive" disabled={Boolean(busy)} onClick={() => void remove()}>
              {busy
                ? 'Removing…'
                : deleting?.kind === 'memory'
                  ? 'Forget detail'
                  : 'Delete schedule'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
