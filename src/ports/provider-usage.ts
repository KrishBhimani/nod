import type { ProviderCategory } from '../shared/provider-usage.ts';
import type { ConversationRoutingFailureCode } from './conversation.ts';

export interface ProviderUsageEvent {
  id?: string;
  provider: string;
  category: ProviderCategory;
  operation: string;
  model?: string;
  taskId?: string;
  toolCallId?: string;
  toolName?: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  routingFailure?: {
    code: ConversationRoutingFailureCode;
    httpStatus?: number;
  };
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  audioSeconds?: number;
  characters?: number;
  messages?: number;
  bytes?: number;
  costUsd?: number | null;
  pricing?: 'reported' | 'sdk_estimate' | 'unavailable';
}

export type RecordProviderUsage = (event: ProviderUsageEvent) => void;
