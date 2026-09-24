import { useEffect, useState } from 'react';
import { CalendarClock, Check, CircleCheck, Flag, Heart, Trash2, UserRound } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Field, Input, Loading, Notice, Textarea } from '../components/ui';

interface Profile { name: string; location: string; phone: string; preferences: string; }
interface Goal { id: string; title: string; description: string; progress: number; status: string; nextAction: string; targetDate: string; updatedAt: string; }
interface Schedule { id: string; title: string; prompt: string; cron: string; timeZone: string; enabled: boolean; nextRun?: string; }

export function You() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    void Promise.allSettled([api<Profile>('/api/profile'), api<Goal[]>('/api/goals'), api<Schedule[]>('/api/schedules')]).then(results => {
      const [profileResult, goalsResult, schedulesResult] = results;
      if (profileResult.status === 'fulfilled') setProfile(profileResult.value);
      if (goalsResult.status === 'fulfilled') setGoals(goalsResult.value);
      if (schedulesResult.status === 'fulfilled') setSchedules(schedulesResult.value);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') setError(errorMessage(failed.reason));
    });
  }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setSaved(false); setError('');
    try { await api('/api/profile', { method: 'PUT', body: JSON.stringify(profile) }); setSaved(true); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  async function remove() {
    if (!deleting) return;
    setRemoving(true);
    try { await api(`/api/schedules/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' }); setSchedules(current => current.filter(schedule => schedule.id !== deleting.id)); setDeleting(null); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setRemoving(false); }
  }
  function update(key: keyof Profile, value: string) { if (profile) setProfile({ ...profile, [key]: value }); setSaved(false); }
  return <div className="content-page you-page"><header className="page-heading"><div><h1>A little about you.</h1><p>The context that makes your Sidekick yours.</p></div><span className="heading-icon"><UserRound size={23} /></span></header>{error && <Notice>{error}</Notice>}
    {profile ? <form className="form-stack profile-form" onSubmit={event => void save(event)}><div className="profile-fields"><Field label="What should I call you?"><Input autoComplete="given-name" value={profile.name} onChange={event => update('name', event.target.value)} placeholder="Your name" /></Field><Field label="Where are you based?"><Input autoComplete="address-level2" value={profile.location} onChange={event => update('location', event.target.value)} placeholder="City or region" /></Field></div><Field label="Phone number" hint="Optional. Only used when it helps with a task you request."><Input autoComplete="tel" type="tel" value={profile.phone} onChange={event => update('phone', event.target.value)} placeholder="+351…" /></Field><Field label="What should I keep in mind?"><Textarea rows={4} value={profile.preferences} onChange={event => update('preferences', event.target.value)} placeholder="Your preferences, routines, and how you like things done." /></Field><div className="preferences-actions"><Button variant="secondary" disabled={saving}>{saving ? 'Saving…' : 'Save details'}</Button>{saved && <span className="saved-state" role="status"><Check size={15} />Saved</span>}</div></form> : !error && <Loading label="Loading your details…" />}
    <section className="personal-section"><div className="section-heading"><Flag size={19} /><div><h2>Things you’re working towards</h2><p>Tell Sidekick about a goal in your conversation.</p></div></div>{goals.length ? <div className="goals-list">{goals.map(goal => { const progress = Math.max(0, Math.min(100, Number(goal.progress) || 0)); return <article className="goal-row" key={goal.id}><div className="goal-heading"><h3>{goal.title}</h3><span>{['completed', 'succeeded'].includes(goal.status) ? <CircleCheck size={16} /> : `${progress}%`}</span></div>{goal.description && <p>{goal.description}</p>}<div className="goal-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label={goal.title}><span style={{ width: `${progress}%` }} /></div>{goal.nextAction && <small>Next: {goal.nextAction}</small>}{goal.targetDate && <small>By {new Date(goal.targetDate).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}</small>}</article>; })}</div> : <div className="quiet-empty"><Heart size={18} /><p>No goals yet. Start with something you’d like help making progress on.</p></div>}</section>
    <section className="personal-section"><div className="section-heading"><CalendarClock size={19} /><div><h2>On your schedule</h2><p>Ask for a daily check-in or a weekly reminder in chat.</p></div></div>{schedules.length ? <div className="schedules-list">{schedules.map(schedule => <article className="schedule-row" key={schedule.id}><div><h3>{schedule.title}</h3><p>{schedule.prompt}</p><small>{schedule.enabled ? schedule.nextRun ? `Next ${new Date(schedule.nextRun).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: schedule.timeZone })}` : 'Active' : 'Paused'} <span className="text-separator">/</span> {schedule.timeZone}</small></div><Button variant="ghost" size="icon" aria-label={`Delete schedule ${schedule.title}`} onClick={() => setDeleting(schedule)}><Trash2 size={15} /></Button></article>)}</div> : <div className="quiet-empty"><CalendarClock size={18} /><p>No scheduled tasks yet. A routine starts with a conversation.</p></div>}</section>
    <Dialog open={Boolean(deleting)} onOpenChange={value => { if (!value && !removing) setDeleting(null); }}><DialogContent><div className="dialog-heading"><DialogTitle>Remove this schedule?</DialogTitle><DialogDescription>{deleting?.title} will no longer run automatically.</DialogDescription></div><div className="dialog-actions"><Button variant="ghost" disabled={removing} onClick={() => setDeleting(null)}>Keep schedule</Button><Button variant="destructive" disabled={removing} onClick={() => void remove()}>{removing ? 'Removing…' : 'Remove schedule'}</Button></div></DialogContent></Dialog>
  </div>;
}
