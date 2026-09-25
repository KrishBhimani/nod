export interface InspectorWorkItem {
  taskId: string;
  title: string;
  status: 'running' | 'queued' | 'waiting_user' | 'waiting_credentials';
  source: 'conversation' | 'schedule' | 'review' | 'event';
  waitingReason: string | null;
  queuedInputs: number;
  executions: number;
  updatedAt: string;
}

export interface InspectorScheduledWork {
  id: string;
  title: string;
  runAt: string | null;
  timeZone: string;
  queued: boolean;
}

export interface InspectorReviewStatus {
  configured: boolean;
  scheduled: boolean;
  cron: string | null;
  timeZone: string | null;
}

export interface InspectorDecision {
  id: string;
  kind: 'review' | 'external';
  decision: 'wake' | 'digest' | 'ignore';
  reason: string;
  createdAt: string;
  taskId: string | null;
}

export interface InspectorWorkResponse {
  scope: 'owner';
  active: InspectorWorkItem[];
  activeTotal: number;
  upcoming: InspectorScheduledWork[];
  upcomingTotal: number;
  review: InspectorReviewStatus | null;
  decisions: InspectorDecision[];
  decisionsTotal: number;
  decisionWindowHours: number;
}
