export type RelevanceDecision = 'ignore' | 'digest' | 'wake';
export interface RelevancePolicy {
  instructions: string;
  criteria: Record<RelevanceDecision, string>;
  minWakeConfidence: number;
}
export interface RelevanceClassifier {
  id: string;
  configured: boolean;
  classify(
    context: object,
    policy: RelevancePolicy,
    signal?: AbortSignal,
  ): Promise<RelevanceDecision>;
}
