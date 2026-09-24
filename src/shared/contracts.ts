export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_credentials'
  | 'waiting_user'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export interface Artifact {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  taskId: string | null;
  createdAt: string;
  attachments: Artifact[];
  streamId?: string | null;
  reaction?: 'like' | 'dislike' | 'heart' | null;
}
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
export interface TaskEvent {
  id: string;
  taskId: string;
  type: string;
  summary: string;
  createdAt: string;
}
export interface VaultEntry {
  id: string;
  label: string;
  origin: string;
  usernameHint: string;
  updatedAt: string;
}
export interface CredentialRequest {
  id: string;
  taskId: string;
  origin: string;
  label: string;
  kind: 'identifier' | 'password' | 'otp';
  fields?: { kind: 'identifier' | 'password' | 'otp'; selector: string; label: string }[];
  methods?: {
    id: string;
    label: string;
    kind: 'credentials' | 'oauth' | 'passkey' | 'manual';
    supported: boolean;
    reason?: string;
  }[];
  status: 'pending' | 'filled' | 'expired';
  expiresAt: string;
}
export interface Connection {
  slug: string;
  name: string;
  status: 'not_configured' | 'disconnected' | 'connected';
  accountId?: string;
  connectionId?: string;
  accountName?: string;
  accountEmail?: string;
  triggersActive?: boolean;
  triggerStatus?: 'active' | 'pending' | 'unavailable' | 'disabled';
  triggersEnabled: boolean;
  description?: string;
  supportsTriggers?: boolean;
}
export interface Configuration {
  provider: string;
  model: string;
  llmReady: boolean;
  speechReady: boolean;
  integrationsReady: boolean;
  browserAssistReady: boolean;
  inspectorEnabled: boolean;
  localOnly: boolean;
}
export interface AppState {
  messages: Message[];
  tasks: Task[];
  configuration: Configuration;
}
export interface InspectorState {
  tasks: Task[];
  events: TaskEvent[];
  runtime: { browser: string; workspace: string; database: string };
}
export interface MemoryFact {
  id: string;
  text: string;
  sourceMessageId: string | null;
  createdAt: string;
}
export interface Profile {
  name: string;
  location: string;
  phone: string;
  preferences: string;
}
export interface Goal {
  id: string;
  title: string;
  description: string;
  progress: number;
  status: 'active' | 'paused' | 'completed';
  nextAction: string;
  targetDate: string | null;
  updatedAt: string;
}
export interface Schedule {
  id: string;
  title: string;
  prompt: string;
  cron: string;
  timeZone: string;
  enabled: boolean;
}
export interface Approval {
  id: string;
  action: string;
  args: Record<string, unknown>;
  status: 'pending' | 'executing' | 'completed' | 'declined' | 'uncertain' | 'expired';
}
export interface Preferences {
  notificationRule: string;
  timeZone: string;
  quietStart: string;
  quietEnd: string;
}
