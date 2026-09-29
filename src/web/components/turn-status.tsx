import { CircleCheck, CircleDashed, LoaderCircle, MessageCircle, CircleAlert } from 'lucide-react';
import type { TurnStatus } from '../../shared/contracts';

export const statusLabels: Record<TurnStatus, string> = {
  queued: 'Queued',
  running: 'Working',
  waiting: 'Needs your input',
  succeeded: 'Done',
  failed: 'Could not finish',
  cancelled: 'Stopped',
};
export const activeStatuses: TurnStatus[] = ['queued', 'running', 'waiting'];

export function StatusIcon({ status }: { status: TurnStatus }) {
  if (status === 'running') return <LoaderCircle size={15} className="spin" />;
  if (status === 'waiting') return <MessageCircle size={15} />;
  if (status === 'succeeded') return <CircleCheck size={15} />;
  if (status === 'failed') return <CircleAlert size={15} />;
  return <CircleDashed size={15} />;
}
