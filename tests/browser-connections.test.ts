import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type { Computer, CredentialInput, LoginInspection } from '../src/ports/computer.ts';
import { createBrowserConnections } from '../src/server/browser-connections.ts';

test(
  'a website session uses one private profile and one owner',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `browser_connections_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    const bindings: Array<{ taskId: string; profileId: string; origin?: string }> = [];
    const inputs: CredentialInput[] = [];
    const closed: string[] = [];
    const removed: string[] = [];
    let failDelete = false;
    let signedIn = false;
    let technogymLoginOpen = false;
    let blocked = false;
    let verificationRequired = false;
    let verificationVisible = false;
    let loginOrigin = 'https://api.linkedin.com';
    let pageUrl = 'https://www.linkedin.com/messaging/';
    const computer = {
      async bindProfile(taskId: string, profileId: string, origin?: string) {
        bindings.push({ taskId, profileId, origin });
      },
      async deleteProfile(profileId: string) {
        if (failDelete) throw new Error('Synthetic profile removal failed.');
        removed.push(profileId);
      },
      async act(_taskId: string, input: { action: string; url?: string }) {
        if (input.action === 'click' && input.url === undefined) {
          technogymLoginOpen = true;
          pageUrl = 'https://www.technogym.com/login';
        } else pageUrl = input.url ?? pageUrl;
        return {
          url: pageUrl,
          text: blocked ? '403 ERROR Request blocked' : 'Synthetic page',
          candidates:
            pageUrl === 'https://www.technogym.com/en-IE/' && !technogymLoginOpen
              ? [{ id: '@login', label: 'Log in' }]
              : [],
        };
      },
      async inspectLogin(): Promise<LoginInspection> {
        const ready = !pageUrl.startsWith('https://www.technogym.com') || technogymLoginOpen;
        return {
          origin: loginOrigin,
          url: `${loginOrigin}/checkpoint/lg/login`,
          fields:
            signedIn || !ready
              ? []
              : verificationVisible
                ? [{ kind: 'otp', selector: '#code', label: 'Verification code' }]
                : [
                    { kind: 'identifier', selector: '#username', label: 'Email or phone' },
                    { kind: 'password', selector: '#password', label: 'Password' },
                  ],
          methods:
            signedIn || !ready
              ? []
              : [{ id: 'credentials', label: 'Email', kind: 'credentials', supported: true }],
          submitSelector: '#sign-in',
        };
      },
      async injectCredentials(input: CredentialInput) {
        inputs.push(input);
        if (input.kind === 'otp') {
          verificationRequired = false;
          verificationVisible = false;
          signedIn = true;
        } else if (verificationRequired) {
          verificationVisible = true;
          pageUrl = 'https://api.linkedin.com/checkpoint/challenge';
        } else signedIn = true;
        return { status: 'submitted' as const };
      },
      async hold() {},
      async close(taskId: string) {
        closed.push(taskId);
      },
      async openSignIn() {},
      async finishSignIn() {},
      async signInScreenshot() {
        return Buffer.from('synthetic-image');
      },
      async signInControl() {},
      async releaseControl() {},
    } as unknown as Computer;
    const savedLogins: Array<{ origin: string; username: string; password: string }> = [];
    try {
      await pool.query(
        'CREATE TABLE tasks (id uuid PRIMARY KEY,owner_id text,status text,revision integer)',
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
      assert.equal(stored.start_url, 'https://www.linkedin.com/messaging/');
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
      const oldAttempt = await app.inject({
        method: 'GET',
        url: `/api/browser-connections/attempt/${oldToken}`,
      });
      assert.equal(oldAttempt.statusCode, 404);
      assert.equal((await service.list())[0].accountName, 'My LinkedIn');
      const premature = await app.inject({
        method: 'POST',
        url: `/api/browser-connections/attempt/${token}/finish`,
        payload: {},
      });
      assert.equal(premature.statusCode, 409);
      verificationRequired = true;
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
      assert.equal(pageUrl, 'https://api.linkedin.com/checkpoint/challenge');
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
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.json().state, 'saved');
      const other = await createBrowserConnections(pool, { ownerId: 'owner-b', computer });
      await assert.rejects(other.use(connectionId, randomUUID(), pageUrl), /unavailable/);
      const nextTask = randomUUID();
      const used = await service.use(connectionId, nextTask, 'https://www.linkedin.com/jobs/');
      assert.equal(used.status, 'session_saved');
      assert.equal(bindings.at(-1)?.profileId, bindings[0].profileId);
      assert.equal(bindings.at(-1)?.origin, 'https://www.linkedin.com');
      assert.ok(closed.includes(connectionId));
      blocked = true;
      const denied = await service.use(
        connectionId,
        nextTask,
        'https://www.linkedin.com/messaging/',
      );
      assert.equal(denied.status, 'site_blocked');
      blocked = false;
      await assert.rejects(
        service.use(connectionId, randomUUID(), 'https://www.technogym.com/en-IE/'),
        /another website/,
      );
      failDelete = true;
      await assert.rejects(service.disconnect(connectionId), /removal failed/);
      assert.equal((await service.list())[0].browserState, 'disconnecting');
      failDelete = false;
      await service.disconnect(connectionId);
      assert.deepEqual(removed, [bindings[0].profileId]);
      loginOrigin = 'https://www.technogym.com';
      signedIn = false;
      const secondBegin = await app.inject({
        method: 'POST',
        url: '/api/browser-connections',
        payload: { url: 'https://www.technogym.com/en-IE/' },
      });
      assert.equal(secondBegin.statusCode, 200);
      const secondToken = secondBegin.json<{ url: string }>().url.split('/').at(-1)!;
      const secondAttempt = await app.inject({
        method: 'GET',
        url: `/api/browser-connections/attempt/${secondToken}`,
      });
      assert.equal(secondAttempt.json().inspection.canSubmit, true);
      assert.equal(secondAttempt.json().inspection.fields.length, 2);
      assert.notEqual(bindings.at(-1)?.profileId, bindings[0].profileId);
      const secondPremature = await app.inject({
        method: 'POST',
        url: `/api/browser-connections/attempt/${secondToken}/finish`,
        payload: {},
      });
      assert.equal(secondPremature.statusCode, 409);
      assert.equal((await service.list()).length, 1);
      blocked = true;
      const blockedBegin = await app.inject({
        method: 'POST',
        url: '/api/browser-connections',
        payload: { url: 'https://blocked.example.com/' },
      });
      assert.equal(blockedBegin.statusCode, 409);
      blocked = false;
      signedIn = false;
      loginOrigin = 'https://www.linkedin.com';
      const waitingTask = { id: randomUUID(), revision: 4 };
      await pool.query('INSERT INTO tasks(id,owner_id,status,revision) VALUES($1,$2,$3,$4)', [
        waitingTask.id,
        'owner-a',
        'running',
        waitingTask.revision,
      ]);
      const taskAttempt = await service.begin(
        { url: 'https://www.linkedin.com/messaging/' },
        waitingTask,
      );
      await pool.query("UPDATE tasks SET status='waiting_user' WHERE id=$1", [waitingTask.id]);
      const taskRenewed = await app.inject({
        method: 'POST',
        url: '/api/browser-connections',
        payload: {
          url: 'https://www.linkedin.com/messaging/',
          connectionId: taskAttempt.connectionId,
        },
      });
      assert.equal(taskRenewed.statusCode, 200);
      const taskToken = taskRenewed.json<{ url: string }>().url.split('/').at(-1)!;
      const taskDescription = await app.inject({
        method: 'GET',
        url: `/api/browser-connections/attempt/${taskToken}`,
      });
      assert.equal(taskDescription.json().fromTask, true);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
