import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import { JSDOM } from 'jsdom';
import pg, { type Pool } from 'pg';
import type {
  Agent,
  AgentToolResult,
  RuntimeContext,
  RuntimeObservation,
} from '../src/ports/agent.ts';
import {
  credentialFeedback,
  credentialFeedbackScript,
  credentialFields,
  credentialScript,
} from '../src/providers/agent-browser/credentials.ts';
import { credentialSubmitScript } from '../src/providers/agent-browser/login.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import {
  BrowserConnectionError,
  createBrowserConnections,
} from '../src/server/browser-connections.ts';
import type { TurnRef } from '../src/server/thread.ts';
import { createVault, openCredential } from '../src/server/vault.ts';
import { createBrowserFixture as createAgentBrowserComputer } from './browser-fixture.ts';
import { LoginPage, stagedLoginBrowser } from './login-fixture.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

test(
  'secure forms follow staged fields, preserve the waiting page and bind method selection to the task',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const schema = `test_staged_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const directory = await mkdtemp(join(tmpdir(), 'otto-secure-stages-'));
    const fixture = stagedLoginBrowser();
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      run: fixture.run,
      idleTimeoutMs: 25,
    });
    const app = Fastify();
    const key = randomBytes(32);
    let resumed = 0;
    await pool.query(
      'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
    );
    await pool.query(
      "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,started_at timestamptz,finished_at timestamptz)",
    );
    const turns: Record<string, TurnRef> = {};
    const threads: Record<string, string> = {};
    for (const name of ['staged', 'oauth', 'autofill', 'changed', 'split-code']) {
      const turn = { threadId: randomUUID(), turnId: randomUUID() };
      await pool.query("INSERT INTO threads(id,owner_id) VALUES($1,'local-development')", [
        turn.threadId,
      ]);
      await pool.query(
        "INSERT INTO turns(id,owner_id,thread_id) VALUES($1,'local-development',$2)",
        [turn.turnId, turn.threadId],
      );
      turns[name] = turn;
      threads[name] = turn.threadId;
    }
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      inspect: computer.inspectLogin,
      hold: computer.hold,
      inject: computer.injectCredentials,
      selectMethod: computer.selectLoginMethod,
      retry: async () => {},
      resume: async (turnId) => {
        resumed += 1;
        const name = Object.keys(turns).find((key) => turns[key].turnId === turnId)!;
        const next = { threadId: turns[name].threadId, turnId: randomUUID() };
        await pool.query(
          "INSERT INTO turns(id,owner_id,thread_id,source,source_id,started_at) VALUES($1,'local-development',$2,'resume',$3,clock_timestamp())",
          [next.turnId, next.threadId, `credentials:${turnId}`],
        );
        turns[name] = next;
      },
    });
    vault.registerRoutes(app);
    const secureRequest = async (name: string, origin = 'https://1.1.1.1') => {
      const request = await vault.request(turns[name], 'local-development', {
        origin,
        label: 'Synthetic login',
        kind: 'password',
        usernameSelector: '#stale-user',
        passwordSelector: '#missing-password',
        submitSelector: '#old-button',
      });
      await pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials',started_at=coalesce(started_at,clock_timestamp()),finished_at=clock_timestamp() WHERE id=$1",
        [turns[name].turnId],
      );
      return request.url.replace('/vault/', '/api/credential-requests/');
    };
    try {
      await computer.act(threads.staged, { action: 'open', url: 'https://1.1.1.1/login' });
      const first = await secureRequest('staged');
      const form = (await app.inject({ url: first })).json();
      assert.equal(form.kind, 'identifier');
      assert.deepEqual(
        form.fields.map((field: { kind: string }) => field.kind),
        ['identifier'],
      );
      assert.equal(
        form.methods.find((method: { kind: string }) => method.kind === 'oauth').supported,
        true,
      );
      assert.equal(JSON.stringify(form).includes('data-otto-login-method'), false);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: first,
            payload: { label: 'Fixture login', password: 'unused-secret' },
          })
        ).statusCode,
        400,
      );
      await pool.query(
        'UPDATE credential_requests SET inspection=jsonb_set(inspection,\'{methods}\', \'[{"id":"credentials","label":"Unsupported old scan","kind":"credentials","supported":false}]\'::jsonb) WHERE turn_id=$1',
        [turns.staged.turnId],
      );
      const refreshed = await app.inject({ method: 'POST', url: first + '/refresh' });
      assert.equal(refreshed.statusCode, 200);
      assert.equal(
        refreshed.json().methods.find((method: { id: string }) => method.id === 'credentials')
          .supported,
        true,
      );
      assert.ok(await computer.screenshot(threads.staged));
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: first,
            payload: {
              label: 'Fixture login',
              username: 'synthetic-account@example.test',
              password: 'synthetic-password',
            },
          })
        ).statusCode,
        200,
      );
      assert.equal((await pool.query('SELECT * FROM vault_entries')).rowCount, 0);
      assert.equal((await app.inject({ method: 'POST', url: first + '/refresh' })).statusCode, 409);
      assert.equal(
        await vault.fillSelected(turns.staged, 'local-development', {
          origin: 'https://1.1.1.1',
          label: 'Synthetic login',
          kind: 'password',
        }),
        true,
      );
      assert.equal((await pool.query('SELECT * FROM credential_requests')).rowCount, 1);
      const third = await secureRequest('staged');
      assert.equal((await app.inject({ url: third })).json().kind, 'otp');
      assert.equal(
        (await app.inject({ method: 'POST', url: third, payload: { code: '739204' } })).statusCode,
        200,
      );
      assert.equal(fixture.pages.get(threads.staged)?.stage, 'complete');
      assert.equal(resumed, 2);
      const entries = (await pool.query('SELECT * FROM vault_entries')).rows;
      assert.equal(entries.length, 1);
      assert.deepEqual(openCredential(key, entries[0]), {
        username: 'synthetic-account@example.test',
        password: 'synthetic-password',
      });
      const persisted = JSON.stringify([
        entries,
        (await pool.query('SELECT * FROM credential_requests')).rows,
      ]);
      for (const secret of ['synthetic-account@example.test', 'synthetic-password', '739204'])
        assert.equal(persisted.includes(secret), false);
      assert.equal(
        (await app.inject({ method: 'POST', url: first, payload: { username: 'must-not-repeat' } }))
          .statusCode,
        409,
      );
      await computer.close(threads.staged);

      await computer.act(threads.autofill, { action: 'open', url: 'https://1.1.1.1/login' });
      await computer.hold(threads.autofill, Date.now() + 2000);
      await vault.fillSaved(turns.autofill, 'local-development', entries[0].id, {
        origin: 'https://1.1.1.1',
        label: 'Synthetic',
        kind: 'identifier',
      });
      assert.equal(fixture.pages.get(threads.autofill)?.stage, 'password');
      await vault.fillSaved(turns.autofill, 'local-development', entries[0].id, {
        origin: 'https://1.1.1.1',
        label: 'Synthetic',
        kind: 'password',
      });
      assert.equal(fixture.pages.get(threads.autofill)?.stage, 'otp');
      await assert.rejects(
        vault.fillSaved(turns.autofill, 'local-development', entries[0].id, {
          origin: 'https://1.1.1.1',
          label: 'Synthetic',
          kind: 'otp',
        }),
      );
      await computer.close(threads.autofill);

      await computer.act(threads.oauth, { action: 'open', url: 'https://1.1.1.1/login' });
      fixture.pages.get(threads.oauth)!.stage = 'complete';
      fixture.pages.get(threads.oauth)!.render();
      const oauthUrl = await secureRequest('oauth');
      const oauthForm = (await app.inject({ url: oauthUrl })).json();
      assert.deepEqual(oauthForm.fields, []);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${oauthUrl}/method`,
            payload: { methodId: 'manual' },
          })
        ).statusCode,
        409,
      );
      const method = oauthForm.methods.find((item: { kind: string }) => item.kind === 'oauth');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${oauthUrl}/method`,
            payload: { methodId: method.id },
          })
        ).statusCode,
        200,
      );
      assert.equal((await computer.inspectLogin(threads.oauth)).origin, 'https://2.2.2.2');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${oauthUrl}/method`,
            payload: { methodId: method.id },
          })
        ).statusCode,
        409,
      );
      await assert.rejects(secureRequest('oauth'), /origin changed/);
      await computer.close(threads.oauth);

      await computer.act(threads.changed, { action: 'open', url: 'https://1.1.1.1/login' });
      const changed = await secureRequest('changed');
      const page = fixture.pages.get(threads.changed)!;
      page.stage = 'password';
      page.render();
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: changed,
            payload: { username: 'stale-identifier' },
          })
        ).statusCode,
        409,
      );
      assert.deepEqual(page.entered, []);
      await pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [threads.changed]);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${changed}/method`,
            payload: { methodId: 'oauth-google-0' },
          })
        ).statusCode,
        409,
      );
      assert.equal(page.location.origin, 'https://1.1.1.1');
      await computer.close(threads.changed);

      await computer.act(threads['split-code'], { action: 'open', url: 'https://1.1.1.1/login' });
      const split = fixture.pages.get(threads['split-code'])!;
      split.stage = 'otp';
      split.render();
      const extra = new LoginPage();
      extra.stage = 'otp';
      extra.render();
      const originalNodes = split.nodes.bind(split);
      split.nodes = (selector) =>
        selector === 'input' ? [split.input, extra.input] : originalNodes(selector);
      const splitRequest = await secureRequest('split-code');
      const splitForm = (await app.inject({ url: splitRequest })).json();
      assert.equal(
        splitForm.methods.find((method: { id: string }) => method.id === 'credentials').supported,
        false,
      );
      assert.equal(
        splitForm.methods.find((method: { id: string }) =>
          method.id.startsWith('verification-email'),
        ).supported,
        true,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: splitRequest, payload: { code: '987123' } }))
          .statusCode,
        409,
      );
      assert.deepEqual(split.entered, []);
    } finally {
      await app.close();
      await computer.dispose();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'website-rejected passwords and OTPs return fresh one-use forms without resuming or saving rejected details',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const schema = `test_rejected_login_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const directory = await mkdtemp(join(tmpdir(), 'otto-rejected-login-'));
    const fixture = stagedLoginBrowser();
    const computer = createAgentBrowserComputer({ dataRoot: directory, run: fixture.run });
    const app = Fastify();
    const key = randomBytes(32);
    const resumed: string[] = [];
    await pool.query(
      'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
    );
    await pool.query(
      "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,started_at timestamptz,finished_at timestamptz)",
    );
    const turns: Record<string, TurnRef> = {};
    const threads: Record<string, string> = {};
    for (const name of ['corrected', 'other', 'saved-identifier']) {
      const turn = { threadId: randomUUID(), turnId: randomUUID() };
      await pool.query("INSERT INTO threads(id,owner_id) VALUES($1,'local-development')", [
        turn.threadId,
      ]);
      await pool.query(
        "INSERT INTO turns(id,owner_id,thread_id) VALUES($1,'local-development',$2)",
        [turn.turnId, turn.threadId],
      );
      turns[name] = turn;
      threads[name] = turn.threadId;
    }
    const correctedTurns = async () =>
      (
        await pool.query('SELECT id,status FROM turns WHERE thread_id=$1', [threads.corrected])
      ).rows.map((row) => (row.id === turns.corrected.turnId ? row.status : 'earlier'));
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      inspect: computer.inspectLogin,
      hold: computer.hold,
      inject: computer.injectCredentials,
      retry: async () => {},
      resume: async (turnId) => {
        const name = Object.keys(turns).find((key) => turns[key].turnId === turnId)!;
        resumed.push(name);
        const next = { threadId: turns[name].threadId, turnId: randomUUID() };
        await pool.query(
          "INSERT INTO turns(id,owner_id,thread_id,source,source_id,started_at) VALUES($1,'local-development',$2,'resume',$3,clock_timestamp())",
          [next.turnId, next.threadId, `credentials:${turnId}`],
        );
        turns[name] = next;
      },
    });
    vault.registerRoutes(app);
    const input = {
      origin: 'https://1.1.1.1',
      label: 'Fixture website',
      kind: 'password' as const,
    };
    const request = async (name: string) => {
      const result = await vault.request(turns[name], 'local-development', input);
      await pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials',started_at=coalesce(started_at,clock_timestamp()),finished_at=clock_timestamp() WHERE id=$1",
        [turns[name].turnId],
      );
      return result.url.replace('/vault/', '/api/credential-requests/');
    };
    const submit = (url: string, payload: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url,
        payload: { ...('password' in payload ? { label: 'Fixture login' } : {}), ...payload },
      });
    try {
      await computer.act(threads.corrected, { action: 'open', url: 'https://1.1.1.1/login' });
      const page = fixture.pages.get(threads.corrected)!;
      const render = page.render.bind(page);
      page.render = () => {
        render();
        const accept = page.next.onClick;
        page.next.onClick = () => {
          if (
            (page.stage === 'password' && page.input.value === 'fixture-wrong-password') ||
            (page.stage === 'otp' && page.input.value === '000000')
          ) {
            page.entered.push(page.input.value);
            const rejectedValue = page.input.value;
            setTimeout(() => {
              page.echo.setAttribute('role', 'alert');
              page.echo.innerText = `The password or code was incorrect: ${rejectedValue}`;
              page.render();
            }, 40);
          } else accept();
        };
      };
      page.render();
      await computer.act(threads.other, { action: 'open', url: 'https://1.1.1.1/login' });
      const otherRequest = await request('other');
      const identifier = await request('corrected');
      assert.equal(
        (await submit(identifier, { username: 'fixture-owner@example.test' })).statusCode,
        200,
      );
      const rejectedPassword = await request('corrected');
      const passwordExpiry = (await app.inject({ url: rejectedPassword })).json().expiresAt;
      const rejectedPasswordResponse = await submit(rejectedPassword, {
        password: 'fixture-wrong-password',
      });
      assert.equal(rejectedPasswordResponse.statusCode, 200);
      assert.equal(rejectedPasswordResponse.json().ok, false);
      assert.match(rejectedPasswordResponse.json().error, /not accepted/);
      assert.equal(page.stage, 'password');
      const rejectedObservation = await computer.act(threads.corrected, { action: 'snapshot' });
      assert.equal(rejectedObservation.text.includes('fixture-wrong-password'), false);
      assert.equal((await app.inject({ url: rejectedPassword })).json().status, 'filled');
      const correctedPassword = rejectedPasswordResponse
        .json()
        .retryUrl.replace('/vault/', '/api/credential-requests/');
      assert.notEqual(correctedPassword, rejectedPassword);
      const freshPassword = (await app.inject({ url: correctedPassword })).json();
      assert.equal(freshPassword.status, 'pending');
      assert.equal(freshPassword.expiresAt, passwordExpiry);
      assert.equal((await pool.query('SELECT * FROM vault_entries')).rowCount, 0);
      assert.deepEqual(resumed, ['corrected']);
      assert.deepEqual((await correctedTurns()).sort(), ['earlier', 'waiting']);
      assert.equal(
        (await submit(rejectedPassword, { password: 'must-not-repeat' })).statusCode,
        409,
      );
      assert.equal(
        (await submit(correctedPassword, { password: 'fixture-correct-password' })).statusCode,
        200,
      );
      assert.equal(page.stage, 'otp');
      const entries = (await pool.query('SELECT * FROM vault_entries ORDER BY updated_at')).rows;
      assert.equal(entries.length, 1);
      assert.deepEqual(openCredential(key, entries.at(-1)), {
        username: 'fixture-owner@example.test',
        password: 'fixture-correct-password',
      });
      const rejectedOtp = await request('corrected');
      const otpExpiry = (await app.inject({ url: rejectedOtp })).json().expiresAt;
      const rejectedOtpResponse = await submit(rejectedOtp, { code: '000000' });
      assert.equal(rejectedOtpResponse.statusCode, 200);
      assert.equal(rejectedOtpResponse.json().ok, false);
      assert.equal(page.stage, 'otp');
      const correctedOtp = rejectedOtpResponse
        .json()
        .retryUrl.replace('/vault/', '/api/credential-requests/');
      assert.equal((await app.inject({ url: correctedOtp })).json().expiresAt, otpExpiry);
      assert.deepEqual(resumed, ['corrected', 'corrected']);
      assert.equal((await submit(rejectedOtp, { code: 'must-not-repeat' })).statusCode, 409);
      assert.equal((await submit(correctedOtp, { code: '739204' })).statusCode, 200);
      assert.equal(page.stage, 'complete');
      assert.deepEqual(resumed, Array(3).fill('corrected'));
      const nodes = page.nodes.bind(page);
      page.nodes = (selector) =>
        page.stage === 'complete'
          ? nodes(selector).filter((element) => element === page.echo)
          : nodes(selector);
      const completedInspection = await computer.inspectLogin(threads.corrected);
      assert.deepEqual(completedInspection.fields, []);
      assert.deepEqual(completedInspection.methods, []);
      const formsBeforeStaleRequest = (
        await pool.query('SELECT count(*)::int AS count FROM credential_requests')
      ).rows[0].count;
      await assert.rejects(
        vault.request(turns.corrected, 'local-development', { ...input, kind: 'otp' }),
        /no sign-in step/i,
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS count FROM credential_requests')).rows[0].count,
        formsBeforeStaleRequest,
      );
      assert.deepEqual((await correctedTurns()).sort(), [
        'earlier',
        'earlier',
        'earlier',
        'running',
      ]);
      assert.equal((await app.inject({ url: otherRequest })).json().status, 'pending');
      assert.equal(fixture.pages.get(threads.other)!.stage, 'identifier');
      assert.equal((await pool.query('SELECT * FROM vault_entries')).rowCount, 1);
      const persisted = JSON.stringify(
        (await pool.query('SELECT * FROM credential_requests')).rows,
      );
      for (const secret of [
        'fixture-owner@example.test',
        'fixture-wrong-password',
        'fixture-correct-password',
        '000000',
        '739204',
      ])
        assert.equal(persisted.includes(secret), false);
      assert.equal(
        (await computer.act(threads.corrected, { action: 'snapshot' })).text.includes('739204'),
        false,
      );

      await computer.act(threads['saved-identifier'], {
        action: 'open',
        url: 'https://1.1.1.1/login',
      });
      await vault.fillSaved(
        turns['saved-identifier'],
        'local-development',
        entries.at(-1).id,
        input,
      );
      assert.equal(fixture.pages.get(threads['saved-identifier'])!.stage, 'password');
      const savedPassword = await request('saved-identifier');
      assert.equal(
        (await submit(savedPassword, { password: 'fixture-new-password' })).statusCode,
        200,
      );
      const newest = (
        await pool.query('SELECT * FROM vault_entries ORDER BY updated_at DESC LIMIT 1')
      ).rows[0];
      assert.deepEqual(openCredential(key, newest), {
        username: 'fixture-owner@example.test',
        password: 'fixture-new-password',
      });
    } finally {
      await app.close();
      await computer.dispose();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

class Input {
  isConnected = true;
  disabled = false;
  readOnly = false;
  type = 'text';
  visible = true;
  stored = '';
  masks: string[] = [];
  clicked = false;
  afterEvent = () => {};
  style = {
    setProperty: (name: string) => {
      this.masks.push(name);
    },
  };
  get value() {
    return this.stored;
  }
  set value(value: string) {
    this.stored = value;
  }
  getClientRects() {
    return this.visible ? [{}] : [];
  }
  matches(value: string) {
    return value === 'input';
  }
  closest() {
    return null;
  }
  dispatchEvent() {
    this.afterEvent();
  }
  click() {
    this.clicked = true;
  }
}

function page(
  options: {
    origin?: string;
    passwordType?: string;
    hidden?: boolean;
    duplicates?: boolean;
    moveAfterUsername?: boolean;
  } = {},
) {
  const location = { origin: options.origin ?? 'https://example.com' };
  const username = new Input();
  const password = new Input();
  password.type = options.passwordType ?? 'password';
  password.visible = !options.hidden;
  const submit = new Input();
  if (options.moveAfterUsername)
    username.afterEvent = () => {
      location.origin = 'https://other.example';
    };
  const fields = credentialFields({
    threadId: 'fixture',
    origin: 'https://example.com',
    kind: 'password',
    username: 'fixture-user',
    password: 'fixture-secret',
    usernameSelector: '#user',
    passwordSelector: '#pass',
    submitSelector: '#submit',
  });
  const nodes = new Map([
    ['#user', [username]],
    ['#pass', options.duplicates ? [password, new Input()] : [password]],
    ['#submit', [submit]],
  ]);
  const result = runInNewContext(credentialScript('https://example.com', fields, '#submit'), {
    location,
    document: { querySelectorAll: (selector: string) => nodes.get(selector) ?? [] },
    HTMLInputElement: Input,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    Event: class {},
  });
  return { result: JSON.parse(JSON.stringify(result)), username, password, submit };
}

test('credential entry verifies origin and every target before filling any values', () => {
  for (const options of [
    { origin: 'https://other.example' },
    { passwordType: 'text' },
    { hidden: true },
    { duplicates: true },
  ]) {
    const { result, username, password, submit } = page(options);
    assert.deepEqual(result, { ok: false });
    assert.equal(username.value, '');
    assert.equal(password.value, '');
    assert.equal(submit.clicked, false);
  }
});

test('credential entry masks fields, returns no values and rechecks origin after events', () => {
  const success = page();
  assert.deepEqual(success.result, { ok: true });
  assert.equal(success.password.value, 'fixture-secret');
  assert.equal(success.password.masks.includes('-webkit-text-security'), true);
  assert.equal(success.submit.clicked, true);
  const changed = page({ moveAfterUsername: true });
  assert.deepEqual(changed.result, { ok: false });
  assert.equal(changed.password.value, '');
  assert.equal(changed.submit.clicked, false);
});

function domFixture(html: string) {
  const dom = new JSDOM(html, { url: 'https://example.com/login', runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.getClientRects = () =>
    [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
  return {
    dom,
    read: (mark = false, kind: 'identifier' | 'password' | 'otp' = 'password') =>
      credentialFeedback(
        dom.window.eval(credentialFeedbackScript('https://example.com', kind, 'domFixture', mark)),
      )!,
  };
}

test('credential feedback distinguishes fresh rejection from old alerts without returning page text or entered values', () => {
  const page = domFixture(
    '<input type="password" value="private-input-domFixture"><p role="alert"></p><div hidden><p role="alert">Incorrect hidden text</p></div>',
  );
  try {
    const before = page.read(true);
    assert.equal(before.rejected, false);
    assert.equal(before.sameDocument, true);
    page.dom.window.document.querySelector('p')!.textContent =
      'Email or password was incorrect: private-error-domFixture';
    const rejected = page.read();
    assert.equal(rejected.rejected, true);
    assert.equal(rejected.advanced, false);
    assert.notEqual(rejected.fingerprint, before.fingerprint);
    for (const secret of ['private-input-domFixture', 'private-error-domFixture', 'incorrect'])
      assert.equal(JSON.stringify(rejected).includes(secret), false);
    const oldAlert = page.read(true);
    assert.deepEqual(page.read(), oldAlert);
    page.dom.window.document.documentElement.removeAttribute('data-otto-entry-attempt');
    const navigated = page.read();
    assert.equal(navigated.rejected, true);
    assert.equal(navigated.sameDocument, false);
    assert.equal(navigated.fingerprint, oldAlert.fingerprint);
  } finally {
    page.dom.window.close();
  }
});

test('secure entry and delayed submit reject fields or controls hidden by ancestors', async () => {
  for (const attribute of ['hidden', 'aria-hidden="true"', 'inert', 'aria-disabled="true"']) {
    const page = domFixture(
      `<div ${attribute}><input id="password" type="password"><button id="submit">Continue</button></div>`,
    );
    try {
      let clicked = false;
      page.dom.window.document.querySelector('button')!.onclick = () => {
        clicked = true;
      };
      page.dom.window.setTimeout = ((run: () => void) => {
        run();
        return 0;
      }) as typeof page.dom.window.setTimeout;
      const input = page.dom.window.eval(
        credentialScript(
          'https://example.com',
          [{ selector: '#password', value: 'must-not-fill', password: true }],
          '#submit',
        ),
      ) as { ok: boolean };
      assert.equal(input.ok, false);
      assert.equal(page.dom.window.document.querySelector('input')!.value, '');
      const submitted = (await page.dom.window.eval(
        credentialSubmitScript('https://example.com', '#submit'),
      )) as { ok: boolean };
      assert.equal(submitted.ok, false);
      assert.equal(clicked, false);
    } finally {
      page.dom.window.close();
    }
  }
});

type Execute = (id: string, name: string, input: Record<string, unknown>) => Promise<unknown>;
const value = (result: AgentToolResult) => {
  const part = result.content.find((entry) => entry.type === 'text');
  assert.ok(part && part.type === 'text');
  return part.text === 'Waiting for the user to sign in.' ? part.text : JSON.parse(part.text);
};

async function fixture(
  t: TestContext,
  run: (execute: Execute) => Promise<void>,
  options: {
    fail?: 'database' | 'bind' | 'open' | 'hold';
    controller?: AbortController;
    observe?: (event: RuntimeObservation) => Promise<void>;
    sessionState?: 'pending' | 'saved' | 'disconnecting' | 'unrecognized';
    claimedState?: 'disconnecting';
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-browser-connection-recovery-'));
  const owner = randomUUID();
  const threadId = randomUUID();
  const turnId = randomUUID();
  const calls: string[] = [];
  const observations: RuntimeObservation[] = [];
  const questions: string[] = [];
  const queries: string[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('CREATE TABLE IF NOT EXISTS browser_connections'))
        return { rows: [], rowCount: 0 };
      queries.push(sql);
      if (options.fail === 'database') throw new Error('Private database fixture detail');
      if (sql === 'SELECT id,origin,state FROM browser_connections WHERE id=$1 AND owner_id=$2') {
        assert.equal(params[1], owner);
        return {
          rows: options.sessionState
            ? [{ id: params[0], origin: 'https://example.test', state: options.sessionState }]
            : [],
          rowCount: options.sessionState ? 1 : 0,
        };
      }
      if (sql === 'SELECT * FROM browser_connections WHERE id=$1 AND owner_id=$2') {
        assert.ok(options.sessionState);
        assert.equal(params[1], owner);
        return {
          rows: [{ id: params[0], origin: 'https://example.test', state: options.sessionState }],
          rowCount: 1,
        };
      }
      assert.ok(
        sql.includes('INSERT INTO browser_connections') ||
          sql.includes("SET state='needs_sign_in'"),
        sql,
      );
      return { rows: [], rowCount: 1 };
    },
    connect: async () => {
      assert.ok(options.sessionState);
      return {
        query: async (sql: string, params: unknown[] = []) => {
          queries.push(sql);
          if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
          assert.equal(
            sql,
            'SELECT * FROM browser_connections WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          );
          assert.equal(params[1], owner);
          return {
            rows: [
              {
                id: params[0],
                origin: 'https://example.test',
                state: options.claimedState ?? options.sessionState,
              },
            ],
            rowCount: 1,
          };
        },
        release() {},
      };
    },
  } as unknown as Pick<Pool, 'query' | 'connect'>;
  const operation = async (name: string) => {
    calls.push(name);
    if (options.fail === name)
      throw new BrowserConnectionError('Private dispatched fixture detail', 404);
  };
  const computer = fakeComputer({
    bindProfile: () => operation('bind'),
    act: async (_id, action) => {
      await operation(action.action);
      return { text: 'Synthetic public page', url: 'https://example.test/', candidates: [] };
    },
    inspectLogin: async () => {
      await operation('inspect');
      return {
        origin: 'https://example.test',
        url: 'https://example.test/',
        fields: [],
        methods: [],
      };
    },
    hold: () => operation('hold'),
    close: () => operation('close'),
    openSignIn: async () => {},
    finishSignIn: async () => {},
    signInScreenshot: async () => Buffer.from('synthetic'),
    signInControl: async () => {},
  });
  const service = await createBrowserConnections(pool, { ownerId: owner, computer });
  const scripted: Agent = {
    open: async ({ tools }) => ({
      resumed: false,
      prompt: async () =>
        run(async (_id, name, input) => {
          const tool = tools.find((entry) => entry.name === name)!;
          return value(await tool.execute(input));
        }),
      abort() {},
      dispose() {},
    }),
    dispose() {},
  };
  const agent = scripted;
  const runtime = createAgentRuntime({ agent, computer, workspace: fakeWorkspace() });
  t.after(async () => {
    try {
      await runtime.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const context: RuntimeContext = {
    threadId,
    turnId,
    prompt: 'Inspect a synthetic saved account. Do not submit any credentials.',
    history: [],
    attachments: [],
    workspacePath: directory,
    signal: (options.controller ?? new AbortController()).signal,
    emit: async () => {},
    reply: async () => {},
    delta() {},
    publish: async () => {
      throw new Error('Unexpected publication');
    },
    requestCredential: async () => {
      throw new Error('Unexpected credential request');
    },
    integration: async () => ({}),
    manage: async () => ({}),
    browserConnection: (input) => service.request(input, { threadId, turnId }, context.signal),
    waitForUser: async (question) => {
      questions.push(question);
    },
    observe: async (event) => {
      observations.push(event);
      await options.observe?.(event);
    },
  };
  return {
    calls,
    queries,
    observations,
    questions,
    run: () => runtime.runTurn(context),
  };
}

{
  const input = { action: 'connect', url: 'https://user:private-secret@example.test' };
  test('a credential-bearing connection URL is rejected before browser work and returned to the model', async (t) => {
    const f = await fixture(t, async (execute) => {
      const rejected = (await execute('invalid', 'browser_session', input)) as {
        status: string;
        code: string;
      };
      assert.equal(rejected.status, 'rejected');
      assert.equal(rejected.code, 'invalid_browser_connection_arguments');
      assert.doesNotMatch(JSON.stringify(rejected), /private-secret|private-invalid/);
      assert.deepEqual(f.calls, []);
      await execute('observe', 'browser', { action: 'snapshot' });
    });
    assert.deepEqual(await f.run(), { status: 'succeeded' });
    assert.deepEqual(f.calls, ['snapshot']);
    assert.deepEqual(f.queries, []);
  });
}

for (const [action, sessionState] of [
  ['use', 'pending'],
  ['connect', 'disconnecting'],
] as const) {
  test(`${action} rejects a ${sessionState} session before dispatch`, async (t) => {
    const f = await fixture(
      t,
      async (execute) => {
        const rejected = (await execute('unavailable', 'browser_session', {
          action,
          connectionId: randomUUID(),
          url: 'https://example.test',
        })) as { status: string; code: string };
        assert.equal(rejected.status, 'rejected');
        assert.equal(rejected.code, 'browser_connection_unavailable');
        assert.deepEqual(f.calls, []);
        await execute('observe', 'browser', { action: 'snapshot' });
      },
      { sessionState },
    );
    assert.deepEqual(await f.run(), { status: 'succeeded' });
    assert.deepEqual(f.calls, ['snapshot']);
    assert.equal(f.queries.length, 1);
    assert.deepEqual(f.questions, []);
  });
}

test('a session changing after preflight fails the call without browser work', async (t) => {
  const f = await fixture(
    t,
    async (execute) => {
      await execute('changed', 'browser_session', {
        action: 'use',
        connectionId: randomUUID(),
        url: 'https://example.test',
      });
      assert.fail('A delegated connection failure must stop the segment');
    },
    { sessionState: 'saved', claimedState: 'disconnecting' },
  );
  await assert.rejects(f.run(), /The action failed/);
  assert.deepEqual(f.calls, []);
});

test('a valid new connection still opens a private sign-in link and stops the segment', async (t) => {
  const f = await fixture(t, async (execute) => {
    await execute('connect', 'browser_session', {
      action: 'connect',
      url: 'https://example.test',
    });
  });
  assert.equal((await f.run()).status, 'waiting_user');
  assert.deepEqual(f.calls, ['bind', 'open', 'inspect', 'hold']);
  assert.equal(f.questions.length, 1);
  assert.match(f.questions[0], /\[Connect website\]\(\/browser-connect\/[A-Za-z0-9_-]{43}\)/);
});

test('database and dispatched failures stop the turn without a sign-in question', async (t) => {
  for (const fail of ['database', 'bind', 'open', 'hold'] as const) {
    const f = await fixture(
      t,
      async (execute) => {
        await execute('failed', 'browser_session', {
          action: 'connect',
          url: 'https://example.test',
        });
      },
      { fail },
    );
    await assert.rejects(f.run());
    assert.deepEqual(f.questions, []);
    assert.doesNotMatch(JSON.stringify(f.observations), /Private dispatched|Private database/);
  }
});

test('cancellation while recording a rejection stops the turn', async (t) => {
  const controller = new AbortController();
  const f = await fixture(
    t,
    async (execute) => {
      await execute('cancelled', 'browser_session', {
        action: 'use',
        url: 'https://example.test',
        connectionId: randomUUID(),
      });
      assert.fail('Cancellation must not return another model result');
    },
    {
      controller,
      observe: async (event) => {
        if (event.type === 'tool_end') controller.abort();
      },
    },
  );
  await assert.rejects(f.run());
  assert.deepEqual(f.calls, []);
  assert.equal(f.observations.filter((event) => event.type === 'tool_end').length, 1);
});
