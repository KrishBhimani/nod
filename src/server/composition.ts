import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agent } from '../ports/agent.ts';
import type { BrowserChooser, Computer, Workspace } from '../ports/computer.ts';
import type { IntegrationProvider, IntegrationService } from '../ports/integrations.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { RelevanceClassifier } from '../ports/relevance.ts';
import type { SpeechProvider } from '../ports/speech.ts';
import type { MessagingTransport } from '../ports/messaging.ts';
import type { ChannelSetupVerifier } from '../ports/channel-settings.ts';
import type { LinkPreviewProvider } from '../ports/link-preview.ts';
import type { ConversationRouter } from '../ports/conversation.ts';
import type { RecordProviderUsage } from '../ports/provider-usage.ts';
import { agentModels } from '../shared/model-defaults.ts';
import { createChatSdkTransport } from '../providers/chat-sdk/index.ts';
import { createChatSdkSetupVerifier } from '../providers/chat-sdk/settings.ts';
import { createContainerBrowserComputer } from '../providers/container-browser/index.ts';
import { createComposioProvider } from '../providers/composio/integrations.ts';
import { createDockerWorkspace } from '../providers/docker/index.ts';
import { createEnvironmentKeyStore } from '../providers/environment/key-store.ts';
import { createJevBrowserChooser } from '../providers/jev/browser.ts';
import { createJevRelevanceClassifier } from '../providers/jev/relevance.ts';
import { createKeychainKeyStore } from '../providers/keychain/key-store.ts';
import { createOpenAIRelevanceClassifier } from '../providers/openai/relevance.ts';
import { createOpenAISpeechProvider } from '../providers/openai/speech.ts';
import { createPiAgent } from '../providers/pi/index.ts';
import { createPiConversationRouter } from '../providers/pi/conversation.ts';
import { createPublicLinkPreviewProvider } from '../providers/public-web/link-preview.ts';
import { createAgentRuntime } from '../runtime/index.ts';
import { createApp } from './app.ts';
import { createChatVerification } from './chat-verification.ts';
import { createAgentReactionService } from './agent-reactions.ts';
import { createApprovals } from './approvals.ts';
import { readTaskArtifacts } from './artifacts.ts';
import { createChannels } from './channels.ts';
import { createChannelSettings } from './channel-settings.ts';
import { configuration, dataRoot, ownerId, port } from './config.ts';
import { createInspectorPool, initializeDatabase, pool } from './db.ts';
import { events, refresh } from './events.ts';
import { createIntegrations } from './integrations.ts';
import { createInspectorStore } from './inspector.ts';
import { createPromptInspector } from './inspector-prompts.ts';
import { createInspectorWork } from './inspector-work.ts';
import { createPersonalService } from './personal.ts';
import { createSpeech } from './speech.ts';
import {
  boss,
  createUserMessageService,
  initializeTasks,
  pauseOwnedTaskForControl,
  resumeOwnedTaskFromControl,
  resumeTask,
  restartOnboarding,
  retryTaskCredentials,
  startTaskWorkers,
  stopTasks,
  submitTask,
} from './tasks.ts';
import { createTriage } from './triage.ts';
import { createVault } from './vault.ts';
import { createTakeover } from './takeover.ts';
import { createProviderUsageStore } from './provider-usage.ts';
import { createLinkPreviews } from './link-previews.ts';
import {
  meterAgent,
  meterComputer,
  meterWorkspace,
  meterIntegrations,
  meterRelevance,
  meterSpeech,
  meterMessaging,
} from './provider-metering.ts';

export interface ApplicationAdapters {
  createConversationRouter?(onUsage: RecordProviderUsage): ConversationRouter;
  agent: Agent;
  computer: Computer;
  workspace: Workspace;
  speech: SpeechProvider;
  integrations: IntegrationProvider;
  keyStore: CredentialKeyStore;
  relevance: RelevanceClassifier;
  messaging?: MessagingTransport;
  linkPreviews?: LinkPreviewProvider;
  messagingSetup?: {
    verifier: ChannelSetupVerifier;
    create(environment: Record<string, string>): MessagingTransport;
  };
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
  const model = env.LLM_MODEL || agentModels[provider as keyof typeof agentModels];
  const authConfigs: Partial<Record<IntegrationService, string>> = {
    gmail: env.COMPOSIO_GMAIL_AUTH_CONFIG_ID,
    googlecalendar: env.COMPOSIO_CALENDAR_AUTH_CONFIG_ID,
    googledrive: env.COMPOSIO_DRIVE_AUTH_CONFIG_ID,
    googlesheets: env.COMPOSIO_SHEETS_AUTH_CONFIG_ID,
    googledocs: env.COMPOSIO_DOCS_AUTH_CONFIG_ID,
    slack: env.COMPOSIO_SLACK_AUTH_CONFIG_ID,
    notion: env.COMPOSIO_NOTION_AUTH_CONFIG_ID,
  };
  return {
    createConversationRouter: (onUsage) =>
      createPiConversationRouter({ provider, model: env.ROUTING_MODEL, apiKey, onUsage }),
    agent: createPiAgent({ provider, model, apiKey, sessionRoot: join(dataRoot, 'sessions') }),
    computer: createContainerBrowserComputer({ dataRoot, container: env.BROWSER_CONTAINER }),
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
    messagingSetup: {
      verifier: createChatSdkSetupVerifier(),
      create: (environment) => createChatSdkTransport(pool, { ...env, ...environment }),
    },
    linkPreviews: createPublicLinkPreviewProvider(),
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
  const inspectorDatabase = createInspectorPool();
  const inspectorSecrets = Object.entries(process.env)
    .filter(([key]) => /(?:API_KEY|SECRET|PASSWORD|VAULT_KEY|BOT_TOKEN|ACCESS_TOKEN)$/.test(key))
    .flatMap(([, value]) => (value ? [value] : []));
  if (process.env.DATABASE_URL) {
    inspectorSecrets.push(process.env.DATABASE_URL);
    try {
      const password = decodeURIComponent(new URL(process.env.DATABASE_URL).password);
      if (password) inspectorSecrets.push(password);
    } catch {}
  }
  const inspector = createInspectorStore(inspectorDatabase, {
    ownerId,
    enabled: () => configuration().inspectorEnabled,
    secrets: inspectorSecrets,
  });
  const promptInspector = createPromptInspector(inspectorDatabase, {
    ownerId,
    enabled: () => configuration().inspectorEnabled,
    secrets: inspectorSecrets,
    provider: adapters.model.provider,
    model: adapters.model.name,
  });
  await promptInspector.initialize();
  const providerUsage = createProviderUsageStore(inspectorDatabase, {
    ownerId,
    enabled: () => configuration().inspectorEnabled,
    coverage: [
      {
        provider: adapters.model.provider,
        category: 'agent',
        status: 'recorded',
        note: 'Responses, compaction and cache warming when reported by Pi. Costs are SDK estimates; unreported failed attempts may be missing.',
      },
      {
        provider: adapters.relevance.id,
        category: 'relevance',
        status: 'recorded',
        note: 'Classification operations and duration. Tokens and prices are not exposed by this adapter.',
      },
      {
        provider: 'agent-browser',
        category: 'browser',
        status: 'recorded',
        note: 'Local browser operations, screen captures and secure/manual steps. Hosting and visited-site charges are not measured.',
      },
      ...(adapters.linkPreviews
        ? [
            {
              provider: 'public-web',
              category: 'browser' as const,
              status: 'recorded' as const,
              note: 'Public link preview metadata and image operations. Cache hits are included; network and hosting charges are not measured.',
            },
          ]
        : []),
      ...(adapters.chooseBrowserAction
        ? [
            {
              provider: 'jev',
              category: 'browser' as const,
              status: 'recorded' as const,
              note: 'Fast-choice operations and duration. Provider price is unavailable.',
            },
          ]
        : []),
      {
        provider: adapters.integrations.id,
        category: 'integration',
        status: 'recorded',
        note: 'Composio session, account, search, execution and subscription operations; internal SDK requests and Google quotas are not measured.',
      },
      {
        provider: adapters.speech.id,
        category: 'speech',
        status: 'recorded',
        note: 'Transcription bytes and synthesis characters/bytes. Audio duration, tokens and prices are unavailable.',
      },
      {
        provider: 'telegram',
        category: 'channel',
        status: 'recorded',
        note: 'Setup, polling, received messages and sends when configured. Provider fees are unavailable.',
      },
      {
        provider: 'whatsapp',
        category: 'channel',
        status: 'recorded',
        note: 'Setup, webhook messages and sends when configured. Provider fees are unavailable.',
      },
      {
        provider: 'local-workspace',
        category: 'workspace',
        status: 'recorded',
        note: 'Command and file operations; cloud/hosting resource charges are not measured.',
      },
      {
        provider: 'hosting',
        category: 'workspace',
        status: 'unsupported',
        note: 'Database, storage, network and machine billing require a hosting billing integration.',
      },
    ],
  });
  await providerUsage.initialize();
  const computer = meterComputer(adapters.computer, providerUsage);
  const workspace = meterWorkspace(adapters.workspace, providerUsage);
  const speechProvider = meterSpeech(adapters.speech, providerUsage);
  const integrationProvider = meterIntegrations(adapters.integrations, providerUsage);
  const classify = meterRelevance(adapters.relevance, providerUsage);
  const runtime = createAgentRuntime({
    agent: meterAgent(adapters.agent, providerUsage),
    withTool: providerUsage.withTool,
    computer,
    workspace,
    chooseBrowserAction: adapters.chooseBrowserAction
      ? (...args) =>
          providerUsage.track(
            { provider: 'jev', category: 'browser', operation: 'choose_action' },
            () => adapters.chooseBrowserAction!(...args),
          )
      : undefined,
  });
  const speech = createSpeech(speechProvider);
  const personal = createPersonalService({ pool, ownerId, scheduler: boss, submitTask, refresh });
  await personal.initialize({ workers: options.workers });
  const triage = createTriage({
    classifier: classify,
    getProfile: personal.getProfile,
    listGoals: personal.listGoals,
  });
  const integrations = await createIntegrations(pool, {
    provider: integrationProvider,
    wake: triage.triageEvent,
    refresh,
    baseUrl: `http://localhost:${port}`,
  });
  const vault = await createVault(pool, {
    keyStore: adapters.keyStore,
    resume: resumeTask,
    retry: retryTaskCredentials,
    inject: computer.injectCredentials,
    inspect: computer.inspectLogin,
    hold: computer.hold,
    selectMethod: computer.selectLoginMethod,
    emailCode: (input, signal) => integrations.emailCode(ownerId, input, signal),
  });
  const chatVerification = await createChatVerification(pool, {
    ownerId,
    submitCode: vault.submitChatCode,
    refresh,
  });
  const approvals = await createApprovals(
    (action, args, provenance) =>
      action.startsWith('SIDEKICK_')
        ? personal.manage(action.slice(9), args, provenance)
        : providerUsage.withTask(provenance.taskId, () =>
            integrations.executeApproved(ownerId, action, args),
          ),
    async (action, args) => {
      if (action.startsWith('SIDEKICK_')) await personal.validateReview(action.slice(9), args);
      else await integrations.validateApproval(ownerId, action, args);
    },
    (action, args) => integrations.describeApproval(ownerId, action, args),
    (action, args) => integrations.describeTarget(ownerId, action, args),
  );
  const reactions = createAgentReactionService({ pool, ownerId, refresh });
  const userMessages = createUserMessageService({
    routeConversation: adapters.createConversationRouter?.(providerUsage.record),
    confirmAction: approvals.acceptChat,
  });
  if (options.workers !== false) {
    await inspector.recover().catch(() => {});
    await triage.initializeHeartbeat();
    await startTaskWorkers({
      readArtifact: workspace.readArtifact?.bind(workspace),
      executeConfirmation: approvals.executeConfirmed,
      reactToMessage: reactions.react,
      downloadIntegrationFile: (_taskId, action, args, signal) =>
        integrations.download(ownerId, action, args, signal),
      runTask: (context) => providerUsage.withTask(context.taskId, () => runtime.runTask(context)),
      observe: inspector.record,
      recordFailure: inspector.recordFailure,
      inspectPrompt: promptInspector.record,
      finishObservationSegment: inspector.finishSegment,
      connections: integrations.manageConnections,
      speech,
      manage: async (taskId, action, args, provenance) => {
        if (
          [
            'profile_update',
            'notification_preferences_update',
            'goal_create',
            'goal_update',
            'schedule_create',
            'schedule_update',
            'schedule_cancel',
            'memory_propose',
          ].includes(action)
        )
          return approvals.request(
            taskId,
            `SIDEKICK_${action}`,
            await personal.validateReview(action, args),
            { revision: provenance?.revision },
          );
        return personal.manage(action, args, provenance);
      },
      requestCredential: async (taskId, input) => {
        if (input.kind === 'otp' && (await vault.fillEmailCode(taskId, ownerId, input)))
          return { filled: true };
        if (input.kind !== 'otp') {
          const selected = await vault.fillSelected(taskId, ownerId, input);
          if (selected) return { filled: true };
          if (selected === undefined) {
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
        }
        return vault.request(taskId, ownerId, input);
      },
      integration: async (taskId, action, args, options) => {
        const result = await integrations.execute(ownerId, action, args);
        if (
          result &&
          typeof result === 'object' &&
          'requiresApproval' in result &&
          result.requiresApproval
        ) {
          if (options?.readOnly)
            throw new Error(
              'Getting started can inspect connected apps but cannot change their data.',
            );
          return approvals.request(
            taskId,
            action,
            'args' in result && result.args && typeof result.args === 'object'
              ? (result.args as Record<string, unknown>)
              : args,
            { revision: options?.revision },
          );
        }
        return result;
      },
    });
  }
  const app = await createApp({
    submitMessage: userMessages.submit,
    verification: chatVerification,
    onboard: async (timeZone, conversationRevision) => {
      if (timeZone) await triage.updatePreferences({ timeZone });
      return restartOnboarding(conversationRevision);
    },
    speech,
    computer,
    runtime,
    inspector,
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
  providerUsage.registerRoutes(app);
  promptInspector.registerRoutes(app);
  createInspectorWork(inspectorDatabase, {
    ownerId,
    enabled: () => configuration().inspectorEnabled,
    secrets: inspectorSecrets,
    async reviewStatus() {
      const registered =
        options.workers === false ? undefined : (await boss.getSchedules('heartbeat'))[0];
      return {
        configured: adapters.relevance.configured,
        scheduled: Boolean(registered),
        cron: registered?.cron ?? null,
        timeZone: registered?.timezone ?? null,
      };
    },
  }).registerRoutes(app);
  if (adapters.linkPreviews) {
    const previews = adapters.linkPreviews;
    createLinkPreviews({
      metadata: (url) =>
        providerUsage.track(
          { provider: 'public-web', category: 'browser', operation: 'link_metadata' },
          () => previews.metadata(url),
        ),
      image: (url) =>
        providerUsage.track(
          { provider: 'public-web', category: 'browser', operation: 'link_image' },
          () => previews.image(url),
          (image) => ({ bytes: image?.bytes.byteLength ?? 0 }),
        ),
    }).registerRoutes(app);
  }
  vault.registerRoutes(app);
  integrations.registerRoutes(app);
  personal.registerRoutes(app);
  triage.registerRoutes(app);
  createTakeover({
    pool,
    ownerId,
    computer,
    enabled: () => configuration().inspectorEnabled,
    pause: pauseOwnedTaskForControl,
    resume: resumeOwnedTaskFromControl,
    waitForTask: runtime.waitForTask,
  }).registerRoutes(app);
  let channels: Awaited<ReturnType<typeof createChannels>> | undefined;
  let channelSettings: Awaited<ReturnType<typeof createChannelSettings>> | undefined;
  if (options.channels !== false && (adapters.messaging || adapters.messagingSetup)) {
    const setup = adapters.messagingSetup;
    if (setup) {
      channelSettings = await createChannelSettings(pool, {
        keyStore: adapters.keyStore,
        verifier: {
          verify: (provider, input) =>
            providerUsage.track({ provider, category: 'channel', operation: 'setup' }, () =>
              setup.verifier.verify(provider, input),
            ),
          ...(setup.verifier.register
            ? {
                register: (provider, configuration) =>
                  providerUsage.track(
                    { provider, category: 'channel', operation: 'register' },
                    () => setup.verifier.register!(provider, configuration),
                  ),
              }
            : {}),
        },
        apply: async (environment) => {
          if (!channels) throw new Error('Messaging is not ready.');
          await channels.replaceTransport(meterMessaging(setup.create(environment), providerUsage));
        },
      });
      channelSettings.registerRoutes(app);
    }
    const messaging = setup
      ? setup.create(await channelSettings!.environment())
      : adapters.messaging!;
    channels = await createChannels(pool, {
      ownerId,
      resolveAttachments: readTaskArtifacts,
      transport: meterMessaging(messaging, providerUsage),
      acceptVerification: (text, input) => chatVerification.accept(text, input),
      subscribe(listener) {
        const onEvent = (event: { type?: string }) => {
          if (event.type === 'refresh') listener();
        };
        events.on('event', onEvent);
        return () => {
          events.off('event', onEvent);
        };
      },
      prepare: (text, sourceId, channel) => userMessages.prepare(text, [], { sourceId, channel }),
      submit: async (text, sourceId, client, channel, preparedRoute, messageId) =>
        (
          await userMessages.submit(text, [], {
            sourceId,
            channel,
            client,
            preparedRoute,
            clientMessageId: messageId,
          })
        ).taskId,
    });
    channels.registerRoutes(app);
    await channelSettings?.recover();
  }
  app.addHook('onClose', async () => {
    const failures: unknown[] = [];
    for (const close of [
      () => channels?.close(),
      () => stopTasks(),
      () => runtime.dispose(),
      () => inspector.close(),
      () => promptInspector.close(),
      () => providerUsage.close(),
      () => inspectorDatabase.end(),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new Error('Some application resources could not close.');
  });
  return { app, runtime, personal, triage, integrations, vault, channels, channelSettings };
}
