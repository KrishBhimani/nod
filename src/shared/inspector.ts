export interface InspectorTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface InspectorToolsResponse {
  tools: InspectorTool[];
  captureEnabled: boolean;
  retentionDays: number;
  payloadLimitBytes: number;
}

export interface ToolCall {
  id: string;
  taskId: string;
  revision: number;
  name: string;
  input: unknown;
  output: unknown | null;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  providerOperations?: number;
  pricedOperations?: number;
  directCostUsd?: number | null;
  pricing?: 'reported' | 'sdk_estimate' | 'mixed' | 'unavailable';
}

export interface ModelUsage {
  id: string;
  taskId: string;
  revision: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costSource: 'sdk_estimate' | 'unavailable';
  createdAt: string;
}

export interface ToolUsage {
  name: string;
  calls: number;
  succeeded: number;
  failed: number;
  running: number;
  cancelled: number;
  interrupted: number;
  durationSamples: number;
  totalDurationMs: number | null;
  averageDurationMs: number | null;
  maxDurationMs: number | null;
  lastStartedAt: string;
  providerOperations?: number;
  pricedOperations?: number;
  directCostUsd?: number | null;
  pricing?: 'reported' | 'sdk_estimate' | 'mixed' | 'unavailable';
}

export interface InspectorFailure {
  id: string;
  taskId: string;
  revision: number;
  occurredAt: string;
  diagnostic: unknown;
}

export interface InspectorObservationsResponse {
  scope?: 'task' | 'owner';
  taskId?: string;
  calls: ToolCall[];
  usage: ModelUsage[];
  failures?: InspectorFailure[];
  toolUsage: ToolUsage[];
  summary: {
    calls: number;
    modelRequests: number;
    failures?: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    knownCostUsd: number | null;
    unpricedRequests: number;
    providerOperations?: number;
    pricedProviderOperations?: number;
    directProviderCostUsd?: number | null;
  };
  hasOlder: boolean;
  nextBefore?: string;
  nextBeforeId?: string;
}
