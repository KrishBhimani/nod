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

export interface InspectorObservationsResponse {
  calls: ToolCall[];
  usage: ModelUsage[];
  summary: {
    calls: number;
    modelRequests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    knownCostUsd: number | null;
    unpricedRequests: number;
  };
  hasOlder: boolean;
  nextBefore?: string;
  nextBeforeId?: string;
}
