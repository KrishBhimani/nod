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
type AccountIdentity = { expiresAt: number; accountName?: string; accountEmail?: string };
const identityTools = {
  gmail: { action: 'GMAIL_GET_PROFILE', args: { user_id: 'me' } },
  googlecalendar: { action: 'GOOGLECALENDAR_GET_CURRENT_USER', args: {} },
  googledrive: {
    action: 'GOOGLEDRIVE_GET_ABOUT',
    args: { fields: 'user(displayName,emailAddress)' },
  },
} as const;

function identityFields(value: unknown): Omit<AccountIdentity, 'expiresAt'> | undefined {
  let data = z.record(z.string(), z.unknown()).parse(value);
  for (let depth = 0; depth < 4; depth++) {
    if (data.error != null || data.successful === false) return;
    if (data.user && typeof data.user === 'object') {
      data = z.record(z.string(), z.unknown()).parse(data.user);
      break;
    }
    if (!data.data || typeof data.data !== 'object') break;
    data = z.record(z.string(), z.unknown()).parse(data.data);
  }
  if (data.error != null || data.successful === false) return;
  const email = z
    .email()
    .max(320)
    .safeParse(data.email ?? data.emailAddress ?? data.id);
  const name = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .safeParse(data.name ?? data.displayName ?? data.display_name);
  if (!email.success && !name.success) return;
  return {
    ...(email.success ? { accountEmail: email.data } : {}),
    ...(name.success ? { accountName: name.data.replace(/[\u0000-\u001f]/g, ' ') } : {}),
  };
}

export function createComposioProvider(options: {
  apiKey?: string;
  webhookSecret?: string;
  authConfigs?: Partial<Record<IntegrationService, string>>;
  client?: Composio;
}): IntegrationProvider {
  const identities = new Map<string, AccountIdentity>();
  const pendingIdentities = new Map<string, Promise<AccountIdentity>>();
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
  async function fetchIdentity(
    id: string,
    service: string,
    ownerId: string,
  ): Promise<AccountIdentity> {
    const tool = identityTools[service as keyof typeof identityTools];
    if (tool) {
      let inspection: ManagedSession | undefined;
      try {
        inspection = await required().sessions.create(
          ownerId,
          {
            toolkits: [service],
            tools: { [service]: [tool.action] },
            connectedAccounts: { [service]: id },
            multiAccount: {
              enable: true,
              maxAccountsPerToolkit: 2,
              requireExplicitSelection: true,
            },
            manageConnections: false,
            sandbox: { enable: false },
            premiumUsage: false,
          },
          { signal: AbortSignal.timeout(15_000) },
        );
        const response = await inspection.execute(tool.action, tool.args, { account: id });
        const fields = identityFields(response);
        if (fields) return { ...fields, expiresAt: Date.now() + 15 * 60_000 };
      } catch {
      } finally {
        if (inspection) {
          try {
            await required().sessions.delete(inspection.sessionId, {
              signal: AbortSignal.timeout(5_000),
            });
          } catch {}
        }
      }
    }
    const endpoints = ['https://www.googleapis.com/oauth2/v2/userinfo'];
    if (service === 'gmail')
      endpoints.push('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    else if (service === 'googlecalendar')
      endpoints.push('https://www.googleapis.com/calendar/v3/calendars/primary');
    else if (['googledrive', 'googledocs', 'googlesheets'].includes(service))
      endpoints.push(
        'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)',
      );
    for (const endpoint of endpoints) {
      try {
        const response = await required().tools.proxyExecute(
          {
            connectedAccountId: id,
            endpoint,
            method: 'GET',
          },
          { signal: AbortSignal.timeout(15_000) },
        );
        if (response.status !== 200) continue;
        const fields = identityFields(response.data);
        if (fields) return { ...fields, expiresAt: Date.now() + 15 * 60_000 };
      } catch {}
    }
    return { expiresAt: Date.now() + 60_000 };
  }
  async function identity(id: string, service: string, ownerId: string) {
    const key = JSON.stringify([ownerId, id]);
    const saved = identities.get(key);
    if (saved && saved.expiresAt > Date.now()) return saved;
    let pending = pendingIdentities.get(key);
    if (!pending) {
      pending = fetchIdentity(id, service, ownerId)
        .then((result) => {
          identities.set(key, result);
          return result;
        })
        .finally(() => pendingIdentities.delete(key));
      pendingIdentities.set(key, pending);
    }
    return pending;
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
      async execute(action, args, accountId) {
        const result = await value.execute(
          action,
          args,
          accountId ? { account: accountId } : undefined,
        );
        if (
          result.error != null ||
          ('successful' in result && result.successful === false) ||
          (result.data &&
            typeof result.data === 'object' &&
            'successful' in result.data &&
            result.data.successful === false)
        )
          throw new Error('The connection provider could not complete this action.');
        return result;
      },
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
          multiAccount: { enable: true, maxAccountsPerToolkit: 10, requireExplicitSelection: true },
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
    async inspectAccount(id, ownerId) {
      const account = await required().connectedAccounts.get(id);
      const active = account.status === 'ACTIVE' && !account.isDisabled;
      const service = account.toolkit.slug.toLowerCase();
      const details = active ? await identity(id, service, ownerId) : undefined;
      return {
        active,
        service,
        ...(details?.accountName ? { accountName: details.accountName } : {}),
        ...(details?.accountEmail ? { accountEmail: details.accountEmail } : {}),
      };
    },
    async deleteAccount(id) {
      await required().connectedAccounts.delete(id);
      for (const key of identities.keys()) if (JSON.parse(key)[1] === id) identities.delete(key);
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
