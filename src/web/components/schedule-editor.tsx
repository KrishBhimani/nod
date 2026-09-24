import { useState } from 'react';
import type { Schedule } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import {
  readSchedule,
  scheduleExpression,
  weekDays,
  type ScheduleFrequency,
} from '../lib/schedules';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  Input,
  Notice,
  Textarea,
} from './ui';

export function ScheduleEditor({
  schedule,
  onClose,
  onSaved,
}: {
  schedule: Schedule | null;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const original = schedule
    ? readSchedule(schedule.cron)
    : { frequency: 'daily' as const, time: '09:00', day: '1' };
  const [title, setTitle] = useState(schedule?.title ?? '');
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '');
  const [frequency, setFrequency] = useState<ScheduleFrequency>(original.frequency);
  const [time, setTime] = useState(original.time);
  const [day, setDay] = useState(original.day);
  const [timeZone, setTimeZone] = useState(
    schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Europe/Lisbon',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const cron = scheduleExpression(frequency, time, day, schedule?.cron);
      await api(schedule ? `/api/schedules/${encodeURIComponent(schedule.id)}` : '/api/schedules', {
        method: schedule ? 'PATCH' : 'POST',
        body: JSON.stringify({ title, prompt, cron, timeZone }),
      });
      await onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <div className="dialog-heading">
          <DialogTitle>{schedule ? 'Edit this schedule' : 'Make a little routine'}</DialogTitle>
          <DialogDescription>
            Sidekick runs this while your local workspace is open.
          </DialogDescription>
        </div>
        <form className="form-stack" onSubmit={(event) => void save(event)}>
          <Field label="Name">
            <Input
              required
              maxLength={100}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
              placeholder="Morning check-in"
            />
          </Field>
          <Field label="What should Sidekick do?">
            <Textarea
              required
              rows={3}
              maxLength={6000}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Help me prepare for the day ahead."
            />
          </Field>
          <Field label="Repeat">
            <select
              className="input"
              value={frequency}
              onChange={(event) => setFrequency(event.target.value as ScheduleFrequency)}
            >
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              {original.frequency === 'custom' && (
                <option value="custom">Keep current timing</option>
              )}
            </select>
          </Field>
          {frequency !== 'custom' && (
            <div className="form-pair">
              {frequency === 'weekly' && (
                <Field label="Day">
                  <select
                    className="input"
                    value={day}
                    onChange={(event) => setDay(event.target.value)}
                  >
                    {weekDays.map((label, index) => (
                      <option key={label} value={index}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Time">
                <Input
                  type="time"
                  required
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                />
              </Field>
            </div>
          )}
          <Field label="Time zone">
            <Input
              required
              maxLength={100}
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
              placeholder="Europe/Lisbon"
            />
          </Field>
          {error && <Notice>{error}</Notice>}
          <div className="dialog-actions">
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={busy}>
              {busy ? 'Saving…' : schedule ? 'Save changes' : 'Add schedule'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
