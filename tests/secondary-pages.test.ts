import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Connection, Goal, Schedule } from '../src/shared/contracts.ts';
import { ConnectedAccount } from '../src/web/pages/apps.tsx';
import { ChannelAccount, ChannelSetupStep } from '../src/web/pages/channels.tsx';
import { GoalRow } from '../src/web/pages/goals.tsx';
import { ScheduleRow } from '../src/web/pages/schedule.tsx';
import {
  channelLabel,
  channelSetupBody,
  connectionGroups,
  connectionIdentity,
  connectionIssue,
  removeConnection,
  draftInChat,
  goalDraft,
  scheduleDraft,
  telegramBotUrl,
} from '../src/web/lib/secondary-pages.ts';

const account: Connection = {
  slug: 'gmail',
  name: 'Gmail',
  status: 'connected',
  connectionId: 'fixture-account',
  accountName: 'Fixture Person',
  accountEmail: 'fixture@example.com',
  supportsTriggers: true,
  triggersEnabled: true,
  triggersActive: true,
  triggerStatus: 'active',
};
const goal: Goal = {
  id: 'fixture-goal',
  title: 'Read a book',
  description: 'A chapter each week.',
  progress: 30,
  status: 'active',
  nextAction: 'Choose the next chapter.',
  targetDate: '2026-10-01',
  updatedAt: '2026-09-25T00:00:00.000Z',
};
const schedule: Schedule = {
  id: 'fixture-schedule',
  title: 'Morning briefing',
  prompt: 'Prepare a short agenda.',
  cron: '30 9 * * 1',
  kind: 'recurring',
  runAt: null,
  timeZone: 'Europe/Lisbon',
  enabled: true,
  revision: 0,
  nextRun: '2026-09-28T08:30:00.000Z',
  lastRun: null,
  baselineObservation: null,
};

test('connections keep multiple account identities under their service without inventing account details', () => {
  const second = {
    ...account,
    connectionId: 'fixture-two',
    accountName: undefined,
    accountEmail: 'two@example.com',
  };
  const groups = connectionGroups([
    account,
    second,
    { slug: 'googledrive', name: 'Drive', status: 'disconnected', triggersEnabled: false },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups[0].accounts.map((item) => item.connectionId),
    ['fixture-account', 'fixture-two'],
  );
  assert.equal(groups[1].accounts.length, 0);
  const html = renderToStaticMarkup(
    createElement(ConnectedAccount, { account: second, busy: false, onDisconnect() {} }),
  );
  assert.match(html, /two@example.com/);
  assert.match(html, /aria-label="Disconnect two@example.com from Gmail"/);
  assert.match(html, /title="Disconnect account"/);
  assert.doesNotMatch(html, /Fixture Person|Watch|switch|checkbox|triggers/);
  const named = renderToStaticMarkup(
    createElement(ConnectedAccount, { account, busy: true, onDisconnect() {} }),
  );
  assert.match(named, /fixture@example.com/);
  assert.match(named, /aria-label="Disconnect fixture@example.com from Gmail"/);
  assert.match(named, /disabled=""/);
  assert.doesNotMatch(named, /Fixture Person|>Disconnect</);
  const unknown = renderToStaticMarkup(
    createElement(ConnectedAccount, {
      account: { ...account, accountName: undefined, accountEmail: undefined },
      busy: false,
      onDisconnect() {},
    }),
  );
  assert.match(unknown, /Account details unavailable/);
});

test('connection rows reserve warnings for account access and hide notification setup details', () => {
  assert.equal(connectionIssue(account), null);
  assert.equal(
    connectionIssue({ ...account, supportsTriggers: false, triggersActive: false }),
    null,
  );
  assert.equal(
    connectionIssue({ ...account, triggersActive: false, triggerStatus: 'unavailable' })!,
    null,
  );
  assert.equal(
    connectionIssue({ ...account, triggersActive: false, triggerStatus: 'pending' })!,
    null,
  );
  assert.equal(connectionIssue({ ...account, status: 'disconnected' }), 'Sign-in required');
});

test('account identity deduplicates matching email and removing one account preserves its siblings', () => {
  assert.deepEqual(connectionIdentity({ ...account, accountName: ' fixture@example.com ' }), {
    primary: 'fixture@example.com',
    secondary: null,
  });
  assert.deepEqual(connectionIdentity(account), {
    primary: 'Fixture Person',
    secondary: 'fixture@example.com',
  });
  const second = { ...account, connectionId: 'second', accountEmail: 'second@example.com' };
  assert.deepEqual(removeConnection([account, second], account.connectionId!), [second]);
  const final = removeConnection([account], account.connectionId!);
  assert.equal(final[0].status, 'disconnected');
  assert.equal(final[0].connectionId, undefined);
  assert.equal(final[0].accountEmail, undefined);
  assert.equal(final[0].slug, 'gmail');
});

test('goal and schedule actions prepare a named contextual draft without sending or mutating', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget();
  const events: unknown[] = [];
  target.addEventListener('otto:compose', (event) => events.push((event as CustomEvent).detail));
  Object.defineProperty(globalThis, 'window', { value: target, configurable: true });
  try {
    draftInChat(goalDraft(goal, 'status'));
    draftInChat(scheduleDraft(schedule, 'discuss'));
    assert.deepEqual(events, [
      { text: 'Pause the goal "Read a book".', send: false },
      {
        text: 'I\'d like to change the schedule "Morning briefing". Its current timing is 30 9 * * 1 in Europe/Lisbon.',
        send: false,
      },
    ]);
    assert.match(goalDraft({ ...goal, status: 'paused' }, 'status'), /^Resume/);
    assert.match(scheduleDraft({ ...schedule, enabled: false }, 'status'), /^Resume/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('saved goals and schedules render readable state with chat actions rather than edit forms', () => {
  const goalHtml = renderToStaticMarkup(
    createElement(GoalRow, { goal: { ...goal, title: '<img src="https://example.com/private">' } }),
  );
  assert.match(goalHtml, /Update/);
  assert.match(goalHtml, /Choose the next chapter/);
  assert.match(goalHtml, /30%/);
  assert.doesNotMatch(goalHtml, /<form|<input|<textarea|<img/);
  const scheduleHtml = renderToStaticMarkup(createElement(ScheduleRow, { schedule }));
  assert.match(scheduleHtml, /Every Monday at 09:30/);
  assert.match(scheduleHtml, /Europe\/Lisbon/);
  assert.match(scheduleHtml, /Change/);
  assert.doesNotMatch(scheduleHtml, /<form|<input|<textarea/);
});

test('channel steps reveal only the current credentials and never repeat secrets in the review', () => {
  const fields = {
    botToken: 'fixture-private-bot-token',
    allowedUserId: '123456',
    accessToken: 'fixture-private-access-token',
    appSecret: 'fixture-private-app-secret',
  };
  const base = { fields, policy: false, onField() {}, onPolicy() {} };
  const token = renderToStaticMarkup(
    createElement(ChannelSetupStep, { ...base, provider: 'telegram', step: 0 }),
  );
  assert.equal((token.match(/<input/g) ?? []).length, 1);
  assert.match(token, /type="password"/);
  assert.doesNotMatch(token, /Telegram user ID/);
  const review = renderToStaticMarkup(
    createElement(ChannelSetupStep, { ...base, provider: 'telegram', step: 2 }),
  );
  assert.match(review, /123456/);
  assert.doesNotMatch(review, /fixture-private|type="password"/);
  const intro = renderToStaticMarkup(
    createElement(ChannelSetupStep, { ...base, provider: 'whatsapp', step: 0 }),
  );
  assert.match(intro, /business bot number/);
  assert.match(intro, /24 hours/);
  assert.doesNotMatch(intro, /fixture-private|type="password"/);
  const keys = renderToStaticMarkup(
    createElement(ChannelSetupStep, { ...base, provider: 'whatsapp', step: 2 }),
  );
  assert.equal((keys.match(/type="password"/g) ?? []).length, 2);
  assert.doesNotMatch(keys, /fixture-private-bot-token/);
});

test('hosted channel setup keeps identity restrictions and omits operator callback controls', () => {
  const base = {
    fields: { allowedUserId: '123456' },
    hosted: true,
    policy: false,
    onField() {},
    onPolicy() {},
  };
  const identity = renderToStaticMarkup(
    createElement(ChannelSetupStep, { ...base, provider: 'telegram', step: 1 }),
  );
  assert.match(identity, /Your Telegram user ID/);
  assert.match(identity, /inputMode="numeric"/);
  assert.match(identity, /required/);
  const telegram = renderToStaticMarkup(
    createElement(ChannelSetupStep, { ...base, provider: 'telegram', step: 2 }),
  );
  assert.match(telegram, /123456/);
  assert.match(telegram, /press Start/);
  assert.doesNotMatch(telegram, /Mac|running|locally|webhook|type="url"/);
  const whatsapp = renderToStaticMarkup(
    createElement(ChannelSetupStep, { ...base, provider: 'whatsapp', step: 3 }),
  );
  assert.doesNotMatch(whatsapp, /type="url"|keep the rest of Otto private/);
  assert.match(whatsapp, /Webhook verification token/);
  assert.match(whatsapp, /After connecting, copy the callback URL into Meta/);
});

test('channel setup payloads include only the selected provider fields', () => {
  const fields = {
    botToken: ' bot-token ',
    allowedUserId: ' 123 ',
    accessToken: 'access-token',
    appSecret: 'app-secret',
    phoneNumberId: '456',
    allowedNumber: '351910000000',
    verifyToken: 'verification-token',
    webhookUrl: ' ',
  };
  assert.deepEqual(channelSetupBody('telegram', fields, false), {
    botToken: 'bot-token',
    allowedUserId: '123',
    webhookUrl: undefined,
  });
  const whatsapp = channelSetupBody('whatsapp', fields, true);
  assert.equal('botToken' in whatsapp, false);
  assert.equal('allowedUserId' in whatsapp, false);
  assert.equal('policyConfirmed' in whatsapp && whatsapp.policyConfirmed, true);
});

test('channel status separates saved configuration from delivery and limits bot links to verified handles', () => {
  assert.equal(channelLabel(undefined, true), 'Configuration present');
  assert.equal(channelLabel(undefined, false), 'Not connected');
  assert.equal(
    channelLabel(
      {
        provider: 'telegram',
        enabled: true,
        mode: 'webhook',
        webhookStatus: 'registration_pending',
      },
      true,
    ),
    'Setup needs a retry',
  );
  assert.equal(
    channelLabel(
      { provider: 'whatsapp', enabled: true, mode: 'webhook', webhookStatus: 'manual_setup' },
      true,
    ),
    'Finish delivery setup',
  );
  assert.equal(telegramBotUrl('@fixture_bot'), 'https://t.me/fixture_bot');
  assert.equal(telegramBotUrl('@fixture/../private'), null);
  assert.equal(telegramBotUrl('https://example.com'), null);
  const html = renderToStaticMarkup(
    createElement(ChannelAccount, {
      provider: 'telegram',
      setup: {
        provider: 'telegram',
        enabled: true,
        mode: 'polling',
        accountName: 'Fixture bot',
        accountHandle: '@fixture_bot',
      },
      configured: true,
      busy: false,
      onDisconnect() {},
    }),
  );
  assert.match(html, /Start conversation/);
  assert.match(html, /aria-label="Remove Telegram channel"/);
  assert.match(html, /title="Remove channel"/);
  assert.doesNotMatch(html, />Remove channel</);
  assert.match(html, /https:\/\/t.me\/fixture_bot/);
  assert.doesNotMatch(html, /Ready for messages|Delivered|Connected successfully/);
  assert.equal(channelLabel({ provider: 'telegram', enabled: true, mode: 'polling' }, true), null);
});
