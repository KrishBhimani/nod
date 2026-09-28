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

const repository = fileURLToPath(new URL('..', import.meta.url));
const fixturePort = Number(process.env.OTTO_UI_PORT || 4346);
if (!Number.isInteger(fixturePort) || fixturePort < 1024 || fixturePort > 65535)
  throw new Error('Use a valid local fixture port.');
const origin = `http://localhost:${fixturePort}`;
const cookieName = 'otto-ui-fixture';
const users = [
  { id: randomUUID(), name: 'Alex Morgan', email: 'alex@example.test', avatarUrl: null },
  { id: randomUUID(), name: 'Sam Rivera', email: 'sam@example.test', avatarUrl: null },
];
const sessions = new Map<string, AuthenticatedSession>();
const pending = new Set<string>();
const accounts = new Map<string, StoredAccount>();
const preferences = new Map<string, typeof defaultPreferences>();
const connections = new Map<string, Set<IntegrationService>>([
  [users[0].id, new Set<IntegrationService>(['gmail', 'googlecalendar', 'slack'])],
]);
const welcomes = new Map<string, { startedAt: number; taskId: string; messageId: string }>();
const welcomeFindings: Partial<Record<IntegrationService, string>> = {
  gmail:
    '**The Q4 vendor contract from Maria Lopez.** It has waited four days for your reply, and she asked again this morning. I can read the 12-page draft, list what changed and write a reply for you to approve.',
  googlecalendar:
    '**Tomorrow at 09:30, budget review with Finance.** You have no notes yet. I can pull the numbers from your thread with Tom and prepare a one-page brief.',
  slack:
    '**Six mentions in #launch since Friday.** Two ask you to decide the release date. I can summarize both threads and draft your answer.',
};
function welcomeText(owner: string) {
  const name = users.find((user) => user.id === owner)?.name.split(' ')[0];
  const apps = integrationServiceIds.filter((slug) => connections.get(owner)?.has(slug));
  const findings = apps.flatMap((slug) => welcomeFindings[slug] ?? []);
  if (!findings.length)
    return `Hi ${name}, good to meet you. No apps are connected yet, so I cannot see your work. I can still help now: plan your week around your top three priorities, or research a topic and give you a one-page summary.\n\nIf you connect Gmail in Apps, I will find the threads that wait for your reply and draft the answers for you to approve.\n\nWhere should I start?`;
  return `Hi ${name}. I went through your ${apps.length > 1 ? 'apps' : integrationServices[apps[0]].name}, and ${findings.length > 1 ? `${['two', 'three'][findings.length - 2]} things stand out` : 'one thing stands out'}. I can take each one off your plate:\n\n${findings
    .map((finding, index) => `${index + 1}. ${finding}`)
    .join('\n')}\n\nShould I start with the contract?`;
}
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
    onboardingCompleted: false,
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
      if (url.pathname === '/api/onboarding/start') {
        if (!welcomes.has(owner))
          welcomes.set(owner, {
            startedAt: Date.now(),
            taskId: randomUUID(),
            messageId: randomUUID(),
          });
        return Response.json({ ok: true });
      }
      const welcome = welcomes.get(owner);
      const replied = welcome && Date.now() - welcome.startedAt > 6_000;
      if (url.pathname === '/api/state')
        return Response.json({
          conversationRevision: 0,
          messages: replied
            ? [
                {
                  id: welcome.messageId,
                  role: 'assistant',
                  text: welcomeText(owner),
                  taskId: welcome.taskId,
                  attachments: [],
                  createdAt: new Date(welcome.startedAt + 6_000).toISOString(),
                },
              ]
            : [],
          tasks: welcome
            ? [
                {
                  id: welcome.taskId,
                  title: 'Welcome',
                  status: replied ? 'succeeded' : 'queued',
                  showTyping: true,
                  createdAt: new Date(welcome.startedAt).toISOString(),
                  updatedAt: new Date(welcome.startedAt).toISOString(),
                },
              ]
            : [],
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
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"type":"refresh"}\n\n'));
              timer = setInterval(
                () => controller.enqueue(new TextEncoder().encode('data: {"type":"refresh"}\n\n')),
                2_000,
              );
            },
            cancel() {
              clearInterval(timer);
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
app.get('/fixture/chat', async (request, reply) => {
  const current = session(new Headers({ cookie: request.headers.cookie ?? '' }));
  if (!current) return reply.code(401).send('Sign in to use this fixture.');
  const search = new URL(request.url, origin).searchParams;
  welcomes.delete(current.user.id);
  if (search.get('state') !== 'empty')
    welcomes.set(current.user.id, {
      startedAt: Date.now(),
      taskId: randomUUID(),
      messageId: randomUUID(),
    });
  return reply.redirect('/');
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
