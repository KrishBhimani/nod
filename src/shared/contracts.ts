export type TaskStatus = 'queued' | 'running' | 'waiting_credentials' | 'waiting_user' | 'succeeded' | 'failed' | 'cancelled';
export interface Artifact { id: string; name: string; mimeType: string; size: number; url: string; }
export interface Message { id: string; role: 'user' | 'assistant'; text: string; taskId: string | null; createdAt: string; attachments: Artifact[]; }
export interface Task { id: string; title: string; status: TaskStatus; createdAt: string; updatedAt: string; error?: string; }
export interface TaskEvent { id: string; taskId: string; type: string; summary: string; createdAt: string; }
export interface VaultEntry { id: string; label: string; origin: string; usernameHint: string; updatedAt: string; }
export interface CredentialRequest { id: string; taskId: string; origin: string; label: string; kind: 'password' | 'otp'; status: 'pending' | 'filled' | 'expired'; expiresAt: string; }
export interface Connection { slug: 'gmail' | 'googlecalendar' | 'googledrive' | 'googlesheets' | 'googledocs'; name: string; status: 'not_configured' | 'disconnected' | 'connected'; accountId?: string; triggersEnabled: boolean; }
export interface Configuration { provider: string; model: string; llmReady: boolean; speechReady: boolean; composioReady: boolean; jevReady: boolean; inspectorEnabled: boolean; localOnly: boolean; }
export interface AppState { messages: Message[]; tasks: Task[]; configuration: Configuration; }
export interface InspectorState { tasks: Task[]; events: TaskEvent[]; runtime: { browser: string; workspace: string; database: string }; }
export interface MemoryFact { id: string; text: string; sourceMessageId: string | null; createdAt: string; }
export interface BrowserObservation { text: string; url: string; screenshotUrl?: string; }
export interface RuntimeContext {
  taskId: string; ownerId: string; prompt: string; background?: boolean; history: Array<{ role: string; text: string }>; memories: string[];
  workspacePath: string; signal: AbortSignal; attachments: Array<{ path: string; mimeType: string }>;
  emit(type: string, summary: string): Promise<void>;
  reply(text: string): Promise<void>;
  delta(text: string): void;
  remember(text: string): Promise<void>;
  publish(path: string, name?: string): Promise<Artifact>;
  createAudio?(text: string): Promise<Artifact>;
  requestCredential(input: { origin: string; label: string; kind: 'password' | 'otp'; usernameSelector?: string; passwordSelector: string; submitSelector?: string }): Promise<{ url?: string; filled?: boolean }>;
  integration(action: string, args: Record<string, unknown>): Promise<unknown>;
  manage(action: string, args: Record<string, unknown>): Promise<unknown>;
}
export interface RuntimeResult { status: 'succeeded' | 'waiting_credentials' | 'waiting_user'; }
