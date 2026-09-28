import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import type { AuthenticationProvider } from '../src/ports/authentication.ts';
import { createAccountSession } from '../src/server/account.ts';
import type { StoredAccount } from '../src/server/account-store.ts';

async function fixture(avatar?: AuthenticationProvider['avatar']) {
  const owners = [randomUUID(), randomUUID()];
  const accounts = new Map<string, StoredAccount>();
  let signIns = 0;
  let active = true;
  const auth: AuthenticationProvider = {
    configured: true,
    async initialize() {},
    async session(headers) {
      const index =
        headers.get('cookie') === 'session=a' ? 0 : headers.get('cookie') === 'session=b' ? 1 : -1;
      return index < 0 || !active
        ? null
        : {
            id: `session-${index}`,
            expiresAt: new Date(Date.now() + 60_000),
            ...(avatar
              ? { avatarSource: 'https://lh3.googleusercontent.com/synthetic-private-avatar' }
              : {}),
            user: {
              id: owners[index],
              name: index ? 'Blair' : 'Alex',
              email: `user${index}@example.test`,
              avatarUrl: null,
            },
          };
    },
    async signIn() {
      signIns++;
      return Response.json(
        { url: 'https://accounts.google.com/authorize' },
        { headers: { 'set-cookie': 'oauth=state; HttpOnly; SameSite=Lax' } },
      );
    },
    async signOut() {
      return Response.json(
        { success: true },
        { headers: { 'set-cookie': 'session=; Max-Age=0; HttpOnly' } },
      );
    },
    async callback() {
      return new Response(null, { status: 302, headers: { location: 'http://localhost:4399/' } });
    },
    avatar,
  };
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof Error && error.name === 'ZodError' ? 400 : 500)
      .send({ error: 'Account request failed.' }),
  );
  const session = createAccountSession({
    origin: 'http://localhost:4399',
    authentication: auth,
    developerIds: new Set([owners[0]]),
    accounts: {
      async read(id) {
        return (
          accounts.get(id) ?? { theme: 'system', onboardingCompleted: false, displayName: null }
        );
      },
      async update(id, input) {
        const before = await this.read(id);
        const next = {
          ...before,
          ...(input.theme ? { theme: input.theme } : {}),
          ...(input.onboardingCompleted !== undefined
            ? { onboardingCompleted: input.onboardingCompleted }
            : {}),
          ...(input.name ? { displayName: input.name } : {}),
        };
        accounts.set(id, next);
        return next;
      },
    },
  });
  session.register(app);
  return {
    app,
    owners,
    accounts,
    signIns: () => signIns,
    revoke: () => {
      active = false;
    },
  };
}

test('account bootstrap is public and reports no private data before authentication', async () => {
  const f = await fixture();
  try {
    const result = await f.app.inject('/api/session');
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.deepEqual(result.json(), {
      auth: { mode: 'google', googleAvailable: true },
      user: null,
      settings: null,
      capabilities: { developer: false },
    });
  } finally {
    await f.app.close();
  }
});

test('account settings bind to the session and reject stale account tabs and foreign origins', async () => {
  const f = await fixture();
  const url = '/api/account';
  const method = 'PATCH';
  try {
    assert.equal(
      (
        await f.app.inject({
          url,
          method,
          headers: {
            cookie: 'session=b',
            origin: 'http://localhost:4399',
            'x-otto-account': f.owners[0],
          },
          payload: { theme: 'dark' },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          url,
          method,
          headers: { cookie: 'session=a', origin: 'https://foreign.example' },
          payload: { theme: 'dark' },
        })
      ).statusCode,
      403,
    );
    assert.equal(f.accounts.size, 0);
    const saved = await f.app.inject({
      url,
      method,
      headers: {
        cookie: 'session=a',
        origin: 'http://localhost:4399',
        'x-otto-account': f.owners[0],
      },
      payload: { theme: 'dark', name: 'Alex Updated', onboardingCompleted: true },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().user.name, 'Alex Updated');
    assert.deepEqual(saved.json().settings, { theme: 'dark', onboardingCompleted: true });
    assert.equal(saved.json().capabilities.developer, true);
    const other = await f.app.inject({ url: '/api/session', headers: { cookie: 'session=b' } });
    assert.equal(other.json().settings.theme, 'system');
    assert.equal(other.json().capabilities.developer, false);
  } finally {
    await f.app.close();
  }
});

test('login fixes the provider destination and logout forwards cookie expiry', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/api/login', payload: {} })).statusCode,
      403,
    );
    const result = await f.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: 'http://localhost:4399' },
      payload: {},
    });
    assert.equal(result.statusCode, 200);
    assert.equal(f.signIns(), 1);
    assert.ok(String(result.headers['set-cookie']).includes('HttpOnly'));
    const logout = await f.app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: {
        origin: 'http://localhost:4399',
        cookie: 'session=a',
        'x-otto-account': f.owners[0],
      },
      payload: {},
    });
    assert.equal(logout.statusCode, 200);
    assert.deepEqual(logout.json(), { ok: true });
    assert.ok(String(logout.headers['set-cookie']).includes('Max-Age=0'));
  } finally {
    await f.app.close();
  }
});

test('avatars stay behind the cookie account and never expose the provider image URL', async () => {
  let reads = 0;
  const f = await fixture(async () => {
    reads++;
    return { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' };
  });
  try {
    const session = await f.app.inject({ url: '/api/session', headers: { cookie: 'session=a' } });
    const path = session.json().user.avatarUrl;
    assert.equal(path, `/api/account/avatar?account=${f.owners[0]}`);
    assert.doesNotMatch(session.body, /googleusercontent|synthetic-private-avatar/);
    assert.equal((await f.app.inject(path)).statusCode, 401);
    assert.equal(
      (await f.app.inject({ url: path, headers: { cookie: 'session=b' } })).statusCode,
      401,
    );
    assert.equal(
      (await f.app.inject({ url: '/api/account/avatar', headers: { cookie: 'session=a' } }))
        .statusCode,
      400,
    );
    assert.equal(reads, 0);
    const image = await f.app.inject({ url: path, headers: { cookie: 'session=a' } });
    assert.equal(image.statusCode, 200);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.equal(image.headers['x-content-type-options'], 'nosniff');
    assert.match(String(image.headers['cache-control']), /^private, max-age=60/);
    assert.deepEqual(image.rawPayload, Buffer.from([1, 2, 3]));
    assert.equal(reads, 1);
  } finally {
    await f.app.close();
  }
});

test('revocation during an avatar fetch discards the delayed image', async () => {
  let ready!: () => void;
  const requested = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let finish!: () => void;
  const f = await fixture(async () => {
    ready();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' };
  });
  try {
    const request = f.app.inject({
      url: `/api/account/avatar?account=${f.owners[0]}`,
      headers: { cookie: 'session=a' },
    });
    await requested;
    f.revoke();
    finish();
    const result = await request;
    assert.equal(result.statusCode, 401);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.notEqual(result.headers['content-type'], 'image/png');
  } finally {
    await f.app.close();
  }
});
