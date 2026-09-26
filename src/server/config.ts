import 'dotenv/config';
import { resolve } from 'node:path';
import type { Configuration } from '../shared/contracts.ts';

export const ownerId = 'local-development';
export const port = Number(process.env.PORT || 4310);
export const dataRoot = resolve('.local');
export const databaseUrl = process.env.DATABASE_URL || undefined;
export function configuration(overrides: Partial<Configuration> = {}): Configuration {
  return {
    provider: 'unconfigured',
    model: 'Unconfigured',
    llmReady: false,
    speechReady: false,
    integrationsReady: false,
    browserAssistReady: false,
    inspectorEnabled: process.env.DEV_INSPECTOR !== 'false',
    localOnly: true,
    ...overrides,
  };
}
