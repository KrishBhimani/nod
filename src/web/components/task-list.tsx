import { useState } from 'react';
import {
  ArrowUpRight,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  X,
  CircleAlert,
} from 'lucide-react';
import type { Task, TaskStatus } from '../../shared/contracts';
import { Button, Notice } from './ui';
import { errorMessage, post } from '../lib/api';

export const statusLabels: Record<TaskStatus, string> = {
  queued: 'Queued',
  running: 'Working',
  waiting_credentials: 'Needs a login',
  waiting_user: 'Needs your input',
  succeeded: 'Done',
  failed: 'Could not finish',
  cancelled: 'Stopped',
};
export const activeStatuses: TaskStatus[] = [
  'queued',
  'running',
  'waiting_credentials',
  'waiting_user',
];

export function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === 'running') return <LoaderCircle size={15} className="spin" />;
  if (status === 'waiting_credentials') return <LockKeyhole size={15} />;
  if (status === 'waiting_user') return <MessageCircle size={15} />;
  if (status === 'succeeded') return <CircleCheck size={15} />;
  if (status === 'failed') return <CircleAlert size={15} />;
  return <CircleDashed size={15} />;
}

export function TaskList({
  tasks,
  onContinue,
  onRefresh,
}: {
  tasks: Task[];
  onContinue(task: Task): void;
  onRefresh(): Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState('');
  const [error, setError] = useState('');
  const active = tasks.filter((task) => activeStatuses.includes(task.status));
  if (!tasks.length) return null;
  const visible = expanded ? tasks.slice(0, 8) : active.slice(0, 3);
  async function cancel(id: string) {
    setCancelling(id);
    setError('');
    try {
      await post(`/api/tasks/${encodeURIComponent(id)}/cancel`);
      await onRefresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCancelling('');
    }
  }
  return (
    <section className="task-strip" aria-label="Tasks">
      <button
        className="task-strip-toggle"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span>
          <span className={`activity-dot ${active.length ? 'active' : ''}`} />
          {active.length
            ? `${active.length} ${active.length === 1 ? 'task' : 'tasks'} in progress`
            : 'Recent tasks'}
        </span>
        <ChevronDown size={14} className={expanded ? 'rotate-180' : ''} />
      </button>
      {visible.length > 0 && (
        <div className="task-rows">
          {visible.map((task) => (
            <div className="task-row" key={task.id}>
              <span className={`task-status-icon status-${task.status}`}>
                <StatusIcon status={task.status} />
              </span>
              <div className="task-row-text">
                <span>{task.title}</span>
                <small>{statusLabels[task.status]}</small>
                {task.error && <small className="error-text">{task.error}</small>}
              </div>
              {!['queued', 'running', 'waiting_credentials'].includes(task.status) && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onContinue(task)}
                  aria-label={`Continue ${task.title}`}
                  title="Continue this task"
                >
                  <ArrowUpRight size={16} />
                </Button>
              )}
              {activeStatuses.includes(task.status) && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void cancel(task.id)}
                  disabled={cancelling === task.id}
                  aria-label={`Stop ${task.title}`}
                  title="Stop task"
                >
                  <X size={15} />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {error && <Notice>{error}</Notice>}
    </section>
  );
}
