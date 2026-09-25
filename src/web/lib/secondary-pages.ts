import type { Connection, Goal, Schedule } from '../../shared/contracts';

export function draftInChat(text: string) {
  window.dispatchEvent(new CustomEvent('sidekick:compose', { detail: { text, send: false } }));
}

export function connectionGroups(connections: Connection[]) {
  const groups = new Map<string, { service: Connection; accounts: Connection[] }>();
  for (const connection of connections) {
    const group = groups.get(connection.slug) ?? { service: connection, accounts: [] };
    if (connection.connectionId) group.accounts.push(connection);
    groups.set(connection.slug, group);
  }
  return [...groups.values()];
}

export function connectionIssue(connection: Connection) {
  if (connection.status !== 'connected') return 'Sign-in required';
  return null;
}

export function connectionIdentity(connection: Connection) {
  const name = connection.accountName?.trim();
  const email = connection.accountEmail?.trim();
  return {
    primary: name || email || 'Account details unavailable',
    secondary:
      name && email && name.toLocaleLowerCase() !== email.toLocaleLowerCase() ? email : null,
  };
}

export function removeConnection(connections: Connection[], connectionId: string) {
  const removed = connections.find((connection) => connection.connectionId === connectionId);
  const next = connections.filter((connection) => connection.connectionId !== connectionId);
  if (!removed || next.some((connection) => connection.slug === removed.slug)) return next;
  return connections.flatMap((connection) =>
    connection.connectionId !== connectionId
      ? [connection]
      : [
          {
            slug: removed.slug,
            name: removed.name,
            description: removed.description,
            status: 'disconnected' as const,
            triggersEnabled: false,
          },
        ],
  );
}

export function goalDraft(goal: Goal, action: 'discuss' | 'status') {
  const reference = `the goal ${JSON.stringify(goal.title)}`;
  return action === 'status'
    ? `${goal.status === 'active' ? 'Pause' : 'Resume'} ${reference}.`
    : `Let's review ${reference} and decide what to do next.`;
}

export function scheduleDraft(schedule: Schedule, action: 'discuss' | 'status') {
  const reference = `the schedule ${JSON.stringify(schedule.title)}`;
  const timing = schedule.kind === 'once' ? `a one-time run at ${schedule.runAt}` : schedule.cron;
  return action === 'status'
    ? `${schedule.enabled ? 'Pause' : 'Resume'} ${reference}.`
    : `I'd like to change ${reference}. Its current timing is ${timing} in ${schedule.timeZone}.`;
}

export type ChannelProvider = 'telegram' | 'whatsapp';
export type ChannelStatus = {
  provider: string;
  status: 'disabled' | 'setup_required' | 'configured';
  missing: string[];
};
export type ChannelResponse = { channels: ChannelStatus[]; error: string | null };
export type ChannelSetup = {
  provider: ChannelProvider;
  enabled: boolean;
  accountName?: string;
  accountHandle?: string;
  mode?: 'polling' | 'webhook';
  webhookStatus?: 'registered' | 'manual_setup';
  webhookUrl?: string;
};
export type ChannelSettings = { ready: boolean; channels: ChannelSetup[] };

export function channelLabel(setup: ChannelSetup | undefined, configured: boolean) {
  if (!setup?.enabled) return configured ? 'Configuration present' : 'Not connected';
  if (setup.mode === 'polling') return null;
  return setup.webhookStatus === 'registered' ? 'Webhook registered' : 'Finish delivery setup';
}

export function telegramBotUrl(handle?: string) {
  return handle && /^@[A-Za-z0-9_]+$/.test(handle) ? `https://t.me/${handle.slice(1)}` : null;
}

export function channelSetupBody(
  provider: ChannelProvider,
  fields: Record<string, string>,
  policyConfirmed: boolean,
) {
  const webhookUrl = fields.webhookUrl?.trim() || undefined;
  if (provider === 'telegram')
    return {
      botToken: fields.botToken?.trim(),
      allowedUserId: fields.allowedUserId?.trim(),
      webhookUrl,
    };
  return {
    accessToken: fields.accessToken?.trim(),
    appSecret: fields.appSecret?.trim(),
    phoneNumberId: fields.phoneNumberId?.trim(),
    allowedNumber: fields.allowedNumber?.trim(),
    verifyToken: fields.verifyToken?.trim(),
    webhookUrl,
    policyConfirmed,
  };
}
