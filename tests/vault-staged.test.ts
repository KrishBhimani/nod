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
import { LoginPage, stagedLoginBrowser } from './login-fixture.ts';
import type { TurnRef } from '../src/server/thread.ts';

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
      "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running')",
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
          "INSERT INTO turns(id,owner_id,thread_id,source,source_id) VALUES($1,'local-development',$2,'resume',$3)",
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
      await pool.query("UPDATE turns SET status='waiting' WHERE id=$1", [turns[name].turnId]);
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
