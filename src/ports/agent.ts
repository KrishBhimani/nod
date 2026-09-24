import type { CredentialKind } from './computer.ts';
import type { Artifact } from '../shared/contracts.ts';

export interface RuntimeContext {
  taskId: string;
  ownerId: string;
  prompt: string;
  background?: boolean;
  channel?: string;
  timeZone?: string;
  history: Array<{
    role: string;
    text: string;
    createdAt?: string | Date;
    reaction?: string | null;
  }>;
  memories: string[];
  workspacePath: string;
  signal: AbortSignal;
  attachments: Array<{ path: string; mimeType: string }>;
  emit(type: string, summary: string): Promise<void>;
  reply(text: string, streamId?: string): Promise<void>;
  waitForUser?(question: string): Promise<void>;
  delta(text: string, streamId?: string, done?: boolean): void;
  remember(text: string): Promise<void>;
  publish(path: string, name?: string): Promise<Artifact>;
  createAudio?(text: string): Promise<Artifact>;
  requestCredential(input: {
    origin: string;
    label: string;
    kind: CredentialKind;
    usernameSelector?: string;
    passwordSelector?: string;
    submitSelector?: string;
  }): Promise<{ url?: string; filled?: boolean }>;
  integration(action: string, args: Record<string, unknown>): Promise<unknown>;
  manage(action: string, args: Record<string, unknown>): Promise<unknown>;
}
export interface RuntimeResult {
  status: 'succeeded' | 'waiting_credentials' | 'waiting_user';
  waitingFor?: 'question' | 'approval' | 'credentials';
  question?: string;
}
export interface AgentImage {
  type: 'image';
  data: string;
  mimeType: string;
}
export interface AgentToolResult {
  content: Array<{ type: 'text'; text: string } | AgentImage>;
  details?: unknown;
}
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<AgentToolResult>;
}
export type AgentEvent =
  | { type: 'turn_start' }
  | { type: 'message_start' }
  | { type: 'message_end' }
  | { type: 'text_delta'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error' };
export interface AgentSessionOptions {
  taskId: string;
  systemPrompt: string;
  tools: AgentTool[];
  onEvent(event: AgentEvent): void;
  shouldStop(): boolean;
}
export interface AgentSession {
  resumed: boolean;
  prompt(text: string, images: AgentImage[]): Promise<void>;
  abort(): void | Promise<void>;
  dispose(): void | Promise<void>;
}
export interface Agent {
  open(options: AgentSessionOptions): Promise<AgentSession>;
  dispose(): void | Promise<void>;
}
