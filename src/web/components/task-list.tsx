import {
  CircleCheck,
  CircleDashed,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  CircleAlert,
} from 'lucide-react';
import type { TaskStatus } from '../../shared/contracts';

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
