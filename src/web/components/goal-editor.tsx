import { useState } from 'react';
import type { Goal } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
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

export function GoalEditor({
  goal,
  onClose,
  onSaved,
}: {
  goal: Goal | null;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const [title, setTitle] = useState(goal?.title ?? '');
  const [description, setDescription] = useState(goal?.description ?? '');
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '');
  const [progress, setProgress] = useState(String(goal?.progress ?? 0));
  const [status, setStatus] = useState<Goal['status']>(goal?.status ?? 'active');
  const [nextAction, setNextAction] = useState(goal?.nextAction ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(goal ? `/api/goals/${encodeURIComponent(goal.id)}` : '/api/goals', {
        method: goal ? 'PATCH' : 'POST',
        body: JSON.stringify({
          title,
          description,
          targetDate: targetDate || null,
          ...(goal ? { progress: Number(progress), status, nextAction } : {}),
        }),
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
          <DialogTitle>{goal ? 'Edit your goal' : 'A goal to work towards'}</DialogTitle>
          <DialogDescription>
            {goal
              ? 'Keep your progress and next step up to date.'
              : 'Start with what you want to achieve.'}
          </DialogDescription>
        </div>
        <form className="form-stack" onSubmit={(event) => void save(event)}>
          <Field label="Goal">
            <Input
              required
              maxLength={150}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
            />
          </Field>
          <Field label="What does success look like?">
            <Textarea
              rows={3}
              maxLength={6000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field label="Target date" hint="Optional">
            <Input
              type="date"
              value={targetDate}
              onChange={(event) => setTargetDate(event.target.value)}
            />
          </Field>
          {goal && (
            <>
              <div className="form-pair">
                <Field label="Progress (%)">
                  <Input
                    required
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={progress}
                    onChange={(event) => setProgress(event.target.value)}
                  />
                </Field>
                <Field label="Status">
                  <select
                    className="input"
                    value={status}
                    onChange={(event) => setStatus(event.target.value as Goal['status'])}
                  >
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                    <option value="completed">Completed</option>
                  </select>
                </Field>
              </div>
              <Field label="Next step">
                <Textarea
                  rows={2}
                  maxLength={2000}
                  value={nextAction}
                  onChange={(event) => setNextAction(event.target.value)}
                />
              </Field>
            </>
          )}
          {error && <Notice>{error}</Notice>}
          <div className="dialog-actions">
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={busy}>{busy ? 'Saving…' : goal ? 'Save changes' : 'Add goal'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
