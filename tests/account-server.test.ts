import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { AuthenticationProvider } from '../src/ports/authentication.ts';
import type { AccountStore, StoredAccount } from '../src/server/account-store.ts';
import { createAccountSession } from '../src/server/account.ts';

async function fixture() {
  const records = new Map<string, StoredAccount>();
  const calls = { signIn: 0, signOut: 0, callback: '', writes: [] as string[] };
  let enabled = true;
  const accounts: AccountStore = {
    async read(owner) {
      return (
        records.get(owner) ?? { theme: 'system', onboardingCompleted: false, displayName: null }
      );
    },
    async update(owner, input) {
      calls.writes.push(owner);
      const saved = await accounts.read(owner);
      const next = {
        theme: input.theme ?? saved.theme,
        onboardingCompleted: input.onboardingCompleted ?? saved.onboardingCompleted,
        displayName: input.name ?? saved.displayName,
      };
      records.set(owner, next);
      return next;
    },
  };
  const authentication: AuthenticationProvider = {
    configured: true,
    async initialize() {},
    async session(headers) {
      const id =
        headers.get('cookie') === 'fixture=alex'
          ? 'alex'
          : headers.get('cookie') === 'fixture=sam'
            ? 'sam'
            : null;
      return enabled && id
        ? {
            id: `session-${id}`,
            expiresAt: new Date('2099-01-01'),
            user: { id, name: `Google ${id}`, email: `${id}@example.test`, avatarUrl: null },
          }
        : null;
    },
    async signIn() {
      calls.signIn++;
      const headers = new Headers();
      headers.append('set-cookie', 'fixture-state=one; HttpOnly; Secure; SameSite=Lax');
      headers.append('set-cookie', 'fixture-verifier=two; HttpOnly; Secure; SameSite=Lax');
      return Response.json({ url: 'https://accounts.example.test/consent' }, { headers });
    },
    async signOut() {
      calls.signOut++;
      return Response.json({ ok: true });
    },
    async callback(request) {
      calls.callback = request.url;
      return Response.redirect('https://sidekick.example.test/');
    },
  };
  const app = Fastify();
  app.setErrorHandler((_error, _request, reply) =>
    reply.code(400).send({ error: 'Invalid account request.' }),
  );
  const account = createAccountSession({
    accounts,
    origin: 'https://sidekick.example.test',
    authentication,
    developerIds: new Set(['alex']),
  });
  account.register(app);
  await app.ready();
  return {
    app,
    calls,
    records,
    revoke: () => {
      enabled = false;
    },
  };
}

test('session response uses the cookie identity and owned settings without exposing provider data', async () => {
  const { app, records, revoke } = await fixture();
  records.set('alex', { theme: 'dark', onboardingCompleted: true, displayName: 'Alex Example' });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie: 'fixture=alex', 'x-sidekick-account': 'sam' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), {
      auth: { mode: 'google', googleAvailable: true },
      user: { id: 'alex', name: 'Alex Example', email: 'alex@example.test', avatarUrl: null },
      settings: { theme: 'dark', onboardingCompleted: true },
      capabilities: { developer: true },
    });
    revoke();
    const expired = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie: 'fixture=alex' },
    });
    assert.equal(expired.json().user, null);
    assert.equal(expired.json().settings, null);
    assert.equal(expired.json().capabilities.developer, false);
  } finally {
    await app.close();
  }
});

test('account changes require same origin and matching principal and reject identity overrides', async () => {
  const { app, calls, records } = await fixture();
  const headers = {
    origin: 'https://sidekick.example.test',
    cookie: 'fixture=alex',
    'x-sidekick-account': 'alex',
  };
  try {
    const foreign = await app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers: { ...headers, 'x-sidekick-account': 'sam' },
      payload: { name: 'Changed' },
    });
    assert.equal(foreign.statusCode, 401);
    for (const payload of [
      { ownerId: 'sam' },
      { email: 'other@example.test' },
      { developer: true },
      { avatarUrl: 'https://example.test/pixel' },
    ]) {
      const rejected = await app.inject({ method: 'PATCH', url: '/api/account', headers, payload });
      assert.equal(rejected.statusCode, 400);
    }
    const crossOrigin = await app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers: { ...headers, origin: 'https://elsewhere.example.test' },
      payload: { theme: 'light' },
    });
    assert.equal(crossOrigin.statusCode, 403);
    assert.deepEqual(calls.writes, []);
    const accepted = await app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers,
      payload: { name: ' Alex Example ', theme: 'dark', onboardingCompleted: true },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().user.id, 'alex');
    assert.equal(accepted.json().user.name, 'Alex Example');
    assert.equal(accepted.json().settings.theme, 'dark');
    assert.equal(records.has('sam'), false);
    assert.deepEqual(calls.writes, ['alex']);
  } finally {
    await app.close();
  }
});

test('a stale account cannot log out a newer cookie principal', async () => {
  const { app, calls } = await fixture();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: {
        origin: 'https://sidekick.example.test',
        cookie: 'fixture=sam',
        'x-sidekick-account': 'alex',
      },
      payload: {},
    });
    assert.equal(response.statusCode, 401);
    assert.equal(calls.signOut, 0);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: {
        origin: 'https://sidekick.example.test',
        cookie: 'fixture=sam',
        'x-sidekick-account': 'sam',
      },
      payload: {},
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(calls.signOut, 1);
  } finally {
    await app.close();
  }
});

test('Google sign-in keeps the fixed flow, both state cookies and configured callback origin', async () => {
  const { app, calls } = await fixture();
  try {
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: 'https://sidekick.example.test' },
      payload: { callbackURL: 'https://elsewhere.example.test' },
    });
    assert.equal(rejected.statusCode, 400);
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: 'https://elsewhere.example.test' },
      payload: {},
    });
    assert.equal(crossSite.statusCode, 403);
    assert.equal(calls.signIn, 0);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: 'https://sidekick.example.test' },
      payload: {},
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().url, 'https://accounts.example.test/consent');
    assert.equal(accepted.cookies.length, 2);
    await app.inject({
      method: 'GET',
      url: '/api/auth/callback/google?state=synthetic&code=fixture',
      headers: { host: 'untrusted.example.test' },
    });
    assert.equal(
      calls.callback,
      'https://sidekick.example.test/api/auth/callback/google?state=synthetic&code=fixture',
    );
  } finally {
    await app.close();
  }
});
