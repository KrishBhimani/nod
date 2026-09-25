import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { createVault, openCredential, type CredentialInjection } from '../src/server/vault.ts';
import type { CredentialKind, LoginInspection } from '../src/ports/computer.ts';

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
        "CREATE TABLE tasks(id text PRIMARY KEY,owner_id text NOT NULL,revision integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'running')",
      );
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
          stages.set(input.taskId, input.kind === 'identifier' ? 'password' : 'otp');
          return { status: 'submitted' as const };
        },
        retry: async () => {},
        resume: async (id: string, revision: number) => {
          const result = await pool.query(
            "UPDATE tasks SET status='running',revision=revision+1 WHERE id=$1 AND revision=$2 AND status='waiting_credentials'",
            [id, revision],
          );
          assert.equal(result.rowCount, 1);
        },
      };
      let vault = await createVault(pool, options);
      vault.registerRoutes(app);
      const requestInput = (kind: CredentialKind) => ({ origin, label: 'Website login', kind });
      const begin = async (id: string) => {
        await pool.query(
          "INSERT INTO tasks(id,owner_id) VALUES($1,'local-development') ON CONFLICT DO NOTHING",
          [id],
        );
        stages.set(id, 'identifier');
        const request = await vault.request(id, 'local-development', requestInput('identifier'));
        await pool.query("UPDATE tasks SET status='waiting_credentials' WHERE id=$1", [id]);
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
            await vault.fillSelected('complete', 'local-development', requestInput('password')),
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
          const otp = await vault.request('complete', 'local-development', requestInput('otp'));
          await pool.query("UPDATE tasks SET status='waiting_credentials' WHERE id='complete'");
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
            await vault.fillSelected('rejected', 'local-development', requestInput('password')),
            false,
          );
          assert.equal((await pool.query('SELECT * FROM vault_entries')).rowCount, before);
          assert.equal(injections.length, beforeInjections + 1);
          assert.equal(injections.at(-1)?.kind, 'password');
          const selected = (
            await pool.query("SELECT * FROM credential_account_selections WHERE task_id='rejected'")
          ).rows[0];
          assert.equal(selected.blocked, true);
          assert.equal(openCredential(key, selected).password, '');
          const count = injections.length;
          assert.equal(
            await vault.fillSelected('rejected', 'local-development', requestInput('password')),
            false,
          );
          assert.equal(injections.length, count);
          rejected = false;
          await begin('rejected');
          assert.equal(
            await vault.fillSelected('rejected', 'local-development', requestInput('password')),
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
            await vault.fillSelected('interrupted', 'local-development', requestInput('password')),
            false,
          );
          unavailable = false;
          const selected = (
            await pool.query(
              "SELECT * FROM credential_account_selections WHERE task_id='interrupted'",
            )
          ).rows[0];
          assert.equal(selected.blocked, true);
          assert.equal(openCredential(key, selected).password, '');
          const count = injections.length;
          assert.equal(
            await vault.fillSelected('interrupted', 'local-development', requestInput('password')),
            false,
          );
          assert.equal(injections.length, count);
        },
      );

      await t.test(
        'held passwords remain bound to owner, origin, revision and expiry',
        async () => {
          await begin('fences');
          const count = injections.length;
          assert.equal(
            await vault.fillSelected('fences', 'another-owner', requestInput('password')),
            undefined,
          );
          assert.equal(
            await vault.fillSelected('fences', 'local-development', {
              ...requestInput('password'),
              origin: 'https://other.example.test',
            }),
            undefined,
          );
          observedOrigin = 'https://other.example.test';
          assert.equal(
            await vault.fillSelected('fences', 'local-development', requestInput('password')),
            false,
          );
          observedOrigin = origin;
          await pool.query("UPDATE tasks SET revision=revision+1 WHERE id='fences'");
          assert.equal(
            await vault.fillSelected('fences', 'local-development', requestInput('password')),
            false,
          );
          await pool.query("UPDATE tasks SET revision=revision-1 WHERE id='fences'");
          await pool.query(
            "UPDATE credential_account_selections SET expires_at=now()-interval '1 second' WHERE task_id='fences'",
          );
          assert.equal(
            await vault.fillSelected('fences', 'local-development', requestInput('password')),
            false,
          );
          assert.equal(injections.length, count);
          await vault.resumePending();
          const expired = (
            await pool.query("SELECT * FROM credential_account_selections WHERE task_id='fences'")
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
