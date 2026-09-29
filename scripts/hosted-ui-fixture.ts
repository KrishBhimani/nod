import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
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
import type { Artifact, Message } from '../src/shared/contracts.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));
const fixturePort = Number(process.env.OTTO_UI_PORT || 4346);
if (!Number.isInteger(fixturePort) || fixturePort < 1024 || fixturePort > 65535)
  throw new Error('Use a valid local fixture port.');
const origin = `http://localhost:${fixturePort}`;
const attachments = process.env.OTTO_UI_ATTACHMENTS === 'true';
const cookieName = 'otto-ui-fixture';
const users = [
  { id: randomUUID(), name: 'Alex Morgan', email: 'alex@example.test', avatarUrl: null },
  { id: randomUUID(), name: 'Sam Rivera', email: 'sam@example.test', avatarUrl: null },
];
function png(width: number, height: number) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const sky = y < height * 0.62;
      const sun = Math.hypot(x - width * 0.7, y - height * 0.42) < height * 0.12;
      const t = y / height;
      const [r, g, b] = sun
        ? [255, 214, 150]
        : sky
          ? [250 - t * 120, 170 - t * 60, 150 + t * 40]
          : [40 + (1 - t) * 60, 70 + (1 - t) * 50, 110 + ((x + y) % 23)];
      rows.set([r, g, b], row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pdf(pages: string[][]) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const lines of pages) {
    const text = lines
      .map((line, index) => {
        const size = index === 0 ? 22 : 12;
        const y = index === 0 ? 720 : 680 - index * 22;
        return `BT /F1 ${size} Tf 72 ${y} Td (${line}) Tj ET`;
      })
      .join('\n');
    const stream = `0.93 0.36 0.52 rg 72 752 60 6 re f\n0.1 0.1 0.14 rg\n${text}`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (objects.length - 3)} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let output = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(output);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 240" width="480" height="240">
<style>text { font: 600 15px system-ui, sans-serif; fill: #1b1924 }</style>
<rect x="20" y="80" width="120" height="64" rx="12" fill="#fceaec" stroke="#bc3666" stroke-width="2"/>
<rect x="180" y="80" width="120" height="64" rx="12" fill="#f2edf9" stroke="#7554a0" stroke-width="2"/>
<rect x="340" y="80" width="120" height="64" rx="12" fill="#edf5ef" stroke="#315c49" stroke-width="2"/>
<path d="M140 112h40M300 112h40" stroke="#6e697a" stroke-width="2"/>
<text x="80" y="117" text-anchor="middle">Request</text>
<text x="240" y="117" text-anchor="middle">Review</text>
<text x="400" y="117" text-anchor="middle">Deliver</text>
</svg>`;

const files = [
  {
    name: 'Harbour visit.png',
    mimeType: 'image/png',
    bytes: png(960, 640),
  },
  {
    name: 'Process diagram.svg',
    mimeType: 'image/svg+xml',
    bytes: Buffer.from(svg),
  },
  {
    name: 'Site sources.zip',
    mimeType: 'application/zip',
    bytes: Buffer.concat([Buffer.from('PK\x05\x06'), Buffer.alloc(18_000)]),
  },
  {
    name: 'Harbour renovation plan.pdf',
    mimeType: 'application/pdf',
    bytes: pdf([
      [
        'Harbour renovation plan',
        'Synthetic document for the Otto UI fixture.',
        '1. Survey the north pier and record damage.',
        '2. Replace the lighting along the promenade.',
        '3. Add seating near the ferry entrance.',
        '4. Review costs with the city team.',
      ],
      ['Schedule', 'Phase one starts in March.', 'Phase two starts in June.'],
      ['Budget', 'All numbers in this fixture are fictional.'],
    ]),
  },
].map((file, index) => ({
  ...file,
  id: `00000000-0000-4000-8000-0000000000a${index}`,
}));

const fixtureArtifacts = new Map(files.map((file) => [file.id, file]));

const artifact = (index: number): Artifact => ({
  id: files[index].id,
  name: files[index].name,
  mimeType: files[index].mimeType,
  size: files[index].bytes.length,
  url: `/api/artifacts/${files[index].id}`,
});

function fixtureMessages(): Message[] {
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  return [
    {
      id: 'fixture-attachments-1',
      role: 'user',
      text: 'Here is a photo from the harbour visit. Can you make a short plan?',
      taskId: 'fixture-attachments-task',
      createdAt: at(12),
      attachments: [artifact(0)],
    },
    {
      id: 'fixture-attachments-2',
      role: 'assistant',
      text: 'I made a process diagram and put the source notes in an archive.',
      taskId: 'fixture-attachments-task',
      createdAt: at(10),
      attachments: [artifact(1), artifact(2)],
    },
    {
      id: 'fixture-attachments-3',
      role: 'assistant',
      text: '',
      taskId: 'fixture-attachments-task',
      createdAt: at(9),
      attachments: [artifact(3)],
    },
  ];
}
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
      if (url.pathname === '/api/state')
        return Response.json({
          conversationRevision: 0,
          messages: attachments ? fixtureMessages() : [],
          tasks: [],
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
      const file = attachments
        ? fixtureArtifacts.get(/^\/api\/artifacts\/([a-f0-9-]+)$/.exec(url.pathname)?.[1] ?? '')
        : undefined;
      if (file)
        return new Response(file.bytes, {
          headers: {
            'content-type': file.mimeType,
            'content-disposition': `${file.mimeType === 'application/zip' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          },
        });
      if (url.pathname === '/api/events') {
        let timer: ReturnType<typeof setInterval>;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"type":"refresh"}\n\n'));
              timer = setInterval(
                () => controller.enqueue(new TextEncoder().encode(': fixture\n\n')),
                30_000,
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
