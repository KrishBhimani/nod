import { browserErrorMessage, type BrowserErrorCode } from '../shared/browser-errors.ts';

export class BrowserActionError extends Error {
  constructor(readonly code: BrowserErrorCode) {
    super(browserErrorMessage(code));
    this.name = 'BrowserActionError';
  }
}

export interface BrowserAction {
  action: 'open' | 'snapshot' | 'click' | 'fill' | 'press' | 'scroll';
  url?: string;
  selector?: string;
  text?: string;
  key?: 'Enter' | 'Escape' | 'Tab' | 'ArrowDown' | 'ArrowUp' | 'PageDown' | 'PageUp';
  direction?: 'up' | 'down';
  waitMs?: number;
  offset?: number;
  controlOffset?: number;
}
export interface BrowserCandidate {
  id: string;
  label: string;
}
export interface BrowserObservation {
  text: string;
  url: string;
  candidates: BrowserCandidate[];
}
export const browserDownloadBytes = 12 * 1024 * 1024;
export interface BrowserDownloadInput {
  selector?: string;
  url?: string;
  name?: string;
}
export interface BrowserDownload {
  bytes: Buffer;
  name: string;
  mimeType: string;
}
export type CredentialKind = 'identifier' | 'password' | 'otp';
export interface LoginField {
  kind: CredentialKind;
  selector: string;
  label: string;
}
export interface LoginMethod {
  id: string;
  label: string;
  kind: 'credentials' | 'oauth' | 'passkey' | 'manual';
  supported: boolean;
  reason?: string;
  selector?: string;
}
export interface LoginInspection {
  origin: string;
  url: string;
  issue?: 'browser_not_supported';
  fields: LoginField[];
  methods: LoginMethod[];
  submitSelector?: string;
  emailCode?: { recipient: string; length?: number };
}
export interface CredentialInput {
  threadId: string;
  origin: string;
  kind?: CredentialKind;
  username?: string;
  password?: string;
  code?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}
export interface CredentialSubmission {
  status: 'submitted' | 'rejected';
}
export type ManualBrowserInput = import('../shared/browser-input.ts').BrowserInput;
export interface Computer {
  currentSession?(): { threadId: string; lastActivityAt: string } | undefined;
  bindProfile?(threadId: string, profileId: string, allowedOrigin?: string): Promise<void>;
  deleteProfile?(profileId: string): Promise<void>;
  takeControl?(threadId: string): Promise<void>;
  openSignIn?(threadId: string): Promise<void>;
  finishSignIn?(threadId: string): Promise<void>;
  signInScreenshot?(threadId: string, signal?: AbortSignal): Promise<Buffer | null>;
  signInControl?(threadId: string, input: ManualBrowserInput): Promise<void>;
  control?(threadId: string, input: ManualBrowserInput): Promise<void>;
  releaseControl?(threadId: string): Promise<void>;
  act(threadId: string, input: BrowserAction, signal?: AbortSignal): Promise<BrowserObservation>;
  download?(
    threadId: string,
    input: BrowserDownloadInput,
    signal?: AbortSignal,
  ): Promise<BrowserDownload>;
  screenshot(threadId: string, signal?: AbortSignal): Promise<Buffer | null>;
  screenStatus?(threadId: string): {
    state: 'live' | 'last_known' | 'unavailable';
    capturedAt?: string;
  };
  injectCredentials(input: CredentialInput): Promise<CredentialSubmission | void>;
  inspectLogin(threadId: string): Promise<LoginInspection>;
  selectLoginMethod(threadId: string, origin: string, methodId: string): Promise<void>;
  hold(threadId: string, until: number | null): Promise<void>;
  close(threadId: string): Promise<void>;
  dispose(): Promise<void>;
  status(): string;
}
export interface WorkspaceExecOptions {
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onData?(chunk: Buffer): void;
}
export interface WorkspaceSession {
  path: string;
  instructions: string;
  exec(command: string, options?: WorkspaceExecOptions): Promise<{ exitCode: number }>;
  executeProgram?(
    program: string,
    args: string[],
    environment: Record<string, string>,
    timeoutSeconds?: number,
  ): Promise<{ exitCode: number; output: string }>;
}
export interface Workspace {
  connectedCliAvailable?: boolean;
  writeArtifact?(
    threadId: string,
    path: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void>;
  readArtifact?(
    threadId: string,
    path: string,
    maxBytes: number,
    purpose?: 'attachment' | 'publication',
  ): Promise<Uint8Array>;
  open(input: { threadId: string; workspacePath: string; signal: AbortSignal }): WorkspaceSession;
  status(): string;
  dispose(): void | Promise<void>;
}
