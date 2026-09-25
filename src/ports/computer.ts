import { browserErrorMessage, type BrowserErrorCode } from '../shared/browser-errors.ts';

export class BrowserActionError extends Error {
  constructor(readonly code: BrowserErrorCode) {
    super(browserErrorMessage(code));
    this.name = 'BrowserActionError';
  }
}

export interface BrowserAction {
  action: 'open' | 'snapshot' | 'click' | 'fill' | 'scroll';
  url?: string;
  selector?: string;
  text?: string;
  direction?: 'up' | 'down';
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
}
export interface CredentialInput {
  taskId: string;
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
export type ManualBrowserInput =
  | { action: 'click'; x: number; y: number }
  | { action: 'type'; text: string }
  | {
      action: 'press';
      key:
        | 'Enter'
        | 'Tab'
        | 'Shift+Tab'
        | 'Escape'
        | 'Backspace'
        | 'ArrowUp'
        | 'ArrowDown'
        | 'ArrowLeft'
        | 'ArrowRight'
        | 'ControlOrMeta+A';
    }
  | { action: 'scroll'; direction: 'up' | 'down' };
export interface Computer {
  currentSession?(): { taskId: string; lastActivityAt: string } | undefined;
  takeControl?(taskId: string): Promise<void>;
  openSignIn?(taskId: string): Promise<void>;
  finishSignIn?(taskId: string): Promise<void>;
  signInScreenshot?(taskId: string, signal?: AbortSignal): Promise<Buffer | null>;
  signInControl?(taskId: string, input: ManualBrowserInput): Promise<void>;
  control?(taskId: string, input: ManualBrowserInput): Promise<void>;
  releaseControl?(taskId: string): Promise<void>;
  act(taskId: string, input: BrowserAction, signal?: AbortSignal): Promise<BrowserObservation>;
  screenshot(taskId: string, signal?: AbortSignal): Promise<Buffer | null>;
  screenStatus?(taskId: string): {
    state: 'live' | 'last_known' | 'unavailable';
    capturedAt?: string;
  };
  injectCredentials(input: CredentialInput): Promise<CredentialSubmission | void>;
  inspectLogin(taskId: string): Promise<LoginInspection>;
  selectLoginMethod(taskId: string, origin: string, methodId: string): Promise<void>;
  hold(taskId: string, until: number | null): Promise<void>;
  close(taskId: string): Promise<void>;
  dispose(): Promise<void>;
  status(): string;
}
export interface WorkspaceSession {
  path: string;
  instructions: string;
  execute(command: string, timeoutSeconds?: number): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  resolveArtifact(path: string): Promise<string>;
}
export interface Workspace {
  open(input: { taskId: string; workspacePath: string; signal: AbortSignal }): WorkspaceSession;
  status(): string;
  dispose(): void | Promise<void>;
}
export type BrowserChooser = (
  goal: string,
  observation: BrowserObservation,
  signal?: AbortSignal,
) => Promise<{ action?: BrowserAction; outcome: string; elapsedMs: number }>;
