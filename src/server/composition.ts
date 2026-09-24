import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agent } from '../ports/agent.ts';
import type { BrowserChooser, Computer, Workspace } from '../ports/computer.ts';
import type { IntegrationProvider, IntegrationService } from '../ports/integrations.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { RelevanceClassifier } from '../ports/relevance.ts';
import type { SpeechProvider } from '../ports/speech.ts';
import type { MessagingTransport } from '../ports/messaging.ts';
import { createChatSdkTransport } from '../providers/chat-sdk/index.ts';
import { createAgentBrowserComputer } from '../providers/agent-browser/index.ts';
import { createComposioProvider } from '../providers/composio/integrations.ts';
import { createDockerWorkspace } from '../providers/docker/index.ts';
import { createEnvironmentKeyStore } from '../providers/environment/key-store.ts';
import { createJevBrowserChooser } from '../providers/jev/browser.ts';
import { createJevRelevanceClassifier } from '../providers/jev/relevance.ts';
import { createKeychainKeyStore } from '../providers/keychain/key-store.ts';
import { createOpenAIRelevanceClassifier } from '../providers/openai/relevance.ts';
import { createOpenAISpeechProvider } from '../providers/openai/speech.ts';
import { createPiAgent } from '../providers/pi/index.ts';
import { createAgentRuntime } from '../runtime/index.ts';
import { createApp } from './app.ts';
import { createApprovals } from './approvals.ts';
import { createChannels } from './channels.ts';
import { configuration, dataRoot, ownerId, port } from './config.ts';
import { initializeDatabase, pool } from './db.ts';
import { events, refresh } from './events.ts';
import { createIntegrations } from './integrations.ts';
import { createPersonalService } from './personal.ts';
import { createSpeech } from './speech.ts';
import {
  boss,
  initializeTasks,
  resumeTask,
  retryTaskCredentials,
  startTaskWorkers,
  stopTasks,
  submitTask,
} from './tasks.ts';
import { createTriage } from './triage.ts';
import { createVault } from './vault.ts';

export interface ApplicationAdapters {
  agent: Agent;
  computer: Computer;
  workspace: Workspace;
  speech: SpeechProvider;
  integrations: IntegrationProvider;
  keyStore: CredentialKeyStore;
  relevance: RelevanceClassifier;
  messaging?: MessagingTransport;
  chooseBrowserAction?: BrowserChooser;
  model: { provider: string; name: string; configured: boolean };
}

export function createDefaultAdapters(
  env: Record<string, string | undefined> = process.env,
): ApplicationAdapters {
  const provider = env.LLM_PROVIDER || 'openai';
  if (!['openai', 'anthropic'].includes(provider))
    throw new Error('LLM_PROVIDER must be openai or anthropic.');
  const apiKey = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
  const model = env.LLM_MODEL || (provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.4-mini');
  const authConfigs: Partial<Record<IntegrationService, string>> = {
    gmail: env.COMPOSIO_GMAIL_AUTH_CONFIG_ID,
    googlecalendar: env.COMPOSIO_CALENDAR_AUTH_CONFIG_ID,
    googledrive: env.COMPOSIO_DRIVE_AUTH_CONFIG_ID,
    googlesheets: env.COMPOSIO_SHEETS_AUTH_CONFIG_ID,
    googledocs: env.COMPOSIO_DOCS_AUTH_CONFIG_ID,
  };
  return {
    agent: createPiAgent({ provider, model, apiKey, sessionRoot: join(dataRoot, 'sessions') }),
    computer: createAgentBrowserComputer({ dataRoot }),
    workspace: createDockerWorkspace({
      container: env.WORKSPACE_CONTAINER || 'sidekick-workspace',
      workspaceRoot: join(dataRoot, 'workspaces'),
    }),
    speech: createOpenAISpeechProvider({
      apiKey: env.OPENAI_API_KEY,
      transcriptionModel: env.STT_MODEL,
      speechModel: env.TTS_MODEL,
      voice: env.TTS_VOICE,
    }),
    integrations: createComposioProvider({
      apiKey: env.COMPOSIO_API_KEY,
      webhookSecret: env.COMPOSIO_WEBHOOK_SECRET,
      authConfigs,
    }),
    keyStore: env.SIDEKICK_VAULT_KEY
      ? createEnvironmentKeyStore(env.SIDEKICK_VAULT_KEY)
      : process.platform === 'darwin'
        ? createKeychainKeyStore()
        : createEnvironmentKeyStore(),
    relevance: env.TYPESAFE_API_KEY
      ? createJevRelevanceClassifier({ apiKey: env.TYPESAFE_API_KEY, model: env.TYPESAFE_MODEL })
      : createOpenAIRelevanceClassifier({ apiKey: env.OPENAI_API_KEY, model: env.TRIAGE_MODEL }),
    chooseBrowserAction: env.TYPESAFE_API_KEY
      ? createJevBrowserChooser({ apiKey: env.TYPESAFE_API_KEY, model: env.TYPESAFE_MODEL })
      : undefined,
    messaging: createChatSdkTransport(pool, env),
    model: { provider, name: model, configured: Boolean(apiKey) },
  };
}

export async function createApplication(
  adapters: ApplicationAdapters,
  options: { workers?: boolean; channels?: boolean } = {},
) {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await initializeDatabase();
  await initializeTasks();
  const runtime = createAgentRuntime({
    agent: adapters.agent,
    computer: adapters.computer,
    workspace: adapters.workspace,
    chooseBrowserAction: adapters.chooseBrowserAction,
  });
  const speech = createSpeech(adapters.speech);
  const personal = createPersonalService({ pool, ownerId, scheduler: boss, submitTask, refresh });
  await personal.initialize({ workers: options.workers });
  const triage = createTriage({
    classifier: adapters.relevance,
    getProfile: personal.getProfile,
    listGoals: personal.listGoals,
  });
  const integrations = await createIntegrations(pool, {
    provider: adapters.integrations,
    wake: triage.triageEvent,
    baseUrl: `http://localhost:${port}`,
  });
  const vault = await createVault(pool, {
    keyStore: adapters.keyStore,
    resume: resumeTask,
    retry: retryTaskCredentials,
    inject: adapters.computer.injectCredentials,
  });
  const approvals = await createApprovals((action, args, provenance) =>
    action.startsWith('SIDEKICK_')
      ? personal.manage(action.slice(9), args, provenance)
      : integrations.executeApproved(ownerId, action, args),
  );
  if (options.workers !== false) {
    await triage.initializeHeartbeat();
    await startTaskWorkers({
      runTask: runtime.runTask,
      speech,
      manage: async (taskId, action, args) => {
        if (
          [
            'profile_update',
            'goal_create',
            'goal_update',
            'schedule_create',
            'schedule_update',
            'schedule_cancel',
            'memory_propose',
          ].includes(action)
        )
          return approvals.request(taskId, `SIDEKICK_${action}`, args);
        return personal.manage(action, args);
      },
      requestCredential: async (taskId, input) => {
        if (input.kind === 'password') {
          const matches = (await vault.list(ownerId)).filter(
            (entry) => entry.origin === input.origin,
          );
          if (matches.length === 1) {
            try {
              await vault.fillSaved(taskId, ownerId, matches[0].id, input);
              return { filled: true };
            } catch {}
          }
        }
        return vault.request(taskId, ownerId, input);
      },
      integration: async (taskId, action, args) => {
        const result = await integrations.execute(ownerId, action, args);
        if (
          result &&
          typeof result === 'object' &&
          'requiresApproval' in result &&
          result.requiresApproval
        )
          return approvals.request(taskId, action, args);
        return result;
      },
    });
  }
  const app = await createApp({
    speech,
    computer: adapters.computer,
    runtime,
    configuration: () =>
      configuration({
        provider: adapters.model.provider,
        model: adapters.model.name,
        llmReady: adapters.model.configured,
        speechReady: adapters.speech.configured,
        integrationsReady: adapters.integrations.configured,
        browserAssistReady: Boolean(adapters.chooseBrowserAction),
      }),
  });
  vault.registerRoutes(app);
  integrations.registerRoutes(app);
  approvals.registerRoutes(app);
  personal.registerRoutes(app);
  triage.registerRoutes(app);
  if (options.channels !== false && adapters.messaging) {
    const channels = await createChannels(pool, {
      ownerId,
      transport: adapters.messaging,
      subscribe(listener) {
        const onEvent = (event: { type?: string }) => {
          if (event.type === 'refresh') listener();
        };
        events.on('event', onEvent);
        return () => {
          events.off('event', onEvent);
        };
      },
      submit: (text, sourceId, client) =>
        submitTask(text, [], undefined, false, { sourceId, source: 'user', client }),
    });
    channels.registerRoutes(app);
  }
  app.addHook('onClose', async () => {
    await stopTasks();
    await runtime.dispose();
  });
  return { app, runtime, personal, triage, integrations, vault };
}
