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
import { LoginPage, stagedLoginBrowser } from './login-fixture.ts';

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
    const directory = await mkdtemp(join(tmpdir(), 'sidekick-secure-stages-'));
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
      "CREATE TABLE tasks(id text PRIMARY KEY,owner_id text NOT NULL,status text NOT NULL DEFAULT 'running',revision integer NOT NULL DEFAULT 0)",
    );
    for (const id of ['staged', 'oauth', 'autofill', 'changed', 'split-code'])
      await pool.query("INSERT INTO tasks(id,owner_id) VALUES($1,'local-development')", [id]);
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      inspect: computer.inspectLogin,
      hold: computer.hold,
      inject: computer.injectCredentials,
      selectMethod: computer.selectLoginMethod,
      retry: async () => {},
      resume: async (id) => {
        resumed += 1;
        await pool.query("UPDATE tasks SET revision=revision+1,status='running' WHERE id=$1", [id]);
      },
    });
    vault.registerRoutes(app);
    const secureRequest = async (id: string, origin = 'https://1.1.1.1') => {
      const request = await vault.request(id, 'local-development', {
        origin,
        label: 'Synthetic login',
        kind: 'password',
        usernameSelector: '#stale-user',
        passwordSelector: '#missing-password',
        submitSelector: '#old-button',
      });
      await pool.query("UPDATE tasks SET status='waiting_credentials' WHERE id=$1", [id]);
      return request.url.replace('/vault/', '/api/credential-requests/');
    };
    try {
      await computer.act('staged', { action: 'open', url: 'https://1.1.1.1/login' });
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
      assert.equal(JSON.stringify(form).includes('data-sidekick-login-method'), false);
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
        'UPDATE credential_requests SET inspection=jsonb_set(inspection,\'{methods}\', \'[{"id":"credentials","label":"Unsupported old scan","kind":"credentials","supported":false}]\'::jsonb) WHERE task_id=\'staged\'',
      );
      const refreshed = await app.inject({ method: 'POST', url: first + '/refresh' });
      assert.equal(refreshed.statusCode, 200);
      assert.equal(
        refreshed.json().methods.find((method: { id: string }) => method.id === 'credentials')
          .supported,
        true,
      );
      assert.ok(await computer.screenshot('staged'));
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
        await vault.fillSelected('staged', 'local-development', {
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
      assert.equal(fixture.pages.get('staged')?.stage, 'complete');
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
      await computer.close('staged');

      await computer.act('autofill', { action: 'open', url: 'https://1.1.1.1/login' });
      await computer.hold('autofill', Date.now() + 2000);
      await vault.fillSaved('autofill', 'local-development', entries[0].id, {
        origin: 'https://1.1.1.1',
        label: 'Synthetic',
        kind: 'identifier',
      });
      assert.equal(fixture.pages.get('autofill')?.stage, 'password');
      await vault.fillSaved('autofill', 'local-development', entries[0].id, {
        origin: 'https://1.1.1.1',
        label: 'Synthetic',
        kind: 'password',
      });
      assert.equal(fixture.pages.get('autofill')?.stage, 'otp');
      await assert.rejects(
        vault.fillSaved('autofill', 'local-development', entries[0].id, {
          origin: 'https://1.1.1.1',
          label: 'Synthetic',
          kind: 'otp',
        }),
      );
      await computer.close('autofill');

      await computer.act('oauth', { action: 'open', url: 'https://1.1.1.1/login' });
      fixture.pages.get('oauth')!.stage = 'complete';
      fixture.pages.get('oauth')!.render();
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
      assert.equal((await computer.inspectLogin('oauth')).origin, 'https://2.2.2.2');
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
      await computer.close('oauth');

      await computer.act('changed', { action: 'open', url: 'https://1.1.1.1/login' });
      const changed = await secureRequest('changed');
      const page = fixture.pages.get('changed')!;
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
      await pool.query(
        "UPDATE tasks SET status='cancelled',revision=revision+1 WHERE id='changed'",
      );
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
      await computer.close('changed');

      await computer.act('split-code', { action: 'open', url: 'https://1.1.1.1/login' });
      const split = fixture.pages.get('split-code')!;
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
