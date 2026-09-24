import 'dotenv/config';
import { resolve } from 'node:path';

export const ownerId = 'local-development';
export const port = Number(process.env.PORT || 4310);
export const dataRoot = resolve('.local');
export const databaseUrl = process.env.DATABASE_URL || 'postgresql://sidekick:sidekick-local@127.0.0.1:54329/sidekick';
export function configuration() {
  const provider = process.env.LLM_PROVIDER || 'openai';
  return {
    provider, model: process.env.LLM_MODEL || 'Provider default',
    llmReady: Boolean(provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY),
    speechReady: Boolean(process.env.OPENAI_API_KEY), composioReady: Boolean(process.env.COMPOSIO_API_KEY),
    jevReady: Boolean(process.env.TYPESAFE_API_KEY), inspectorEnabled: process.env.DEV_INSPECTOR !== 'false', localOnly: true,
  };
}
