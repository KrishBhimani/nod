import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createGateway } from '../src/server/gateway.ts';
import type { AuthenticatedSession, AuthenticationProvider } from '../src/ports/authentication.ts';
import type { StoredAccount } from '../src/server/account-store.ts';
import { defaultPreferences, preferencesSchema } from '../src/server/preferences.ts';
import {
  integrationServiceIds,
  integrationServices,
  type IntegrationService,
} from '../src/shared/integrations.ts';
import type { Goal, Message, Schedule, ScheduleRun, Task } from '../src/shared/contracts.ts';

const hour = 3_600_000;
const at = (offset: number) => new Date(Date.now() + offset).toISOString();
const timeZone = 'Europe/Lisbon';

const fixtureGoals: Goal[] = [
  {
    id: 'a1f0c3de-0000-4000-8000-000000000001',
    title: 'Run a half marathon',
    description: 'Build up to 21 km with three runs each week.',
    progress: 40,
    status: 'active',
    nextAction: 'Plan the long run for Sunday.',
    targetDate: '2026-12-06',
    updatedAt: at(-5 * hour),
  },
  {
    id: 'a1f0c3de-0000-4000-8000-000000000002',
    title: 'Read twelve books this year',
    description: 'One book each month, mostly fiction.',
    progress: 75,
    status: 'active',
    nextAction: 'Choose the October book.',
    targetDate: '2026-12-31',
    updatedAt: at(-30 * hour),
  },
  {
    id: 'a1f0c3de-0000-4000-8000-000000000003',
    title: 'Learn basic Portuguese grammar',
    description: 'Short lessons on weekday evenings.',
    progress: 20,
    status: 'paused',
    nextAction: 'Review verb tenses.',
    targetDate: null,
    updatedAt: at(-80 * hour),
  },
  {
    id: 'a1f0c3de-0000-4000-8000-000000000004',
    title: 'Plan the summer trip',
    description: 'Book flights and a place to stay.',
    progress: 100,
    status: 'completed',
    nextAction: '',
    targetDate: '2026-06-01',
    updatedAt: at(-900 * hour),
  },
];

const briefingMessage = 'b2e1d4ef-0000-4000-8000-000000000011';
const reviewMessage = 'b2e1d4ef-0000-4000-8000-000000000012';

const fixtureRuns: ScheduleRun[] = [
  {
    id: 'c3f2e5f0-0000-4000-8000-000000000021',
    scheduleId: 'd4a3f6a1-0000-4000-8000-000000000031',
    title: 'Morning briefing',
    taskId: 'e5b4a7b2-0000-4000-8000-000000000041',
    scheduledFor: at(-2 * hour),
    timeZone,
    createdAt: at(-2 * hour),
    status: 'succeeded',
    error: null,
    messageId: briefingMessage,
    messageText:
      'Good morning. You have two meetings today: design review at 10:00 and a call with Sam at 15:30.\n\nRain is likely after 17:00, so plan the run for the morning.',
    messagePreview:
      'Good morning. You have two meetings today: design review at 10:00 and a call with Sam at 15:30. Rain is likely after 17:00, so plan the run for the…',
  },
  {
    id: 'c3f2e5f0-0000-4000-8000-000000000022',
    scheduleId: 'd4a3f6a1-0000-4000-8000-000000000033',
    title: 'Weekly review',
    taskId: 'e5b4a7b2-0000-4000-8000-000000000042',
    scheduledFor: at(-26 * hour),
    timeZone,
    createdAt: at(-26 * hour),
    status: 'succeeded',
    error: null,
    messageId: reviewMessage,
    messageText:
      'Last week you ran 14 km and finished two chapters.\n\nNext step for the half marathon goal: plan the long run for Sunday.',
    messagePreview:
      'Last week you ran 14 km and finished two chapters. Next step for the half marathon goal: plan the long run for Sunday.',
  },
  {
    id: 'c3f2e5f0-0000-4000-8000-000000000023',
    scheduleId: 'd4a3f6a1-0000-4000-8000-000000000031',
    title: 'Morning briefing',
    taskId: 'e5b4a7b2-0000-4000-8000-000000000043',
    scheduledFor: at(-50 * hour),
    timeZone,
    createdAt: at(-50 * hour),
    status: 'succeeded',
    error: null,
    messageId: null,
    messagePreview: null,
    messageText: null,
  },
  {
    id: 'c3f2e5f0-0000-4000-8000-000000000024',
    scheduleId: 'd4a3f6a1-0000-4000-8000-000000000032',
    title: 'Send a reminder',
    taskId: 'e5b4a7b2-0000-4000-8000-000000000044',
    scheduledFor: at(-74 * hour),
    timeZone,
    createdAt: at(-74 * hour),
    status: 'failed',
    error: 'The task could not finish.',
    messageId: null,
    messagePreview: null,
    messageText: null,
  },
];

const fixtureSchedules: Schedule[] = [
  {
    id: 'd4a3f6a1-0000-4000-8000-000000000031',
    title: 'Morning briefing',
    prompt: 'Summarize my calendar, the weather and anything urgent.',
    kind: 'recurring',
    cron: '30 8 * * *',
    runAt: null,
    timeZone,
    enabled: true,
    revision: 0,
    nextRun: at(20 * hour),
    lastRun: fixtureRuns[0],
  },
  {
    id: 'd4a3f6a1-0000-4000-8000-000000000032',
    title: 'Send a reminder',
    prompt: 'Remind me to book the dentist.',
    kind: 'once',
    cron: null,
    runAt: at(50 * hour),
    timeZone,
    enabled: true,
    revision: 1,
    nextRun: at(50 * hour),
    lastRun: fixtureRuns[3],
  },
  {
    id: 'd4a3f6a1-0000-4000-8000-000000000033',
    title: 'Weekly review',
    prompt: 'Review my goals and suggest one next step for each.',
    kind: 'recurring',
    cron: '0 18 * * 0',
    runAt: null,
    timeZone,
    enabled: false,
    revision: 2,
    nextRun: null,
    lastRun: fixtureRuns[1],
  },
];

const message = (
  id: string,
  role: Message['role'],
  text: string,
  offset: number,
  taskId: string | null = null,
): Message => ({ id, role, text, taskId, createdAt: at(offset), attachments: [] });

const fixtureMessages: Message[] = [
  message(
    'b2e1d4ef-0000-4000-8000-000000000001',
    'user',
    'Can you check my goals every Sunday evening?',
    -30 * hour,
    'e5b4a7b2-0000-4000-8000-000000000051',
  ),
  message(
    'b2e1d4ef-0000-4000-8000-000000000002',
    'assistant',
    'Done. I scheduled a weekly review every Sunday at 18:00.',
    -30 * hour + 60_000,
    'e5b4a7b2-0000-4000-8000-000000000051',
  ),
  message(
    reviewMessage,
    'assistant',
    'Last week you ran 14 km and finished two chapters.\n\nNext step for the half marathon goal: plan the long run for Sunday.',
    -26 * hour,
    'e5b4a7b2-0000-4000-8000-000000000042',
  ),
  ...Array.from({ length: 8 }, (_, index) =>
    message(
      `b2e1d4ef-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
      index % 2 ? 'assistant' : 'user',
      index % 2
        ? 'Here is a short answer with the details you asked for. I kept it brief so you can scan it quickly.'
        : 'One more question about my plans for this week.',
      -20 * hour + index * 20 * 60_000,
      'e5b4a7b2-0000-4000-8000-000000000052',
    ),
  ),
  message(
    briefingMessage,
    'assistant',
    'Good morning. You have two meetings today: design review at 10:00 and a call with Sam at 15:30.\n\nRain is likely after 17:00, so plan the run for the morning.',
    -2 * hour,
    'e5b4a7b2-0000-4000-8000-000000000041',
  ),
  message(
    'b2e1d4ef-0000-4000-8000-000000000003',
    'user',
    'Thanks. Move the call with Sam to 16:00.',
    -1 * hour,
    'e5b4a7b2-0000-4000-8000-000000000053',
  ),
  message(
    'b2e1d4ef-0000-4000-8000-000000000004',
    'assistant',
    'The call with Sam is now at 16:00.',
    -1 * hour + 60_000,
    'e5b4a7b2-0000-4000-8000-000000000053',
  ),
];

const days: Record<string, string> = {
  weekdays: '1-5',
  weekends: '0,6',
  'every day': '*',
  daily: '*',
};

function createPlansFixture() {
  const goals: Goal[] = structuredClone(fixtureGoals);
  const schedules: Schedule[] = structuredClone(fixtureSchedules);
  const messages: Message[] = structuredClone(fixtureMessages);
  const tasks: Task[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  function reply(text: string) {
    const lower = text.toLowerCase();
    const schedule = schedules.find((item) => text.includes(`"${item.title}"`));
    const goal = goals.find((item) => text.includes(`"${item.title}"`));
    const time = /(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?/i.exec(text);
    if (schedule) {
      const [minute, hour, , , day] = (schedule.cron ?? '0 9 * * *').split(' ');
      const nextDay = Object.entries(days).find(([word]) => lower.includes(word))?.[1] ?? day;
      const suffix = time?.[3]?.toLowerCase();
      const nextHour = !time
        ? hour
        : String(suffix ? (Number(time[1]) % 12) + (suffix === 'pm' ? 12 : 0) : Number(time[1]));
      const nextMinute = time ? String(Number(time[2] ?? 0)) : minute;
      if (lower.includes('pause') || lower.includes('resume')) {
        schedule.enabled = lower.includes('resume');
        schedule.nextRun = schedule.enabled ? new Date(Date.now() + 20 * hour).toISOString() : null;
      } else if (schedule.kind === 'recurring')
        schedule.cron = `${nextMinute} ${nextHour} * * ${nextDay}`;
      schedule.revision += 1;
      return schedule.enabled
        ? `Done. ${schedule.title} now runs at ${nextHour.padStart(2, '0')}:${nextMinute.padStart(2, '0')}${nextDay === '1-5' ? ' on weekdays' : ''}.`
        : `Done. I paused ${schedule.title}.`;
    }
    if (goal) {
      const percent = /(\d{1,3})\s*%/.exec(text);
      if (percent) goal.progress = Math.min(100, Number(percent[1]));
      if (lower.includes('pause')) goal.status = 'paused';
      if (lower.includes('done') || lower.includes('complete')) goal.status = 'completed';
      const next = /next step[^:]*:\s*(.+)$/i.exec(text);
      if (next) goal.nextAction = next[1].trim();
      goal.updatedAt = new Date().toISOString();
      return `Done. I updated ${goal.title}${percent ? ` to ${goal.progress}%` : ''}.`;
    }
    if (lower.startsWith('new goal')) {
      const title = text.replace(/^new goal:\s*/i, '').slice(0, 80) || 'New goal';
      goals.unshift({
        ...fixtureGoals[0],
        id: randomUUID(),
        title,
        description: '',
        progress: 0,
        nextAction: 'Choose the first step.',
        targetDate: null,
      });
      return `Done. I added the goal ${title}.`;
    }
    if (lower.startsWith('new schedule')) {
      const title = text.replace(/^new schedule:\s*/i, '').slice(0, 80) || 'New schedule';
      schedules.unshift({
        ...fixtureSchedules[0],
        id: randomUUID(),
        title,
        prompt: title,
        lastRun: null,
      });
      return `Done. I scheduled ${title} every day at 08:30.`;
    }
    return 'I noted that. Tell me what to change and I will do it.';
  }
  async function handle(request: Request, url: URL): Promise<Response | null> {
    const patch = /^\/api\/(goals|schedules)\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET') {
      if (url.pathname === '/api/goals') return Response.json(goals);
      if (url.pathname === '/api/schedules') return Response.json(schedules);
      if (url.pathname === '/api/schedule-runs')
        return Response.json({ runs: fixtureRuns, nextCursor: null });
      if (url.pathname === '/api/messages') return Response.json([]);
      return null;
    }
    if (request.method === 'PATCH' && patch) {
      const list: Array<Goal | Schedule> = patch[1] === 'goals' ? goals : schedules;
      const item = list.find((entry) => entry.id === patch[2]);
      if (!item) return Response.json({ error: 'Not found.' }, { status: 404 });
      Object.assign(item, await request.json());
      if ('enabled' in item) {
        item.revision += 1;
        item.nextRun = item.enabled ? new Date(Date.now() + 20 * hour).toISOString() : null;
      }
      changed();
      return Response.json(item);
    }
    if (request.method === 'POST' && url.pathname === '/api/messages') {
      const body = (await request.json()) as { text: string; clientMessageId?: string };
      const taskId = randomUUID();
      const messageId = body.clientMessageId ?? randomUUID();
      const now = new Date().toISOString();
      messages.push({
        id: messageId,
        role: 'user',
        text: body.text,
        taskId,
        createdAt: now,
        attachments: [],
      });
      tasks.unshift({
        id: taskId,
        title: body.text.slice(0, 100),
        status: 'running',
        createdAt: now,
        updatedAt: now,
        showTyping: true,
      });
      changed();
      setTimeout(() => {
        const index = tasks.findIndex((task) => task.id === taskId);
        if (index < 0) return;
        const answer = reply(body.text);
        const done = new Date().toISOString();
        messages.push({
          id: randomUUID(),
          role: 'assistant',
          text: answer,
          taskId,
          createdAt: done,
          attachments: [],
        });
        Object.assign(tasks[index], {
          status: 'succeeded',
          updatedAt: done,
          showTyping: false,
        });
        changed();
      }, 1800);
      return Response.json({ taskId, messageId, continued: false });
    }
    return null;
  }
  function reset() {
    goals.splice(0, goals.length, ...structuredClone(fixtureGoals));
    schedules.splice(0, schedules.length, ...structuredClone(fixtureSchedules));
    messages.splice(0, messages.length, ...structuredClone(fixtureMessages));
    tasks.splice(0, tasks.length);
    changed();
  }
  return {
    reset,
    handle,
    state: () => ({ messages, tasks }),
    listen(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const repository = fileURLToPath(new URL('..', import.meta.url));
const fixturePort = Number(process.env.OTTO_UI_PORT || 4346);
if (!Number.isInteger(fixturePort) || fixturePort < 1024 || fixturePort > 65535)
  throw new Error('Use a valid local fixture port.');
const origin = `http://localhost:${fixturePort}`;
const plansEnabled = process.env.OTTO_UI_FIXTURE_DATA === 'plans';
const plans = new Map<string, ReturnType<typeof createPlansFixture>>();
function plansFor(owner: string) {
  if (!plansEnabled) return null;
  const current = plans.get(owner) ?? createPlansFixture();
  plans.set(owner, current);
  return current;
}
const cookieName = 'otto-ui-fixture';
const users = [
  { id: randomUUID(), name: 'Alex Morgan', email: 'alex@example.test', avatarUrl: null },
  { id: randomUUID(), name: 'Sam Rivera', email: 'sam@example.test', avatarUrl: null },
];
const sessions = new Map<string, AuthenticatedSession>();
const pending = new Set<string>();
const accounts = new Map<string, StoredAccount>();
const preferences = new Map<string, typeof defaultPreferences>();
const connections = new Map<string, Set<IntegrationService>>();
const consent = new Map<
  string,
  { ownerId: string; service: IntegrationService; returnTo: string }
>();
const avatar = new Uint8Array(
  await readFile(new URL('../public/apple-touch-icon.png', import.meta.url)),
);
const account = (owner: string) =>
  accounts.get(owner) ?? {
    theme: 'system' as const,
    onboardingCompleted: plansEnabled,
    displayName: null,
  };
function session(headers: Headers) {
  const token = headers.get('cookie')?.match(/(?:^|;\s*)otto-ui-fixture=([^;]+)/)?.[1];
  if (!token) return null;
  const current = sessions.get(token);
  if (current && current.expiresAt.getTime() > Date.now()) return current;
  sessions.delete(token);
  return null;
}
const authentication: AuthenticationProvider = {
  configured: true,
  async initialize() {},
  async session(headers) {
    return session(headers);
  },
  async signIn() {
    const state = randomUUID();
    pending.add(state);
    return Response.json({ url: `${origin}/fixture/consent?state=${state}` });
  },
  async signOut(headers) {
    const current = session(headers);
    for (const [token, value] of sessions) if (value.id === current?.id) sessions.delete(token);
    return Response.json(
      { ok: true },
      { headers: { 'set-cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } },
    );
  },
  async callback() {
    return Response.redirect(`${origin}/login?error=sign-in`);
  },
  async avatar() {
    return { bytes: avatar, mimeType: 'image/png' };
  },
};
const app = await createGateway({
  origin,
  privacyNotice: [
    'This is a local interface preview with fictional accounts and app connections.',
    '## Preview data',
    'Names, settings and connections exist only in memory and reset when the preview server restarts.',
    '## Connected services',
    'This preview does not sign in to Google, access connected apps or send messages.',
  ].join('\n\n'),
  authentication,
  accounts: {
    async read(owner) {
      return account(owner);
    },
    async update(owner, change) {
      const previous = account(owner);
      const next = {
        ...previous,
        ...(change.theme ? { theme: change.theme } : {}),
        ...(change.onboardingCompleted !== undefined
          ? { onboardingCompleted: change.onboardingCompleted }
          : {}),
        ...(change.name ? { displayName: change.name } : {}),
      };
      accounts.set(owner, next);
      return next;
    },
  },
  runtimes: {
    async fetch(owner, request) {
      const url = new URL(request.url);
      if (url.pathname === '/api/account/prepare') return Response.json({ ok: true });
      if (url.pathname === '/api/state')
        return Response.json({
          conversationRevision: 0,
          messages: plansFor(owner)?.state().messages ?? [],
          tasks: plansFor(owner)?.state().tasks ?? [],
          configuration: {
            provider: 'fixture',
            model: 'Synthetic UI fixture',
            llmReady: true,
            speechReady: false,
            integrationsReady: true,
            browserAssistReady: false,
            inspectorEnabled: false,
            localOnly: false,
          },
        });
      if (url.pathname === '/api/events') {
        let timer: ReturnType<typeof setInterval>;
        let stop: (() => void) | undefined;
        return new Response(
          new ReadableStream({
            start(controller) {
              const refresh = () =>
                controller.enqueue(new TextEncoder().encode('data: {"type":"refresh"}\n\n'));
              refresh();
              stop = plansFor(owner)?.listen(refresh);
              timer = setInterval(
                () => controller.enqueue(new TextEncoder().encode(': fixture\n\n')),
                30_000,
              );
            },
            cancel() {
              clearInterval(timer);
              stop?.();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (url.pathname === '/api/apps')
        return Response.json(
          integrationServiceIds.map((slug) => ({
            slug,
            name: integrationServices[slug].name,
            status: connections.get(owner)?.has(slug) ? 'connected' : 'disconnected',
            triggersEnabled: false,
            ...(connections.get(owner)?.has(slug)
              ? {
                  connectionId: `${owner}-${slug}`,
                  accountName: users.find((user) => user.id === owner)?.name,
                }
              : {}),
          })),
        );
      const connect = /^\/api\/apps\/([^/]+)\/connect$/.exec(url.pathname);
      if (
        connect &&
        request.method === 'POST' &&
        integrationServiceIds.includes(connect[1] as IntegrationService)
      ) {
        const input = (await request.json()) as { returnTo?: string };
        const token = randomUUID();
        consent.set(token, {
          ownerId: owner,
          service: connect[1] as IntegrationService,
          returnTo: input.returnTo === 'onboarding' ? '/onboarding' : '/apps',
        });
        return Response.json({ url: `${origin}/fixture/connect?token=${token}` });
      }
      if (url.pathname === '/api/preferences') {
        const previous = preferences.get(owner) ?? { ...defaultPreferences };
        if (request.method === 'PATCH')
          preferences.set(owner, {
            ...previous,
            ...preferencesSchema.partial().parse(await request.json()),
          });
        return Response.json(preferences.get(owner) ?? previous);
      }
      const planned = await plansFor(owner)?.handle(request, url);
      if (planned) return planned;
      if (url.pathname === '/api/messages/history')
        return Response.json({ messages: [], hasMore: false });
      if (url.pathname === '/api/messages')
        return Response.json(
          { error: 'The UI fixture does not run an assistant.' },
          { status: 503 },
        );
      return Response.json(
        { error: 'This capability is unavailable in the UI fixture.' },
        { status: 404 },
      );
    },
    async close() {},
  },
});
const page = (heading: string, content: string) =>
  `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Otto UI fixture</title><body style="font:16px system-ui;margin:0;background:#f9f8f6;color:#242229"><main style="max-width:420px;margin:15vh auto;padding:28px"><p>Otto UI fixture</p><h1>${heading}</h1>${content}<p style="color:#666;font-size:13px">Synthetic accounts and permissions. No provider is contacted.</p></main></body></html>`;
app.get('/fixture/consent', async (request, reply) => {
  const state = new URL(request.url, origin).searchParams.get('state') ?? '';
  if (!pending.has(state)) return reply.code(400).send('This fixture sign-in has expired.');
  return reply
    .type('text/html')
    .send(
      page(
        'Choose a fixture account',
        users
          .map(
            (user, index) =>
              `<a role="button" href="/fixture/sign-in/${index}?state=${state}" style="display:block;padding:18px;margin:14px 0;background:white;border:1px solid #ddd;border-radius:12px;text-align:left;color:inherit;text-decoration:none">Continue as ${user.name}<br><small>${user.email}</small></a>`,
          )
          .join(''),
      ),
    );
});
app.get('/fixture/sign-in/:index', async (request, reply) => {
  const state = new URL(request.url, origin).searchParams.get('state') ?? '';
  const index = Number((request.params as { index: string }).index);
  if (!pending.delete(state) || !Number.isInteger(index) || !users[index])
    return reply.code(400).send('This fixture sign-in has expired.');
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, {
    id: randomUUID(),
    user: users[index],
    avatarSource: 'fixture:avatar',
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return reply
    .header('set-cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax`)
    .redirect('/');
});
app.get('/fixture/plans/reset', async (_request, reply) => {
  for (const fixture of plans.values()) fixture.reset();
  return reply.send({ ok: plansEnabled });
});
app.get('/fixture/connect', async (request, reply) => {
  const token = new URL(request.url, origin).searchParams.get('token') ?? '';
  const attempt = consent.get(token);
  if (
    !attempt ||
    session(new Headers({ cookie: request.headers.cookie ?? '' }))?.user.id !== attempt.ownerId
  )
    return reply.code(401).send('Sign in to use this fixture.');
  return reply
    .type('text/html')
    .send(
      page(
        `Connect ${integrationServices[attempt.service].name}`,
        `<a role="button" href="/fixture/connected?token=${token}&result=connected" style="padding:12px 20px;display:inline-block">Connect</a> <a role="button" href="/fixture/connected?token=${token}&result=cancelled" style="padding:12px 20px;display:inline-block">Cancel</a>`,
      ),
    );
});
app.get('/fixture/connected', async (request, reply) => {
  const token = new URL(request.url, origin).searchParams.get('token') ?? '';
  const attempt = consent.get(token);
  if (
    !attempt ||
    session(new Headers({ cookie: request.headers.cookie ?? '' }))?.user.id !== attempt.ownerId
  )
    return reply.code(401).send('Sign in to use this fixture.');
  consent.delete(token);
  const result = new URL(request.url, origin).searchParams.get('result');
  if (result === 'connected') {
    const apps = connections.get(attempt.ownerId) ?? new Set();
    apps.add(attempt.service);
    connections.set(attempt.ownerId, apps);
  }
  return reply.redirect(
    `${attempt.returnTo}?connection=${result === 'connected' ? 'connected' : 'cancelled'}`,
  );
});
const vite = await createServer({
  root: repository,
  server: {
    middlewareMode: true,
    hmr: { server: app.server },
    watch: { ignored: ['**/.local/**', '**/.env*'] },
    fs: {
      deny: [
        '.env',
        '.env.*',
        '**/.git/**',
        '**/.local/**',
        '**/src/server/**',
        '**/src/providers/**',
        '**/src/runtime/**',
        '**/src/ports/**',
        '**/*.pem',
      ],
    },
  },
  appType: 'spa',
});
await app.register((await import('@fastify/middie')).default);
app.use((request, response, next) =>
  request.url?.startsWith('/api/') || request.url?.startsWith('/fixture/')
    ? next()
    : vite.middlewares(request, response, next),
);
app.addHook('preClose', async () => vite.close());
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (!closing) {
      closing = true;
      void app.close();
    }
  });
await app.listen({ host: '127.0.0.1', port: fixturePort });
console.log(`Synthetic hosted UI fixture is ready at ${origin}.`);
