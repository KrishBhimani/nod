export interface InspectorPrompt {
  id: string;
  taskId: string;
  title: string;
  revision: number;
  system: string;
  instruction: string;
  resumed: boolean;
  imageCount: number;
  reason: 'user' | 'secure_resume';
  provider: string;
  model: string;
  createdAt: string;
}

export interface InspectorPromptsResponse {
  prompts: InspectorPrompt[];
  captureEnabled: boolean;
  retentionDays: number;
  dropped: number;
  hasOlder: boolean;
  nextBefore?: string;
  nextBeforeId?: string;
}
