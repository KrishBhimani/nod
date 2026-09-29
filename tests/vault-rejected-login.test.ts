import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { createBrowserFixture as createAgentBrowserComputer } from './browser-fixture.ts';
import { createVault, openCredential } from '../src/server/vault.ts';
import { stagedLoginBrowser } from './login-fixture.ts';
import type { TurnRef } from '../src/server/thread.ts';

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
      "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text)",
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
          "INSERT INTO turns(id,owner_id,thread_id,source,source_id) VALUES($1,'local-development',$2,'resume',$3)",
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
        "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1",
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
