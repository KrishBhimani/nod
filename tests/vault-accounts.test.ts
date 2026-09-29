import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { requestCredentials } from './vault-fixture.ts';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { createVault, sealCredential, type CredentialInjection } from '../src/server/vault.ts';
import type { CredentialKind, LoginInspection } from '../src/ports/computer.ts';
import type { CredentialRequest, VaultLoginEntry } from '../src/shared/contracts.ts';
import type { TurnRef } from '../src/server/thread.ts';

test(
  'named Vault accounts preserve exact websites and chosen staged identity across restart',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_vault_accounts_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
    );
    await pool.query(
      "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text)",
    );
    const threads = new Map<string, string>();
    const tasks = new Map<string, TurnRef>();
    const startTurn = async (owner = 'local-development', resumeOf?: string) => {
      let threadId = threads.get(owner);
      if (!threadId) {
        threadId = randomUUID();
        threads.set(owner, threadId);
        await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [threadId, owner]);
      }
      const turnId = randomUUID();
      await pool.query(
        'INSERT INTO turns(id,owner_id,thread_id,source,source_id) VALUES($1,$2,$3,$4,$5)',
        [
          turnId,
          owner,
          threadId,
          resumeOf ? 'resume' : 'user',
          resumeOf ? `credentials:${resumeOf}` : null,
        ],
      );
      return { threadId, turnId };
    };
    const task = (name: string) => tasks.get(name)!;
    const key = randomBytes(32);
    const stages = new Map<string, CredentialKind>();
    const injections: CredentialInjection[] = [];
    const resumed: string[] = [];
    let reject = false;
    let app = Fastify();
    const options = {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      inspect: async (threadId: string): Promise<LoginInspection> => ({
        origin: 'https://example.com',
        url: 'https://example.com/login',
        fields: [
          { kind: stages.get(threadId) ?? 'identifier', selector: '#login', label: 'Login' },
        ],
        methods: [{ id: 'credentials', kind: 'credentials', label: 'Login', supported: true }],
        submitSelector: '#submit',
      }),
      inject: async (input: CredentialInjection) => {
        injections.push(input);
        if (reject) return { status: 'rejected' as const };
        stages.set(input.threadId, input.kind === 'identifier' ? 'password' : 'otp');
      },
      retry: async () => {},
      resume: async (turnId: string) => {
        const name = [...tasks].find(([, value]) => value.turnId === turnId)?.[0];
        assert.ok(name);
        const result = await pool.query(
          "UPDATE turns SET status='succeeded',waiting_reason=NULL WHERE id=$1 AND status='waiting' AND waiting_reason='credentials'",
          [turnId],
        );
        assert.equal(result.rowCount, 1);
        tasks.set(name, await startTurn('local-development', turnId));
        resumed.push(name);
      },
    };
    let vault = await createVault(pool, options);
    vault.registerRoutes(app);
    const addTask = async (id: string, kind: CredentialKind = 'identifier') => {
      const turn = await startTurn();
      tasks.set(id, turn);
      stages.set(turn.threadId, kind);
    };
    const input = (kind: CredentialKind = 'identifier') => ({
      origin: 'https://example.com',
      label: 'Model provided label',
      kind,
    });
    const form = async (taskId: string) => {
      const request = await requestCredentials(
        vault,
        pool,
        task(taskId),
        'local-development',
        input(stages.get(task(taskId).threadId)),
      );
      return request.url.replace('/vault/', '/api/credential-requests/');
    };
    const choose = (url: string, entryId: string) =>
      app.inject({ method: 'POST', url: `${url}/saved`, payload: { entryId } });
    const describe = async (url: string) => (await app.inject({ url })).json<CredentialRequest>();
    const save = async (label: string, origin: string, username: string, password: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault',
        payload: { label, origin, username, password },
      });
      assert.equal(response.statusCode, 200);
      return response.json<VaultLoginEntry>();
    };
    try {
      await t.test('invitation absence is based only on this owner and exact website', async () => {
        await addTask('invitation-missing');
        await save('Other website', 'https://other.example.test', 'other-user', 'other-password');
        const foreign = {
          id: randomUUID(),
          owner_id: 'foreign-owner',
          origin: 'https://example.com',
        };
        await pool.query(
          'INSERT INTO vault_entries(id,owner_id,label,origin,username_hint,ciphertext) VALUES($1,$2,$3,$4,$5,$6)',
          [
            foreign.id,
            foreign.owner_id,
            'Foreign',
            foreign.origin,
            'fo…',
            sealCredential(key, foreign, {
              username: 'foreign-user',
              password: 'foreign-password',
            }),
          ],
        );
        const missing = await requestCredentials(
          vault,
          pool,
          task('invitation-missing'),
          'local-development',
          input(),
        );
        assert.equal(missing.invitation.savedLoginAvailable, false);
        assert.doesNotMatch(JSON.stringify(missing.invitation), /foreign|other-user|password/);
      });
      const first = await save(
        'Personal',
        'EXAMPLE.com',
        'same-first@example.test',
        'first-password',
      );
      const second = await save(
        'Work',
        'https://EXAMPLE.com:443/',
        'same-second@example.test',
        'second-password',
      );
      await addTask('invitation-saved');
      const saved = await requestCredentials(
        vault,
        pool,
        task('invitation-saved'),
        'local-development',
        input(),
      );
      assert.equal(saved.invitation.savedLoginAvailable, true);
      assert.doesNotMatch(JSON.stringify(saved.invitation), /same-first|same-second|Personal|Work/);
      await addTask('invitation-otp', 'otp');
      const otp = await requestCredentials(
        vault,
        pool,
        task('invitation-otp'),
        'local-development',
        input('otp'),
      );
      assert.equal(otp.invitation.savedLoginAvailable, undefined);
      const subdomain = await save(
        'Subdomain',
        'https://login.example.com',
        'same-second@example.test',
        'other-secret',
      );
      const port = await save(
        'Other port',
        'https://example.com:8443',
        'same-second@example.test',
        'port-secret',
      );
      const foreign = {
        id: randomUUID(),
        owner_id: 'foreign-owner',
        origin: 'https://example.com',
      };
      await pool.query(
        'INSERT INTO vault_entries(id,owner_id,label,origin,username_hint,ciphertext) VALUES($1,$2,$3,$4,$5,$6)',
        [
          foreign.id,
          foreign.owner_id,
          'Foreign',
          foreign.origin,
          'sa…',
          sealCredential(key, foreign, { username: 'foreign-user', password: 'foreign-secret' }),
        ],
      );

      await t.test(
        'manual saves normalize bare domains and keep two distinct user names without secrets',
        async () => {
          assert.notEqual(first.id, second.id);
          assert.equal(first.origin, 'https://example.com');
          assert.equal(second.origin, first.origin);
          assert.equal(first.usernameHint, second.usernameHint);
          const entries = await vault.list();
          assert.deepEqual(
            entries
              .filter((entry) => entry.origin === first.origin)
              .map((entry) => entry.label)
              .sort(),
            ['Personal', 'Work'],
          );
          assert.doesNotMatch(
            JSON.stringify(entries),
            /first-password|second-password|same-first|same-second/,
          );
          for (const origin of [
            'example.com/login',
            'ftp://example.com',
            'example.com?secret=x',
            'https://user:password@example.com',
          ]) {
            const result = await app.inject({
              method: 'POST',
              url: '/api/vault',
              payload: { label: 'Invalid', origin, username: 'fixture', password: 'fixture' },
            });
            assert.equal(result.statusCode, 400, origin);
          }
          await addTask('strict-origin');
          await assert.rejects(
            vault.request(task('strict-origin'), 'local-development', {
              ...input(),
              origin: 'example.com',
            }),
            /valid website origin/,
          );
        },
      );

      await t.test(
        'selection metadata and POST enforce exact origin and owner without leaking other accounts',
        async () => {
          for (const [index, id] of [subdomain.id, port.id, foreign.id, randomUUID()].entries()) {
            const taskId = `invalid-${index}`;
            await addTask(taskId);
            const url = await form(taskId);
            assert.deepEqual(
              (await describe(url)).savedEntries?.map((entry) => entry.id).sort(),
              [first.id, second.id].sort(),
            );
            const before = injections.length;
            const result = await choose(url, id);
            assert.equal(result.statusCode, 200);
            assert.equal(result.json().ok, false);
            assert.match(result.json().error, /no longer available/);
            assert.equal(injections.length, before);
            assert.equal(resumed.includes(taskId), false);
            assert.equal((await choose(url, first.id)).statusCode, 409);
            assert.equal(
              (
                await describe(
                  result.json().retryUrl.replace('/vault/', '/api/credential-requests/'),
                )
              ).status,
              'pending',
            );
          }
        },
      );

      await t.test(
        'selected identifier resumes with the same saved password after process restart',
        async () => {
          await addTask('selected');
          const url = await form('selected');
          const response = await choose(url, second.id);
          assert.equal(response.statusCode, 200);
          assert.equal(response.json().ok, true);
          assert.equal(injections.at(-1)?.username, 'same-second@example.test');
          assert.equal(injections.at(-1)?.password, undefined);
          assert.equal((await choose(url, first.id)).statusCode, 409);
          await app.close();
          app = Fastify();
          vault = await createVault(pool, options);
          vault.registerRoutes(app);
          assert.equal(
            await vault.fillSelected(task('selected'), 'local-development', input('password')),
            true,
          );
          assert.equal(injections.at(-1)?.password, 'second-password');
          assert.equal(injections.at(-1)?.username, undefined);
          assert.equal(
            (await vault.list()).filter((entry) => entry.origin === first.origin).length,
            2,
          );
          const selections = JSON.stringify(
            (await pool.query('SELECT * FROM credential_account_selections')).rows,
          );
          assert.doesNotMatch(selections, /same-first|same-second|first-password|second-password/);
        },
      );

      await t.test(
        'fresh identifier clears old account selection and filters password choices across restart',
        async () => {
          await addTask('fresh-identifier');
          const chosen = await form('fresh-identifier');
          assert.equal((await choose(chosen, first.id)).json().ok, true);
          stages.set(task('fresh-identifier').threadId, 'identifier');
          const url = await form('fresh-identifier');
          const response = await app.inject({
            method: 'POST',
            url,
            payload: { username: 'same-second@example.test' },
          });
          assert.equal(response.statusCode, 200);
          await app.close();
          app = Fastify();
          vault = await createVault(pool, options);
          vault.registerRoutes(app);
          assert.equal(
            await vault.fillSelected(
              task('fresh-identifier'),
              'local-development',
              input('password'),
            ),
            false,
          );
          const passwordUrl = await form('fresh-identifier');
          assert.deepEqual(
            (await describe(passwordUrl)).savedEntries?.map((entry) => entry.id),
            [second.id],
          );
          const before = injections.length;
          assert.equal((await choose(passwordUrl, first.id)).statusCode, 409);
          assert.equal(injections.length, before);
          assert.equal((await choose(passwordUrl, second.id)).json().ok, true);
          assert.equal(injections.at(-1)?.password, 'second-password');
        },
      );

      await t.test(
        'a delayed key lookup cannot bypass a blocked or changed account selection',
        async () => {
          const alias = await save(
            'Personal alternate',
            'example.com',
            'same-first@example.test',
            'alternate-password',
          );
          for (const state of ['blocked', 'changed']) {
            const taskId = `key-race-${state}`;
            await addTask(taskId);
            await vault.fillSaved(task(taskId), 'local-development', first.id, input());
            let keyReady!: () => void;
            let releaseKey!: () => void;
            const started = new Promise<void>((resolve) => {
              keyReady = resolve;
            });
            const release = new Promise<void>((resolve) => {
              releaseKey = resolve;
            });
            const racingApp = Fastify();
            const racingVault = await createVault(pool, {
              ...options,
              keyStore: {
                id: 'held-fixture',
                configured: true,
                getKey: async () => {
                  keyReady();
                  await release;
                  return key;
                },
              },
            });
            racingVault.registerRoutes(racingApp);
            try {
              const before = injections.length;
              const filling = racingVault.fillSelected(
                task(taskId),
                'local-development',
                input('password'),
              );
              await started;
              if (state === 'blocked')
                await pool.query(
                  'UPDATE credential_account_selections SET blocked=true WHERE root_turn_id=$1',
                  [task(taskId).turnId],
                );
              else
                await pool.query(
                  'UPDATE credential_account_selections SET entry_id=$2 WHERE root_turn_id=$1',
                  [task(taskId).turnId, alias.id],
                );
              releaseKey();
              assert.equal(await filling, false);
              assert.equal(injections.length, before);
            } finally {
              releaseKey();
              await racingApp.close();
            }
          }
        },
      );

      await t.test(
        'rejected saved details return a fresh named-entry form and never overwrite the saved account',
        async () => {
          await addTask('rejected', 'password');
          const url = await form('rejected');
          const expiresAt = (await describe(url)).expiresAt;
          const beforeCount = (await vault.list()).length;
          reject = true;
          const response = await choose(url, second.id);
          reject = false;
          assert.equal(response.json().ok, false);
          assert.equal(resumed.includes('rejected'), false);
          const retryUrl = response.json().retryUrl.replace('/vault/', '/api/credential-requests/');
          const retried = await describe(retryUrl);
          assert.equal(retried.expiresAt, expiresAt);
          assert.deepEqual(retried.savedEntries, []);
          assert.equal(
            await vault.fillSelected(task('rejected'), 'local-development', input('password')),
            false,
          );
          const injected = injections.length;
          const missingName = await app.inject({
            method: 'POST',
            url: retryUrl,
            payload: { password: 'replacement-password' },
          });
          assert.equal(missingName.statusCode, 400);
          assert.equal(injections.length, injected);
          const corrected = await app.inject({
            method: 'POST',
            url: retryUrl,
            payload: { label: 'Work replacement', password: 'replacement-password' },
          });
          assert.equal(corrected.statusCode, 200);
          assert.equal((await vault.list()).length, beforeCount + 1);
          assert.equal((await vault.list()).find((entry) => entry.id === second.id)?.label, 'Work');
          assert.ok((await vault.list()).find((entry) => entry.label === 'Work replacement'));
          const stored = (
            await pool.query('SELECT * FROM vault_entries WHERE label=$1', ['Work replacement'])
          ).rows[0];
          assert.equal(stored.origin, 'https://example.com');
          assert.doesNotMatch(JSON.stringify(stored), /replacement-password|same-second/);
        },
      );

      await t.test(
        'deleted chosen entry cannot switch automatically to the sole remaining account',
        async () => {
          const disposable = await save(
            'Disposable',
            'example.com',
            'removed-account',
            'removed-password',
          );
          await addTask('deleted');
          const url = await form('deleted');
          assert.equal((await choose(url, disposable.id)).json().ok, true);
          await app.inject({ method: 'DELETE', url: `/api/vault/${disposable.id}` });
          const before = injections.length;
          assert.equal(
            await vault.fillSelected(task('deleted'), 'local-development', input('password')),
            false,
          );
          assert.equal(injections.length, before);
          const passwordUrl = await form('deleted');
          assert.deepEqual((await describe(passwordUrl)).savedEntries, []);
          assert.equal((await choose(passwordUrl, first.id)).statusCode, 409);
          assert.equal((await choose(passwordUrl, disposable.id)).json().ok, false);
          assert.equal(injections.length, before);
        },
      );

      await t.test(
        'expired, archived and foreign requests cannot select saved entries and OTP has no accounts',
        async () => {
          for (const state of ['expired', 'archived']) {
            await addTask(state);
            const url = await form(state);
            if (state === 'expired')
              await pool.query(
                "UPDATE credential_requests SET expires_at=now()-interval '1 second' WHERE turn_id=$1",
                [task(state).turnId],
              );
            else {
              await pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [
                task(state).threadId,
              ]);
              threads.delete('local-development');
            }
            const before = injections.length;
            assert.equal((await choose(url, first.id)).statusCode, 409);
            assert.equal((await describe(url)).savedEntries, undefined);
            assert.equal(injections.length, before);
          }
          const foreignTask = await startTurn('foreign-owner');
          const foreignRequest = await requestCredentials(
            vault,
            pool,
            foreignTask,
            'foreign-owner',
            input(),
          );
          const foreignUrl = foreignRequest.url.replace('/vault/', '/api/credential-requests/');
          assert.equal((await app.inject({ url: foreignUrl })).statusCode, 404);
          assert.equal((await choose(foreignUrl, foreign.id)).statusCode, 409);
          await addTask('otp', 'otp');
          const otpUrl = await form('otp');
          assert.equal((await describe(otpUrl)).savedEntries, undefined);
          assert.equal((await choose(otpUrl, first.id)).statusCode, 409);
        },
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
