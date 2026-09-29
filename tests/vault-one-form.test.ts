import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { requestCredentials } from './vault-fixture.ts';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { createVault, openCredential, type CredentialInjection } from '../src/server/vault.ts';
import type { CredentialKind, LoginInspection } from '../src/ports/computer.ts';
import type { TurnRef } from '../src/server/thread.ts';

test(
  'one Vault form securely carries a password across identifier stages and restart',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_vault_one_form_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    let app = Fastify();
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await pool.query(
        'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
      );
      await pool.query(
        "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text)",
      );
      const threadId = randomUUID();
      await pool.query("INSERT INTO threads(id,owner_id) VALUES($1,'local-development')", [
        threadId,
      ]);
      const tasks = new Map<string, TurnRef>();
      const roots = new Map<string, string>();
      const startTurn = async (resumeOf?: string) => {
        const turnId = randomUUID();
        await pool.query(
          "INSERT INTO turns(id,owner_id,thread_id,source,source_id) VALUES($1,'local-development',$2,$3,$4)",
          [
            turnId,
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
      const origin = 'https://accounts.example.test';
      let observedOrigin = origin;
      let rejected = false;
      let unavailable = false;
      const options = {
        keyStore: { id: 'fixture', configured: true, getKey: async () => key },
        inspect: async (id: string): Promise<LoginInspection> => ({
          origin: observedOrigin,
          url: observedOrigin + '/login',
          fields: [{ kind: stages.get(id) ?? 'identifier', selector: '#observed', label: 'Email' }],
          methods: [{ id: 'credentials', kind: 'credentials', label: 'Sign in', supported: true }],
          submitSelector: '#continue',
        }),
        inject: async (input: CredentialInjection) => {
          injections.push(input);
          if (unavailable && input.kind === 'password') throw new Error('Synthetic unavailable');
          if (rejected && input.kind === 'password') return { status: 'rejected' as const };
          stages.set(input.threadId, input.kind === 'identifier' ? 'password' : 'otp');
          return { status: 'submitted' as const };
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
          tasks.set(name, await startTurn(turnId));
        },
      };
      let vault = await createVault(pool, options);
      vault.registerRoutes(app);
      const requestInput = (kind: CredentialKind) => ({ origin, label: 'Website login', kind });
      const begin = async (id: string) => {
        if (!tasks.has(id)) {
          const turn = await startTurn();
          tasks.set(id, turn);
          roots.set(id, turn.turnId);
        }
        stages.set(threadId, 'identifier');
        const request = await requestCredentials(
          vault,
          pool,
          task(id),
          'local-development',
          requestInput('identifier'),
        );
        const url = request.url.replace('/vault/', '/api/credential-requests/');
        const submitted = await app.inject({
          method: 'POST',
          url,
          payload: {
            label: 'My Google account',
            username: 'synthetic@example.test',
            password: 'one-form-synthetic-password',
          },
        });
        assert.equal(submitted.statusCode, 200);
        assert.equal(submitted.json().ok, true);
        assert.equal(injections.at(-1)?.kind, 'identifier');
        assert.equal(injections.at(-1)?.password, undefined);
        return url;
      };
      await t.test(
        'password uses the next observed stage without another form or secret response',
        async () => {
          const url = await begin('complete');
          assert.equal((await pool.query('SELECT * FROM vault_entries')).rowCount, 0);
          assert.doesNotMatch(
            JSON.stringify((await pool.query('SELECT * FROM credential_account_selections')).rows),
            /one-form-synthetic-password|synthetic@example/,
          );
          await app.close();
          app = Fastify();
          vault = await createVault(pool, options);
          vault.registerRoutes(app);
          assert.equal(
            await vault.fillSelected(
              task('complete'),
              'local-development',
              requestInput('password'),
            ),
            true,
          );
          assert.equal(injections.at(-1)?.password, 'one-form-synthetic-password');
          assert.equal(injections.at(-1)?.passwordSelector, '#observed');
          assert.equal(injections.at(-1)?.username, undefined);
          assert.equal((await pool.query('SELECT * FROM credential_requests')).rowCount, 1);
          const entry = (await pool.query('SELECT * FROM vault_entries')).rows[0];
          assert.equal(entry.label, 'My Google account');
          assert.equal(entry.identifier_label, 'Email');
          assert.deepEqual(openCredential(key, entry), {
            username: 'synthetic@example.test',
            password: 'one-form-synthetic-password',
          });
          const selected = (await pool.query('SELECT * FROM credential_account_selections'))
            .rows[0];
          assert.equal(openCredential(key, selected).password, '');
          assert.doesNotMatch(
            (await app.inject({ url })).body,
            /synthetic@example|one-form-synthetic/,
          );
          assert.equal(
            (await app.inject({ method: 'POST', url, payload: { username: 'repeat' } })).statusCode,
            409,
          );
          const otp = await requestCredentials(
            vault,
            pool,
            task('complete'),
            'local-development',
            requestInput('otp'),
          );
          const otpUrl = otp.url.replace('/vault/', '/api/credential-requests/');
          assert.equal((await app.inject({ url: otpUrl })).json().kind, 'otp');
          assert.equal(
            (await app.inject({ method: 'POST', url: otpUrl, payload: { code: '654321' } })).json()
              .ok,
            true,
          );
          assert.equal(injections.at(-1)?.code, '654321');
          assert.equal(injections.at(-1)?.password, undefined);
        },
      );

      await t.test(
        'a rejected held password is consumed without saving or trying it twice',
        async () => {
          await begin('rejected');
          const before = (await pool.query('SELECT * FROM vault_entries')).rowCount;
          const beforeInjections = injections.length;
          rejected = true;
          assert.equal(
            await vault.fillSelected(
              task('rejected'),
              'local-development',
              requestInput('password'),
            ),
            false,
          );
          assert.equal((await pool.query('SELECT * FROM vault_entries')).rowCount, before);
          assert.equal(injections.length, beforeInjections + 1);
          assert.equal(injections.at(-1)?.kind, 'password');
          const selected = (
            await pool.query('SELECT * FROM credential_account_selections WHERE root_turn_id=$1', [
              roots.get('rejected'),
            ])
          ).rows[0];
          assert.equal(selected.blocked, true);
          assert.equal(openCredential(key, selected).password, '');
          const count = injections.length;
          assert.equal(
            await vault.fillSelected(
              task('rejected'),
              'local-development',
              requestInput('password'),
            ),
            false,
          );
          assert.equal(injections.length, count);
          rejected = false;
          await begin('rejected');
          assert.equal(
            await vault.fillSelected(
              task('rejected'),
              'local-development',
              requestInput('password'),
            ),
            true,
          );
          assert.equal(
            (await pool.query('SELECT * FROM vault_entries')).rowCount,
            (before ?? 0) + 1,
          );
        },
      );

      await t.test(
        'an uncertain password attempt clears its held value and is not replayed',
        async () => {
          await begin('interrupted');
          unavailable = true;
          assert.equal(
            await vault.fillSelected(
              task('interrupted'),
              'local-development',
              requestInput('password'),
            ),
            false,
          );
          unavailable = false;
          const selected = (
            await pool.query('SELECT * FROM credential_account_selections WHERE root_turn_id=$1', [
              roots.get('interrupted'),
            ])
          ).rows[0];
          assert.equal(selected.blocked, true);
          assert.equal(openCredential(key, selected).password, '');
          const count = injections.length;
          assert.equal(
            await vault.fillSelected(
              task('interrupted'),
              'local-development',
              requestInput('password'),
            ),
            false,
          );
          assert.equal(injections.length, count);
        },
      );

      await t.test(
        'held passwords remain bound to owner, origin, running turn and expiry',
        async () => {
          await begin('fences');
          const count = injections.length;
          assert.equal(
            await vault.fillSelected(task('fences'), 'another-owner', requestInput('password')),
            undefined,
          );
          assert.equal(
            await vault.fillSelected(task('fences'), 'local-development', {
              ...requestInput('password'),
              origin: 'https://other.example.test',
            }),
            undefined,
          );
          observedOrigin = 'https://other.example.test';
          assert.equal(
            await vault.fillSelected(task('fences'), 'local-development', requestInput('password')),
            false,
          );
          observedOrigin = origin;
          await pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [
            task('fences').turnId,
          ]);
          assert.equal(
            await vault.fillSelected(task('fences'), 'local-development', requestInput('password')),
            false,
          );
          await pool.query("UPDATE turns SET status='running' WHERE id=$1", [
            task('fences').turnId,
          ]);
          await pool.query(
            "UPDATE credential_account_selections SET expires_at=now()-interval '1 second' WHERE root_turn_id=$1",
            [roots.get('fences')],
          );
          assert.equal(
            await vault.fillSelected(task('fences'), 'local-development', requestInput('password')),
            false,
          );
          assert.equal(injections.length, count);
          await vault.resumePending();
          const expired = (
            await pool.query('SELECT * FROM credential_account_selections WHERE root_turn_id=$1', [
              roots.get('fences'),
            ])
          ).rows[0];
          assert.equal(expired.ciphertext, '');
          assert.equal(expired.blocked, true);
        },
      );
    } finally {
      try {
        await app.close();
      } finally {
        try {
          await pool.end();
        } finally {
          try {
            await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
          } finally {
            await admin.end();
          }
        }
      }
    }
  },
);
