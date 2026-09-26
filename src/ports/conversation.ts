import type { TaskStatus } from '../shared/contracts.ts';

export const defaultConversationRoutingTimeoutMs = 5000;

export interface ConversationRoutingContext {
  text: string;
  hasAttachments: boolean;
  channel: string;
  conversationRevision: number;
  recentConversation?: Array<{
    role: 'user' | 'assistant';
    text: string;
    outcomeId: string | null;
  }>;
  candidates: Array<{
    outcomeId: string;
    title: string;
    objective: string;
    taskId: string;
    status: TaskStatus;
    waitingReason: string | null;
    recentMessages: Array<{ role: 'user' | 'assistant'; text: string }>;
  }>;
  signal: AbortSignal;
}

export type ConversationRouteDecision =
  | { kind: 'conversation' }
  | { kind: 'new_outcome'; title: string; objective: string }
  | { kind: 'continue'; outcomeId: string };

export type ConversationRouter = (
  context: ConversationRoutingContext,
) => Promise<ConversationRouteDecision>;
