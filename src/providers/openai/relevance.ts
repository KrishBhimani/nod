import { z } from 'zod';
import type { RelevanceClassifier } from '../../ports/relevance.ts';

export function createOpenAIRelevanceClassifier(options: {
  apiKey?: string;
  model?: string;
  fetch?: typeof fetch;
}): RelevanceClassifier {
  const request = options.fetch ?? fetch;
  return {
    id: 'openai',
    configured: Boolean(options.apiKey),
    async classify(context, policy, signal) {
      signal?.throwIfAborted();
      if (!options.apiKey) throw new Error('Relevance check is not configured.');
      const response = await request('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model || 'gpt-4.1-nano',
          temperature: 0,
          max_tokens: 100,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `Return JSON {"decision":"ignore"|"digest"|"wake","confidence":0.0}. ${policy.instructions} Decision criteria: ${JSON.stringify(policy.criteria)}`,
            },
            { role: 'user', content: JSON.stringify(context) },
          ],
        }),
      });
      if (!response.ok) throw new Error('Relevance check unavailable.');
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const answer = z
        .object({
          decision: z.enum(['ignore', 'digest', 'wake']),
          confidence: z.number().min(0).max(1),
        })
        .parse(JSON.parse(data.choices?.[0]?.message?.content || '{}'));
      return answer.decision === 'wake' && answer.confidence < policy.minWakeConfidence
        ? 'digest'
        : answer.decision;
    },
  };
}
