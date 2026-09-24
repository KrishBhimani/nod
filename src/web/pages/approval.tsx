import { useEffect, useState } from 'react';
import { Check, CircleAlert, LoaderCircle, Send, ShieldCheck, Sparkles } from 'lucide-react';
import type { Approval } from '../../shared/contracts';
import { api, post } from '../lib/api';
import { scheduleLabel } from '../lib/schedules';
import { Button, Loading, Notice } from '../components/ui';

const outcomes = {
  completed: {
    title: 'Action completed.',
    detail: 'Your approved action finished. Sidekick can continue.',
  },
  declined: {
    title: 'Action not approved.',
    detail: 'Sidekick will continue without this action.',
  },
  expired: {
    title: 'This approval expired.',
    detail: 'Return to your conversation for the next step.',
  },
  executing: {
    title: 'Action in progress.',
    detail: 'Your decision was saved. Wait for the result before taking further action.',
  },
  uncertain: {
    title: 'This action needs a check.',
    detail:
      'Sidekick could not confirm the result. Check what happened before asking it to repeat the action.',
  },
};

const personalActions: Record<string, string> = {
  profile_update: 'Update your details',
  goal_create: 'Create a goal',
  goal_update: 'Update a goal',
  schedule_create: 'Create a schedule',
  schedule_update: 'Update a schedule',
  schedule_cancel: 'Pause a schedule',
  memory_propose: 'Remember a detail',
};

const personalFields: Record<string, string> = {
  text: 'Remember this',
  name: 'Name',
  location: 'Location',
  phone: 'Phone number',
  preferences: 'Preferences',
  title: 'Name',
  description: 'What success looks like',
  progress: 'Progress',
  nextAction: 'Next step',
  status: 'Status',
  targetDate: 'Target date',
  prompt: 'What Sidekick will do',
  cron: 'When',
  timeZone: 'Time zone',
  enabled: 'Status',
};

function fieldLabel(key: string) {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function DetailValue({ value }: { value: unknown }) {
  if (Array.isArray(value))
    return value.length ? (
      <ol className="approval-list">
        {value.map((item, index) => (
          <li key={index}>
            <DetailValue value={item} />
          </li>
        ))}
      </ol>
    ) : (
      <span className="approval-empty">No items</span>
    );
  if (value && typeof value === 'object')
    return <DetailFields values={value as Record<string, unknown>} />;
  if (value === null) return <span className="approval-empty">Not set</span>;
  if (value === '') return <span className="approval-empty">Empty</span>;
  return (
    <span className="approval-value">
      {typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}
    </span>
  );
}

function DetailFields({
  values,
  personalAction,
  targetName,
}: {
  values: Record<string, unknown>;
  personalAction?: string;
  targetName?: string;
}) {
  const fields = Object.entries(values);
  if (!fields.length) return <span className="approval-empty">No additional details</span>;
  return (
    <dl className="approval-fields">
      {fields.map(([key, raw]) => {
        const sensitive = /password|secret|authorization|access.?token|refresh.?token/i.test(key);
        let value = sensitive ? 'Hidden sensitive value' : raw;
        let label = personalAction ? (personalFields[key] ?? fieldLabel(key)) : fieldLabel(key);
        if (personalAction) {
          if (key === 'id') {
            label = personalAction.startsWith('goal_') ? 'Goal' : 'Schedule';
            value = targetName ?? raw;
          }
          if (key === 'progress' && typeof raw === 'number') value = `${raw}%`;
          if (key === 'enabled' && typeof raw === 'boolean') value = raw ? 'Active' : 'Paused';
          if (key === 'status' && typeof raw === 'string') value = fieldLabel(raw);
          if (key === 'cron' && typeof raw === 'string') {
            const description = scheduleLabel(raw);
            value = description === 'Custom timing' ? `Custom timing: ${raw}` : description;
          }
          if (key === 'targetDate' && typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw))
            value = new Date(`${raw}T12:00:00Z`).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
              timeZone: 'UTC',
            });
          if (raw === null || raw === '')
            value = key === 'targetDate' ? 'No target date' : 'Clear this field';
        }
        return (
          <div className="approval-field" key={key}>
            <dt>{label}</dt>
            <dd>
              <DetailValue value={value} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function ApprovalDetails({
  approval,
  personalAction,
}: {
  approval: Approval;
  personalAction?: string;
}) {
  const [targetName, setTargetName] = useState<string>();
  const targetId = approval.args.id;
  useEffect(() => {
    setTargetName(undefined);
    if (typeof targetId !== 'string' || !personalAction) return;
    const resource = personalAction.startsWith('goal_')
      ? 'goals'
      : personalAction.startsWith('schedule_')
        ? 'schedules'
        : null;
    if (!resource) return;
    let current = true;
    void api<Array<{ id: string; title: string }>>(`/api/${resource}`)
      .then((items) => {
        if (current) setTargetName(items.find((item) => item.id === targetId)?.title);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [targetId, personalAction]);
  return (
    <section className="approval-details" aria-label="Action details">
      <DetailFields
        values={approval.args}
        personalAction={personalAction}
        targetName={targetName}
      />
    </section>
  );
}

export function ApprovalPage({ id }: { id: string }) {
  const [approval, setApproval] = useState<Approval | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const path = `/api/approvals/${encodeURIComponent(id)}`;
  useEffect(() => {
    if (window.location.search || window.location.hash)
      window.history.replaceState(null, '', window.location.pathname);
    void api<Approval>(path)
      .then(setApproval)
      .catch(() =>
        setError(
          'This approval is unavailable. Return to your conversation for the latest status.',
        ),
      );
  }, [path]);
  useEffect(() => {
    if (approval?.status !== 'executing') return;
    const timer = window.setInterval(() => {
      void api<Approval>(path)
        .then(setApproval)
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [approval?.status, path]);
  async function decide(approved: boolean) {
    setBusy(true);
    setError('');
    try {
      await post(path, { approved });
      setApproval(await api<Approval>(path));
    } catch {
      try {
        setApproval(await api<Approval>(path));
        setError('Check the recorded action status before continuing.');
      } catch {
        setApproval((current) => (current ? { ...current, status: 'uncertain' } : current));
        setError(
          'The service could not confirm the result. Return to your conversation to check it.',
        );
      }
    } finally {
      setBusy(false);
    }
  }
  const pending = approval?.status === 'pending';
  const outcome =
    approval && !pending
      ? (outcomes[approval.status as keyof typeof outcomes] ?? outcomes.uncertain)
      : null;
  const personalAction = approval?.action.startsWith('SIDEKICK_')
    ? approval.action.slice('SIDEKICK_'.length)
    : undefined;
  return (
    <main className="credential-page">
      <a className="brand credential-brand" href="/">
        <span className="brand-mark">
          <Sparkles size={19} />
        </span>
        Sidekick
      </a>
      <div className="credential-card approval-card">
        {!approval && !error ? (
          <Loading label="Loading action details…" />
        ) : outcome ? (
          <div className="credential-complete">
            <div
              className={approval?.status === 'completed' ? 'success-mark' : 'credential-symbol'}
            >
              {approval?.status === 'executing' ? (
                <LoaderCircle size={24} className="spin" />
              ) : approval?.status === 'completed' ? (
                <Check size={24} />
              ) : (
                <CircleAlert size={24} />
              )}
            </div>
            <h1>{outcome.title}</h1>
            <p>{outcome.detail}</p>
            <Button asChild>
              <a href="/">Back to the conversation</a>
            </Button>
          </div>
        ) : (
          <>
            <div className="credential-symbol">
              <Send size={22} />
            </div>
            <h1>A quick check with you.</h1>
            <p className="credential-intro">Review this action before Sidekick continues.</p>
            {approval && (
              <>
                <div className="approval-operation">
                  <span>Action</span>
                  <strong>
                    {personalAction
                      ? (personalActions[personalAction] ?? approval.action)
                      : approval.action}
                  </strong>
                </div>
                <ApprovalDetails approval={approval} personalAction={personalAction} />
                <div className="approval-actions">
                  <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>
                    Don’t allow
                  </Button>
                  <Button disabled={busy} onClick={() => void decide(true)}>
                    {busy ? 'Saving…' : 'Allow this action'}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
        {error && <Notice>{error}</Notice>}
        <div className="credential-privacy">
          <ShieldCheck size={16} />
          <span>Your decision applies to this action only.</span>
        </div>
      </div>
    </main>
  );
}
