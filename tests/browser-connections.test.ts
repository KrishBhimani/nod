import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type { Computer, CredentialInput, LoginInspection } from '../src/ports/computer.ts';
import { createBrowserConnections } from '../src/server/browser-connections.ts';

async function fixture() {
  const schema = `browser_connections_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const cleanup: Array<() => Promise<unknown>> = [() => admin.end()];
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    cleanup.unshift(() => admin.query(`DROP SCHEMA ${schema} CASCADE`));
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    cleanup.unshift(() => pool.end());
    const app = Fastify();
    cleanup.unshift(() => app.close());
    const bindings: Array<{ threadId: string; profileId: string; origin?: string }> = [];
    const inputs: CredentialInput[] = [];
    const closed: string[] = [];
    const removed: string[] = [];
    const savedLogins: Array<{ origin: string; username: string; password: string }> = [];
    const state: {
      failDelete: boolean;
      signedIn: boolean;
      technogymLoginOpen: boolean;
      blocked: boolean;
      verificationRequired: boolean;
      verificationVisible: boolean;
      loginOrigin: string;
      pageUrl: string;
      waitForInjection?: Promise<void>;
      injectionEntered?: () => void;
    } = {
      failDelete: false,
      signedIn: false,
      technogymLoginOpen: false,
      blocked: false,
      verificationRequired: false,
      verificationVisible: false,
      loginOrigin: 'https://api.linkedin.com',
      pageUrl: 'https://www.linkedin.com/messaging/',
    };
    const computer = {
      async bindProfile(threadId: string, profileId: string, origin?: string) {
        bindings.push({ threadId, profileId, origin });
      },
      async deleteProfile(profileId: string) {
        if (state.failDelete) throw new Error('Synthetic profile removal failed.');
        removed.push(profileId);
      },
      async act(_threadId: string, input: { action: string; url?: string }) {
        if (input.action === 'click' && input.url === undefined) {
          state.technogymLoginOpen = true;
          state.pageUrl = 'https://www.technogym.com/login';
        } else state.pageUrl = input.url ?? state.pageUrl;
        return {
          url: state.pageUrl,
          text: state.blocked ? '403 ERROR Request blocked' : 'Synthetic page',
          candidates:
            state.pageUrl === 'https://www.technogym.com/en-IE/' && !state.technogymLoginOpen
              ? [{ id: '@login', label: 'Log in' }]
              : [],
        };
      },
      async inspectLogin(): Promise<LoginInspection> {
        const ready =
          !state.pageUrl.startsWith('https://www.technogym.com') || state.technogymLoginOpen;
        return {
          origin: state.loginOrigin,
          url: `${state.loginOrigin}/checkpoint/lg/login`,
          fields:
            state.signedIn || !ready
              ? []
              : state.verificationVisible
                ? [{ kind: 'otp', selector: '#code', label: 'Verification code' }]
                : [
                    { kind: 'identifier', selector: '#username', label: 'Email or phone' },
                    { kind: 'password', selector: '#password', label: 'Password' },
                  ],
          methods:
            state.signedIn || !ready
              ? []
              : [{ id: 'credentials', label: 'Email', kind: 'credentials', supported: true }],
          submitSelector: '#sign-in',
        };
      },
      async injectCredentials(input: CredentialInput) {
        inputs.push(input);
        state.injectionEntered?.();
        if (state.waitForInjection) await state.waitForInjection;
        if (input.kind === 'otp') {
          state.verificationRequired = false;
          state.verificationVisible = false;
          state.signedIn = true;
        } else if (state.verificationRequired) {
          state.verificationVisible = true;
          state.pageUrl = 'https://api.linkedin.com/checkpoint/challenge';
        } else state.signedIn = true;
        return { status: 'submitted' as const };
      },
      async hold() {},
      async close(threadId: string) {
        closed.push(threadId);
      },
      async openSignIn() {},
      async finishSignIn() {},
      async signInScreenshot() {
        return Buffer.from('synthetic-image');
      },
      async signInControl() {},
      async releaseControl() {},
    } as unknown as Computer;
    await pool.query(
      "CREATE TABLE threads (id uuid PRIMARY KEY,owner_id text,status text NOT NULL DEFAULT 'idle',archived_at timestamptz)",
    );
    await pool.query(
      'CREATE TABLE turns(id uuid PRIMARY KEY,thread_id uuid REFERENCES threads(id),owner_id text,status text,waiting_reason text)',
    );
    const service = await createBrowserConnections(pool, {
      ownerId: 'owner-a',
      computer,
      async saveLogin(origin, _label, username, password) {
        savedLogins.push({ origin, username, password });
        return randomUUID();
      },
    });
    service.registerRoutes(app);
    await app.ready();
    return {
      app,
      pool,
      service,
      computer,
      state,
      bindings,
      inputs,
      closed,
      removed,
      savedLogins,
      async close() {
        let failure: unknown;
        for (const dispose of cleanup)
          try {
            await dispose();
          } catch (error) {
            failure ??= error;
          }
        if (failure) throw failure;
      },
    };
  } catch (error) {
    for (const dispose of cleanup) await dispose().catch(() => {});
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function turnRef() {
  return { threadId: randomUUID(), turnId: randomUUID() };
}

function connectionTest(name: string, run: (value: Fixture) => Promise<void>) {
  test(name, { skip: !process.env.TEST_DATABASE_URL }, async () => {
    const value = await fixture();
    try {
      await run(value);
    } finally {
      await value.close();
    }
  });
}

async function saveLinkedIn(value: Fixture) {
  const started = await value.app.inject({
    method: 'POST',
    url: '/api/browser-connections',
    payload: { url: 'https://www.linkedin.com/messaging/' },
  });
  assert.equal(started.statusCode, 200);
  const { url, connectionId } = started.json<{ url: string; connectionId: string }>();
  const token = url.split('/').at(-1)!;
  const credentials = await value.app.inject({
    method: 'POST',
    url: `/api/browser-connections/attempt/${token}/credentials`,
    payload: {
      origin: 'https://api.linkedin.com',
      username: 'synthetic@example.test',
      password: 'synthetic-secret',
    },
  });
  assert.equal(credentials.statusCode, 200);
  const finish = await value.app.inject({
    method: 'POST',
    url: `/api/browser-connections/attempt/${token}/finish`,
    payload: {},
  });
  assert.equal(finish.statusCode, 200);
  return connectionId;
}

connectionTest('LinkedIn sign-in keeps credentials private through a later code', async (value) => {
  const { app, pool, service, state, bindings, inputs, savedLogins } = value;
  const begin = await app.inject({
    method: 'POST',
    url: '/api/browser-connections',
    payload: { url: 'https://www.linkedin.com/messaging/?private=1', label: 'My LinkedIn' },
  });
  assert.equal(begin.statusCode, 200);
  const { url, connectionId } = begin.json<{ url: string; connectionId: string }>();
  let token = url.split('/').at(-1)!;
  assert.ok(bindings[0].profileId);
  const stored = (
    await pool.query<{ token_hash: string; start_url: string }>(
      'SELECT token_hash,start_url FROM browser_connections WHERE id=$1',
      [connectionId],
    )
  ).rows[0];
  assert.notEqual(stored.token_hash, token);
  assert.equal(stored.start_url, 'https://www.linkedin.com/messaging/?private=1');
  const attempt = await app.inject({
    method: 'GET',
    url: `/api/browser-connections/attempt/${token}`,
  });
  assert.equal(attempt.json().inspection.origin, 'https://api.linkedin.com');
  assert.equal(attempt.json().inspection.canSubmit, true);
  const renewed = await app.inject({
    method: 'POST',
    url: '/api/browser-connections',
    payload: { url: 'https://www.linkedin.com/messaging/', connectionId },
  });
  assert.equal(renewed.statusCode, 200);
  const oldToken = token;
  token = renewed.json<{ url: string }>().url.split('/').at(-1)!;
  assert.notEqual(token, oldToken);
  assert.equal(
    (await app.inject({ method: 'GET', url: `/api/browser-connections/attempt/${oldToken}` }))
      .statusCode,
    404,
  );
  assert.equal((await service.list())[0].accountName, 'My LinkedIn');
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/browser-connections/attempt/${token}/finish`,
        payload: {},
      })
    ).statusCode,
    409,
  );
  state.verificationRequired = true;
  const credentials = await app.inject({
    method: 'POST',
    url: `/api/browser-connections/attempt/${token}/credentials`,
    payload: {
      origin: 'https://api.linkedin.com',
      username: 'synthetic@example.test',
      password: 'synthetic-secret',
      saveLogin: true,
    },
  });
  assert.equal(credentials.statusCode, 200);
  assert.equal(credentials.json().inspection.fields[0].kind, 'otp');
  assert.doesNotMatch(credentials.body, /synthetic-secret|synthetic@example.test/);
  assert.equal(inputs[0].passwordSelector, '#password');
  assert.deepEqual(savedLogins, []);
  const verification = await app.inject({
    method: 'POST',
    url: `/api/browser-connections/attempt/${token}/finish`,
    payload: {},
  });
  assert.equal(verification.statusCode, 409);
  assert.match(verification.json().error, /verification code/);
  assert.equal(state.pageUrl, 'https://api.linkedin.com/checkpoint/challenge');
  assert.deepEqual(savedLogins, []);
  const code = await app.inject({
    method: 'POST',
    url: `/api/browser-connections/attempt/${token}/credentials`,
    payload: { origin: 'https://api.linkedin.com', code: '123456' },
  });
  assert.equal(code.statusCode, 200);
  assert.equal(inputs.at(-1)?.kind, 'otp');
  const finish = await app.inject({
    method: 'POST',
    url: `/api/browser-connections/attempt/${token}/finish`,
    payload: {},
  });
  assert.equal(finish.statusCode, 200);
  assert.equal(finish.json().loginSaved, true);
  assert.deepEqual(savedLogins, [
    {
      origin: 'https://api.linkedin.com',
      username: 'synthetic@example.test',
      password: 'synthetic-secret',
    },
  ]);
  assert.equal(bindings.at(-1)?.origin, 'https://www.linkedin.com');
  assert.equal(bindings.at(-1)?.profileId, bindings[0].profileId);
  const replay = await app.inject({
    method: 'GET',
    url: `/api/browser-connections/attempt/${token}`,
  });
  assert.equal(replay.json().state, 'saved');
});

connectionTest(
  'saved profile reuse checks one owner and keeps removal retryable',
  async (value) => {
    const { pool, service, computer, state, bindings, closed, removed } = value;
    const connectionId = await saveLinkedIn(value);
    const other = await createBrowserConnections(pool, { ownerId: 'owner-b', computer });
    await assert.rejects(
      other.use(connectionId, turnRef(), 'https://www.linkedin.com/'),
      /unavailable/,
    );
    const rejected = await other.request(
      { action: 'use', connectionId, url: 'https://www.linkedin.com/' },
      turnRef(),
    );
    assert.ok('status' in rejected);
    assert.equal(rejected.status, 'rejected');
    const before = (
      await pool.query('SELECT * FROM browser_connections WHERE id=$1', [connectionId])
    ).rows[0];
    const bindingCount = bindings.length;
    const closeCount = closed.length;
    for (const action of ['connect', 'use'] as const) {
      for (const url of [
        'https://www.technogym.com/en-IE/',
        'https://api.linkedin.com/jobs/',
        'https://www.linkedin.com:8443/jobs/',
      ]) {
        const mismatch = await service.request({ action, connectionId, url }, turnRef());
        assert.ok('code' in mismatch);
        assert.equal(mismatch.status, 'rejected');
        assert.equal(mismatch.code, 'browser_connection_origin_mismatch');
      }
    }
    assert.equal(bindings.length, bindingCount);
    assert.equal(closed.length, closeCount);
    assert.deepEqual(
      (await pool.query('SELECT * FROM browser_connections WHERE id=$1', [connectionId])).rows[0],
      before,
    );
    await pool.query("UPDATE browser_connections SET checked_at='2000-01-01' WHERE id=$1", [
      connectionId,
    ]);
    const nextTurn = turnRef();
    const used = await service.request(
      { action: 'use', connectionId, url: 'https://www.linkedin.com/jobs/' },
      nextTurn,
    );
    assert.ok('status' in used);
    assert.equal(used.status, 'session_opened');
    assert.ok(new Date((await service.list())[0].checkedAt!).getTime() > Date.UTC(2020, 0, 1));
    assert.equal(bindings.at(-1)?.profileId, bindings[0].profileId);
    assert.equal(bindings.at(-1)?.origin, 'https://www.linkedin.com');
    assert.equal(bindings.at(-1)?.threadId, nextTurn.threadId);
    assert.equal(
      (await pool.query('SELECT thread_id FROM browser_connections WHERE id=$1', [connectionId]))
        .rows[0].thread_id,
      nextTurn.threadId,
    );
    state.blocked = true;
    const denied = await service.use(connectionId, nextTurn, 'https://www.linkedin.com/messaging/');
    assert.equal(denied.status, 'site_blocked');
    state.blocked = false;
    await assert.rejects(
      service.use(connectionId, turnRef(), 'https://www.technogym.com/en-IE/'),
      /another website/,
    );
    state.failDelete = true;
    await assert.rejects(service.disconnect(connectionId), /could not be removed/);
    assert.equal((await service.list())[0].browserState, 'disconnecting');
    state.failDelete = false;
    await service.disconnect(connectionId);
    assert.deepEqual(removed, [bindings[0].profileId]);
    assert.equal(closed.at(-1), nextTurn.threadId);
  },
);

connectionTest(
  'model connect can renew a pending session created outside a chat turn',
  async (value) => {
    const { service, pool, bindings } = value;
    const pending = await service.begin({ url: 'https://www.linkedin.com/' });
    const before = (
      await pool.query('SELECT * FROM browser_connections WHERE id=$1', [pending.connectionId])
    ).rows[0];
    assert.equal(before.state, 'pending');
    assert.equal(before.thread_id, null);
    assert.equal(before.turn_id, null);
    const turn = turnRef();
    await pool.query("INSERT INTO threads(id,owner_id,status) VALUES($1,'owner-a','running')", [
      turn.threadId,
    ]);
    await pool.query(
      "INSERT INTO turns(id,thread_id,owner_id,status) VALUES($1,$2,'owner-a','running')",
      [turn.turnId, turn.threadId],
    );
    const result = await service.request(
      { action: 'connect', connectionId: pending.connectionId, url: 'https://www.linkedin.com/' },
      turn,
    );
    assert.ok('url' in result);
    assert.notEqual(result.url, pending.url);
    assert.equal(result.connectionId, pending.connectionId);
    assert.equal(bindings.at(-1)?.threadId, turn.threadId);
    assert.equal(bindings.at(-1)?.profileId, before.profile_id);
    const after = (
      await pool.query('SELECT * FROM browser_connections WHERE id=$1', [pending.connectionId])
    ).rows[0];
    assert.equal(after.state, 'pending');
    assert.equal(after.thread_id, turn.threadId);
    assert.equal(after.turn_id, turn.turnId);
  },
);

connectionTest('site blocks and login ports keep separate connection states', async (value) => {
  const { app, service, state, bindings, removed } = value;
  state.loginOrigin = 'https://www.technogym.com';
  const begin = await app.inject({
    method: 'POST',
    url: '/api/browser-connections',
    payload: { url: 'https://www.technogym.com/en-IE/' },
  });
  assert.equal(begin.statusCode, 200);
  const firstProfile = bindings[0].profileId;
  const token = begin.json<{ url: string }>().url.split('/').at(-1)!;
  const attempt = await app.inject({
    method: 'GET',
    url: `/api/browser-connections/attempt/${token}`,
  });
  assert.equal(attempt.json().inspection.canSubmit, true);
  assert.equal(attempt.json().inspection.fields.length, 2);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/browser-connections/attempt/${token}/finish`,
        payload: {},
      })
    ).statusCode,
    409,
  );
  state.blocked = true;
  const blockedBegin = await app.inject({
    method: 'POST',
    url: '/api/browser-connections',
    payload: { url: 'https://blocked.example.com/' },
  });
  assert.equal(blockedBegin.statusCode, 409);
  const blockedConnection = (await service.list()).find(
    (item) => item.browserUrl === 'https://blocked.example.com/',
  );
  assert.equal(blockedConnection?.browserState, 'needs_sign_in');
  assert.equal(blockedConnection?.status, 'disconnected');
  assert.ok(blockedConnection?.connectionId);
  const blockedProfile = bindings.at(-1)!.profileId;
  await service.disconnect(blockedConnection.connectionId);
  assert.ok(removed.includes(blockedProfile));
  state.blocked = false;
  state.loginOrigin = 'https://api.example.test:9443';
  const portBegin = await app.inject({
    method: 'POST',
    url: '/api/browser-connections',
    payload: { url: 'https://www.example.test:8443/account' },
  });
  assert.equal(portBegin.statusCode, 200);
  assert.notEqual(bindings.at(-1)?.profileId, firstProfile);
  const portConnection = portBegin.json<{ url: string; connectionId: string }>();
  const portToken = portConnection.url.split('/').at(-1)!;
  const portAttempt = await app.inject({
    method: 'GET',
    url: `/api/browser-connections/attempt/${portToken}`,
  });
  assert.equal(portAttempt.json().inspection.canSubmit, false);
  const portSubmit = await app.inject({
    method: 'POST',
    url: `/api/browser-connections/attempt/${portToken}/credentials`,
    payload: { origin: state.loginOrigin, username: 'synthetic@example.test' },
  });
  assert.equal(portSubmit.statusCode, 409);
  await service.disconnect(portConnection.connectionId);
});

connectionTest(
  'an expired session gives its turn a new link and rejects credentials after reset',
  async (value) => {
    const { app, pool, service, state, inputs } = value;
    const connectionId = await saveLinkedIn(value);
    const turn = turnRef();
    await pool.query('INSERT INTO threads(id,owner_id,status) VALUES($1,$2,$3)', [
      turn.threadId,
      'owner-a',
      'running',
    ]);
    await pool.query(
      "INSERT INTO turns(id,thread_id,owner_id,status,waiting_reason) VALUES($1,$2,'owner-a','waiting','browser')",
      [turn.turnId, turn.threadId],
    );
    state.signedIn = false;
    const reconnect = await service.use(connectionId, turn, 'https://www.linkedin.com/jobs/');
    assert.equal(reconnect.status, 'needs_sign_in');
    assert.match(reconnect.url, /^\/browser-connect\/[A-Za-z0-9_-]{43}$/);
    const token = reconnect.url.split('/').at(-1)!;
    const description = await app.inject({
      method: 'GET',
      url: `/api/browser-connections/attempt/${token}`,
    });
    assert.equal(description.json().fromChat, true);
    await pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [turn.threadId]);
    const stale = await app.inject({
      method: 'POST',
      url: `/api/browser-connections/attempt/${token}/credentials`,
      payload: {
        origin: 'https://api.linkedin.com',
        username: 'synthetic@example.test',
        password: 'synthetic-secret',
      },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(inputs.length, 1);
  },
);

connectionTest('credential entry holds the thread through injection', async (value) => {
  const { app, pool, service, state } = value;
  state.loginOrigin = 'https://www.linkedin.com';
  const turn = turnRef();
  await pool.query('INSERT INTO threads(id,owner_id,status) VALUES($1,$2,$3)', [
    turn.threadId,
    'owner-a',
    'running',
  ]);
  const started = await service.begin({ url: 'https://www.linkedin.com/messaging/' }, turn);
  await pool.query(
    "INSERT INTO turns(id,thread_id,owner_id,status,waiting_reason) VALUES($1,$2,'owner-a','waiting','browser')",
    [turn.turnId, turn.threadId],
  );
  await pool.query("UPDATE threads SET status='idle' WHERE id=$1", [turn.threadId]);
  const renewed = await app.inject({
    method: 'POST',
    url: '/api/browser-connections',
    payload: { url: 'https://www.linkedin.com/messaging/', connectionId: started.connectionId },
  });
  assert.equal(renewed.statusCode, 200);
  const token = renewed.json<{ url: string }>().url.split('/').at(-1)!;
  const description = await app.inject({
    method: 'GET',
    url: `/api/browser-connections/attempt/${token}`,
  });
  assert.equal(description.json().fromChat, true);
  let releaseInjection!: () => void;
  state.waitForInjection = new Promise<void>((resolve) => {
    releaseInjection = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    state.injectionEntered = resolve;
  });
  const submit = app.inject({
    method: 'POST',
    url: `/api/browser-connections/attempt/${token}/credentials`,
    payload: {
      origin: 'https://www.linkedin.com',
      username: 'synthetic@example.test',
      password: 'synthetic-secret',
    },
  });
  await entered;
  const cancellation = pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [
    turn.threadId,
  ]);
  const probe = await pool.connect();
  try {
    await assert.rejects(
      probe.query('SELECT id FROM turns WHERE id=$1 FOR UPDATE NOWAIT', [turn.turnId]),
      { code: '55P03' },
    );
    await assert.rejects(
      probe.query('SELECT id FROM threads WHERE id=$1 FOR UPDATE NOWAIT', [turn.threadId]),
      {
        code: '55P03',
      },
    );
  } finally {
    probe.release();
    releaseInjection();
  }
  assert.equal((await submit).statusCode, 200);
  await cancellation;
  state.waitForInjection = undefined;
  state.injectionEntered = undefined;
  const stale = await app.inject({
    method: 'POST',
    url: `/api/browser-connections/attempt/${token}/credentials`,
    payload: {
      origin: 'https://www.linkedin.com',
      username: 'synthetic@example.test',
      password: 'synthetic-secret',
    },
  });
  assert.equal(stale.statusCode, 409);
});

connectionTest(
  'website links reject non-waiting turns and disconnect retains nonterminal work',
  async (value) => {
    const { pool, app, service, state, inputs, removed } = value;
    const turn = turnRef();
    await pool.query("INSERT INTO threads(id,owner_id,status) VALUES($1,'owner-a','idle')", [
      turn.threadId,
    ]);
    await pool.query(
      "INSERT INTO turns(id,thread_id,owner_id,status,waiting_reason) VALUES($1,$2,'owner-a','waiting','browser')",
      [turn.turnId, turn.threadId],
    );
    const started = await service.begin({ url: 'https://www.linkedin.com/messaging/' }, turn);
    const token = started.url.split('/').at(-1)!;
    const route = `/api/browser-connections/attempt/${token}`;
    for (const status of ['queued', 'running', 'waiting']) {
      await pool.query('UPDATE turns SET status=$2 WHERE id=$1', [turn.turnId, status]);
      await assert.rejects(service.disconnect(started.connectionId), /Stop the active work/);
      assert.equal(removed.length, 0);
    }
    for (const [status, reason] of [
      ['failed', 'browser'],
      ['cancelled', 'browser'],
      ['succeeded', null],
      ['waiting', 'question'],
    ]) {
      await pool.query('UPDATE turns SET status=$2,waiting_reason=$3 WHERE id=$1', [
        turn.turnId,
        status,
        reason,
      ]);
      assert.equal((await app.inject({ url: route })).statusCode, 409);
      for (const endpoint of ['credentials', 'control/start', 'finish']) {
        const response = await app.inject({
          method: 'POST',
          url: `${route}/${endpoint}`,
          payload:
            endpoint === 'credentials'
              ? {
                  origin: state.loginOrigin,
                  username: 'synthetic@example.test',
                  password: 'synthetic-secret',
                }
              : {},
        });
        assert.equal(response.statusCode, 409, `${status}/${endpoint}: ${response.body}`);
      }
      assert.equal(inputs.length, 0);
    }
    await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [turn.turnId]);
    await service.disconnect(started.connectionId);
    assert.equal(removed.length, 1);
  },
);

connectionTest(
  'website native input rechecks a queued attempt and commits under its owning wait',
  async (value) => {
    const { pool, app, service } = value;
    const turn = turnRef();
    await pool.query("INSERT INTO threads(id,owner_id,status) VALUES($1,'owner-a','idle')", [
      turn.threadId,
    ]);
    await pool.query(
      "INSERT INTO turns(id,thread_id,owner_id,status,waiting_reason) VALUES($1,$2,'owner-a','waiting','browser')",
      [turn.turnId, turn.threadId],
    );
    const started = await service.begin({ url: 'https://www.linkedin.com/messaging/' }, turn);
    const route = `/api/browser-connections/attempt/${started.url.split('/').at(-1)!}`;
    assert.equal(
      (await app.inject({ method: 'POST', url: `${route}/control/start`, payload: {} })).statusCode,
      200,
    );
    const input = await app.inject({
      method: 'POST',
      url: `${route}/control/input`,
      payload: { input: { action: 'type', text: 'Synthetic input' } },
    });
    assert.equal(input.statusCode, 200, input.body);
    assert.equal(
      (
        await pool.query('SELECT sign_in_started FROM browser_connections WHERE id=$1', [
          started.connectionId,
        ])
      ).rows[0].sign_in_started,
      true,
    );
    await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [turn.turnId]);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${route}/control/input`,
          payload: { input: { action: 'type', text: 'Stale input' } },
        })
      ).statusCode,
      409,
    );
  },
);

connectionTest(
  'a later running turn can replace an obsolete pending website sign-in link',
  async (value) => {
    const { pool, app, service } = value;
    const old = turnRef();
    await pool.query("INSERT INTO threads(id,owner_id,status) VALUES($1,'owner-a','idle')", [
      old.threadId,
    ]);
    await pool.query(
      "INSERT INTO turns(id,thread_id,owner_id,status,waiting_reason) VALUES($1,$2,'owner-a','waiting','browser')",
      [old.turnId, old.threadId],
    );
    const initial = await service.begin({ url: 'https://www.linkedin.com/messaging/' }, old);
    await pool.query("UPDATE turns SET status='cancelled',waiting_reason=NULL WHERE id=$1", [
      old.turnId,
    ]);
    const next = { threadId: old.threadId, turnId: randomUUID() };
    await pool.query(
      "INSERT INTO turns(id,thread_id,owner_id,status) VALUES($1,$2,'owner-a','running')",
      [next.turnId, next.threadId],
    );
    const renewed = await service.begin(
      { url: 'https://www.linkedin.com/messaging/', connectionId: initial.connectionId },
      next,
    );
    assert.notEqual(renewed.url, initial.url);
    const previous = await app.inject({
      url: `/api/browser-connections/attempt/${initial.url.split('/').at(-1)!}`,
    });
    assert.equal(previous.statusCode, 404);
    await pool.query("UPDATE turns SET status='waiting',waiting_reason='browser' WHERE id=$1", [
      next.turnId,
    ]);
    assert.equal(
      (
        await app.inject({
          url: `/api/browser-connections/attempt/${renewed.url.split('/').at(-1)!}`,
        })
      ).statusCode,
      200,
    );
  },
);
