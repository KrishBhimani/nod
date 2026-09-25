import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import { createVault, openCredential } from '../src/server/vault.ts';
import { stagedLoginBrowser } from './login-fixture.ts';

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
    const directory = await mkdtemp(join(tmpdir(), 'sidekick-rejected-login-'));
    const fixture = stagedLoginBrowser();
    const computer = createAgentBrowserComputer({ dataRoot: directory, run: fixture.run });
    const app = Fastify();
    const key = randomBytes(32);
    const resumed: string[] = [];
    await pool.query(
      "CREATE TABLE tasks(id text PRIMARY KEY,owner_id text NOT NULL,status text NOT NULL DEFAULT 'running',revision integer NOT NULL DEFAULT 0)",
    );
    await pool.query(
      "INSERT INTO tasks(id,owner_id) VALUES('corrected','local-development'),('other','local-development'),('saved-identifier','local-development')",
    );
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      inspect: computer.inspectLogin,
      hold: computer.hold,
      inject: computer.injectCredentials,
      retry: async () => {},
      resume: async (id) => {
        resumed.push(id);
        await pool.query("UPDATE tasks SET revision=revision+1,status='running' WHERE id=$1", [id]);
      },
    });
    vault.registerRoutes(app);
    const input = {
      origin: 'https://1.1.1.1',
      label: 'Fixture website',
      kind: 'password' as const,
    };
    const request = async (id: string) => {
      const result = await vault.request(id, 'local-development', input);
      await pool.query("UPDATE tasks SET status='waiting_credentials' WHERE id=$1", [id]);
      return result.url.replace('/vault/', '/api/credential-requests/');
    };
    const submit = (url: string, payload: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url,
        payload: { ...('password' in payload ? { label: 'Fixture login' } : {}), ...payload },
      });
    try {
      await computer.act('corrected', { action: 'open', url: 'https://1.1.1.1/login' });
      const page = fixture.pages.get('corrected')!;
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
      await computer.act('other', { action: 'open', url: 'https://1.1.1.1/login' });
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
      const rejectedObservation = await computer.act('corrected', { action: 'snapshot' });
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
      assert.deepEqual(
        (await pool.query("SELECT status,revision FROM tasks WHERE id='corrected'")).rows[0],
        { status: 'waiting_credentials', revision: 1 },
      );
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
      const completedInspection = await computer.inspectLogin('corrected');
      assert.deepEqual(completedInspection.fields, []);
      assert.deepEqual(completedInspection.methods, []);
      const formsBeforeStaleRequest = (
        await pool.query('SELECT count(*)::int AS count FROM credential_requests')
      ).rows[0].count;
      await assert.rejects(
        vault.request('corrected', 'local-development', { ...input, kind: 'otp' }),
        /no sign-in step/i,
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS count FROM credential_requests')).rows[0].count,
        formsBeforeStaleRequest,
      );
      assert.deepEqual(
        (await pool.query("SELECT status,revision FROM tasks WHERE id='corrected'")).rows[0],
        { status: 'running', revision: 3 },
      );
      assert.equal((await app.inject({ url: otherRequest })).json().status, 'pending');
      assert.equal(fixture.pages.get('other')!.stage, 'identifier');
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
        (await computer.act('corrected', { action: 'snapshot' })).text.includes('739204'),
        false,
      );

      await computer.act('saved-identifier', { action: 'open', url: 'https://1.1.1.1/login' });
      await vault.fillSaved('saved-identifier', 'local-development', entries.at(-1).id, input);
      assert.equal(fixture.pages.get('saved-identifier')!.stage, 'password');
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
