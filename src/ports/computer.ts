import { browserErrorMessage, type BrowserErrorCode } from '../shared/browser-errors.ts';

export class BrowserActionError extends Error {
  constructor(readonly code: BrowserErrorCode) {
    super(browserErrorMessage(code));
    this.name = 'BrowserActionError';
  }
}

export interface BrowserAction {
  action:
    | 'open'
    | 'snapshot'
    | 'click'
    | 'fill'
    | 'press'
    | 'scroll'
    | 'select'
    | 'check'
    | 'uncheck'
    | 'hover'
    | 'drag'
    | 'back'
    | 'forward'
    | 'reload'
    | 'tab_list'
    | 'tab_switch';
  url?: string;
  tabId?: string;
  selector?: string;
  targetSelector?: string;
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
export const browserUploadBytes = 12 * 1024 * 1024;
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
export interface BrowserUploadInput {
  selector: string;
  name: string;
  bytes: Uint8Array;
}
export type CredentialKind = 'identifier' | 'password' | 'otp';
export interface LoginTarget {
  origin: string;
  kind: CredentialKind;
  usernameSelector?: string;
  passwordSelector?: string;
  emailCode?: boolean;
}
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
  group?: string;
  selected?: boolean;
}
export interface LoginInspection {
  origin: string;
  url: string;
  issue?: 'browser_not_supported';
  fields: LoginField[];
  methods: LoginMethod[];
  emailCode?: { recipient?: string; recipientHint?: string; length?: number };
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
}
export interface CredentialSubmission {
  status: 'submitted' | 'rejected';
}
export interface Computer {
  currentSession?(): { threadId: string; lastActivityAt: string } | undefined;
  bindProfile?(threadId: string, profileId: string, allowedOrigin?: string): Promise<void>;
  deleteProfile?(profileId: string): Promise<void>;
  act(threadId: string, input: BrowserAction, signal?: AbortSignal): Promise<BrowserObservation>;
  download?(
    threadId: string,
    input: BrowserDownloadInput,
    signal?: AbortSignal,
  ): Promise<BrowserDownload>;
  upload?(
    threadId: string,
    input: BrowserUploadInput,
    signal?: AbortSignal,
  ): Promise<BrowserObservation>;
  screenshot(threadId: string, signal?: AbortSignal): Promise<Buffer | null>;
  screenStatus?(threadId: string): {
    state: 'live' | 'last_known' | 'unavailable';
    capturedAt?: string;
  };
  injectCredentials(input: CredentialInput): Promise<CredentialSubmission | void>;
  inspectLogin(threadId: string, target?: LoginTarget): Promise<LoginInspection>;
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
