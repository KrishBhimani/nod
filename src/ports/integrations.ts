import type { IntegrationService } from '../shared/integrations.ts';
export type { IntegrationService, IntegrationDownloadAction } from '../shared/integrations.ts';
export interface IntegrationFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}
export interface IntegrationSearch {
  tools: unknown;
  suggestions: Array<{ useCase: string; primaryToolSlugs: string[] }>;
}
export interface IntegrationSession {
  id: string;
  authorize(
    service: IntegrationService,
    callbackUrl: string,
  ): Promise<{ accountId: string; url: string }>;
  search(query: string): Promise<IntegrationSearch>;
  execute(action: string, args: Record<string, unknown>, accountId?: string): Promise<unknown>;
  download?(
    action: string,
    args: Record<string, unknown>,
    accountId: string,
    signal?: AbortSignal,
  ): Promise<IntegrationFile>;
}
export interface IntegrationEvent {
  id: string;
  ownerId: string;
  service: string;
  accountId: string;
  subscriptionId: string;
  trigger: string;
  data: Record<string, unknown>;
}
export interface IntegrationProvider {
  id: string;
  configured: boolean;
  supportedServices?: readonly IntegrationService[];
  webhooksConfigured: boolean;
  supportsSubscriptions: readonly IntegrationService[];
  createSession(
    ownerId: string,
    accounts: Partial<Record<IntegrationService, string | string[]>>,
  ): Promise<IntegrationSession>;
  restoreSession(id: string): Promise<IntegrationSession>;
  deleteSession(id: string): Promise<void>;
  inspectAccount(
    id: string,
    ownerId: string,
  ): Promise<{
    active: boolean;
    service: string;
    accountName?: string;
    accountEmail?: string;
  }>;
  deleteAccount(id: string): Promise<void>;
  parseCallback(query: unknown): { state: string; accountId: string; success: boolean };
  subscribe(
    ownerId: string,
    service: IntegrationService,
    accountId: string,
  ): Promise<{ id: string }>;
  unsubscribe(id: string): Promise<void>;
  verifyWebhook(
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<IntegrationEvent>;
  matchesSubscription(service: IntegrationService, trigger: string): boolean;
}
