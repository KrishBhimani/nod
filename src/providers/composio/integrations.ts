import { Composio } from '@composio/core';
import { z } from 'zod';
import type {
  IntegrationProvider,
  IntegrationService,
  IntegrationSession,
} from '../../ports/integrations.ts';

const toolkits: IntegrationService[] = [
  'gmail',
  'googlecalendar',
  'googledrive',
  'googlesheets',
  'googledocs',
];
const subscriptions = {
  gmail: {
    trigger: 'GMAIL_NEW_GMAIL_MESSAGE',
    config: { interval: 15, query: 'in:inbox', userId: 'me' },
  },
  googlecalendar: {
    trigger: 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER',
    config: { interval: 15, calendarId: 'primary', showDeleted: true },
  },
} as const;
type ManagedSession = Awaited<ReturnType<Composio['sessions']['use']>>;

export function createComposioProvider(options: {
  apiKey?: string;
  webhookSecret?: string;
  authConfigs?: Partial<Record<IntegrationService, string>>;
  client?: Composio;
}): IntegrationProvider {
  const authConfigs = Object.fromEntries(
    Object.entries(options.authConfigs ?? {}).filter(
      ([, id]) => typeof id === 'string' && id.trim().length > 0,
    ),
  );
  const client =
    options.client ??
    (options.apiKey
      ? new Composio({
          apiKey: options.apiKey,
          allowTracking: false,
          fileUploadDirs: false,
          toolkitVersions: {
            gmail: '20260915_00',
            googlecalendar: '20260915_00',
            googledrive: '20260921_00',
            googlesheets: '20260915_00',
            googledocs: '20260826_00',
          },
        })
      : undefined);
  function required() {
    if (!client) throw new Error('The connection provider is not configured.');
    return client;
  }
  function session(value: ManagedSession): IntegrationSession {
    return {
      id: value.sessionId,
      async authorize(service, callbackUrl) {
        const result = await value.authorize(service, { callbackUrl });
        if (
          !result.redirectUrl ||
          new URL(result.redirectUrl).origin !== 'https://connect.composio.dev'
        )
          throw new Error('The connection sign-in address is invalid.');
        return { accountId: result.id, url: result.redirectUrl };
      },
      async search(query) {
        const result = await value.search({ query, toolkits });
        return {
          tools: result.toolSchemas,
          suggestions: result.results.map((item) => ({
            useCase: item.useCase,
            primaryToolSlugs: item.primaryToolSlugs,
          })),
        };
      },
      execute: (action, args) => value.execute(action, args),
    };
  }
  return {
    id: 'composio',
    configured: Boolean(client),
    webhooksConfigured: Boolean(client && options.webhookSecret),
    supportsSubscriptions: ['gmail', 'googlecalendar'],
    async createSession(ownerId, accounts) {
      return session(
        await required().sessions.create(ownerId, {
          toolkits,
          connectedAccounts: accounts,
          ...(Object.keys(authConfigs).length ? { authConfigs } : {}),
          manageConnections: false,
          sandbox: { enable: false },
          premiumUsage: false,
        }),
      );
    },
    async restoreSession(id) {
      return session(await required().sessions.use(id));
    },
    async deleteSession(id) {
      await required().sessions.delete(id);
    },
    async inspectAccount(id) {
      const account = await required().connectedAccounts.get(id);
      return {
        active: account.status === 'ACTIVE' && !account.isDisabled,
        service: account.toolkit.slug.toLowerCase(),
      };
    },
    async deleteAccount(id) {
      await required().connectedAccounts.delete(id);
    },
    parseCallback(query) {
      const result = z
        .object({ state: z.string(), connected_account_id: z.string(), status: z.string() })
        .parse(query);
      return {
        state: result.state,
        accountId: result.connected_account_id,
        success: result.status === 'success',
      };
    },
    async subscribe(ownerId, service, accountId) {
      if (!(service in subscriptions))
        throw new Error('Automatic updates are unavailable for this service.');
      const subscription = subscriptions[service as keyof typeof subscriptions];
      const result = await required().triggers.create(ownerId, subscription.trigger, {
        connectedAccountId: accountId,
        triggerConfig: subscription.config,
      });
      return { id: result.triggerId };
    },
    async unsubscribe(id) {
      await required().triggers.delete(id);
    },
    matchesSubscription(service, trigger) {
      return (
        service in subscriptions &&
        subscriptions[service as keyof typeof subscriptions].trigger === trigger
      );
    },
    async verifyWebhook(body, headers) {
      if (!options.webhookSecret) throw new Error('The webhook is not configured.');
      const result = await required().triggers.parse(
        { body, headers },
        { verifySecret: options.webhookSecret },
      );
      const event = result.payload;
      const id = String('id' in result.rawPayload ? result.rawPayload.id : headers['webhook-id']);
      if (!id || id.length > 200 || id === 'undefined')
        throw new Error('The event identity is invalid.');
      return {
        id,
        ownerId: event.userId,
        service: event.toolkitSlug.toLowerCase(),
        accountId: event.metadata.connectedAccount.id,
        subscriptionId: event.id,
        trigger: event.triggerSlug,
        data: event.payload ?? {},
      };
    },
  };
}
