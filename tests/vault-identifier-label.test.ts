import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type { CredentialKind, LoginInspection } from '../src/ports/computer.ts';
import { createVault, sealCredential } from '../src/server/vault.ts';
import type { VaultLoginDetails, VaultLoginEntry } from '../src/shared/contracts.ts';

test(
  'Vault labels come from observed fields and survive staged sign-in and edits',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_vault_labels_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const key = randomBytes(32);
    const owner = 'local-development';
    const origin = 'https://accounts.example.test';
    const pages = new Map<string, { kind: CredentialKind; label: string; origin: string }>();
    await pool.query(`
      CREATE TABLE tasks(id text PRIMARY KEY,owner_id text NOT NULL,revision integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'running');
      CREATE TABLE vault_entries(id text PRIMARY KEY,owner_id text NOT NULL,label text NOT NULL,origin text NOT NULL,username_hint text NOT NULL,ciphertext text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
    `);
    const legacy = { id: randomUUID(), owner_id: owner, origin };
    const legacyCiphertext = sealCredential(key, legacy, {
      username: 'legacy@example.test',
      password: 'synthetic-legacy-password',
    });
    await pool.query(
      'INSERT INTO vault_entries(id,owner_id,label,origin,username_hint,ciphertext) VALUES($1,$2,$3,$4,$5,$6)',
      [legacy.id, owner, 'Legacy', origin, 'le…', legacyCiphertext],
    );
    const options = {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      inspect: async (taskId: string): Promise<LoginInspection> => {
        const page = pages.get(taskId)!;
        return {
          origin: page.origin,
          url: `${page.origin}/login`,
          fields: [{ kind: page.kind, label: page.label, selector: '#login' }],
          methods: [{ id: 'credentials', kind: 'credentials', label: 'Sign in', supported: true }],
        };
      },
      inject: async () => {},
      retry: async () => {},
      resume: async (taskId: string, revision: number) => {
        const result = await pool.query(
          "UPDATE tasks SET status='running',revision=revision+1 WHERE id=$1 AND revision=$2 AND status='waiting_credentials'",
          [taskId, revision],
        );
        assert.equal(result.rowCount, 1);
      },
    };
    let app = Fastify();
    let vault = await createVault(pool, options);
    vault.registerRoutes(app);
    const form = async (taskId: string, kind: CredentialKind, label: string, website = origin) => {
      pages.set(taskId, { kind, label, origin: website });
      const request = await vault.request(taskId, owner, {
        origin: website,
        kind,
        label: 'Untrusted model label',
      });
      await pool.query("UPDATE tasks SET status='waiting_credentials' WHERE id=$1", [taskId]);
      return request.url.replace('/vault/', '/api/credential-requests/');
    };
    const task = async () => {
      const id = randomUUID();
      await pool.query('INSERT INTO tasks(id,owner_id) VALUES($1,$2)', [id, owner]);
      return id;
    };
    const submit = async (url: string, payload: object) => {
      const result = await app.inject({ method: 'POST', url, payload });
      assert.equal(result.statusCode, 200, result.body);
    };
    try {
      await t.test(
        'manual defaults and legacy reads do not alter existing ciphertext',
        async () => {
          for (const [username, expected] of [
            ['taylor@example.test', 'Email'],
            ['taylor-name', 'Username'],
            ['not an email@example.test', 'Username'],
          ]) {
            const result = await app.inject({
              method: 'POST',
              url: '/api/vault',
              payload: { label: 'Manual', origin, username, password: 'synthetic-password' },
            });
            assert.equal(result.statusCode, 200);
            assert.equal(result.json<VaultLoginEntry>().identifierLabel, expected);
          }
          const details = await app.inject({
            method: 'POST',
            url: `/api/vault/${legacy.id}/details`,
          });
          assert.equal(details.json<VaultLoginDetails>().identifierLabel, 'Email');
          assert.equal(
            (await vault.list()).find((entry) => entry.id === legacy.id)?.identifierLabel,
            'Username',
          );
          assert.equal(
            (await pool.query('SELECT ciphertext FROM vault_entries WHERE id=$1', [legacy.id]))
              .rows[0].ciphertext,
            legacyCiphertext,
          );
        },
      );

      await t.test(
        'observed phone label survives restart, later password save and editing',
        async () => {
          const id = await task();
          await submit(await form(id, 'identifier', '  Phone\nnumber\u202e  '), {
            username: '+15555550123',
          });
          await app.close();
          app = Fastify();
          vault = await createVault(pool, options);
          vault.registerRoutes(app);
          await submit(await form(id, 'password', 'Password'), {
            label: 'Phone account',
            password: 'synthetic-phone-password',
          });
          const entry = (await vault.list()).find((item) => item.label === 'Phone account')!;
          assert.equal(entry.identifierLabel, 'Phone number');
          const updated = await app.inject({
            method: 'PATCH',
            url: `/api/vault/${entry.id}`,
            payload: { label: 'Renamed phone account', username: '+15555550124', password: '' },
          });
          assert.equal(updated.statusCode, 200);
          assert.equal(updated.json<VaultLoginEntry>().identifierLabel, 'Phone number');
          const details = await app.inject({
            method: 'POST',
            url: `/api/vault/${entry.id}/details`,
          });
          assert.equal(details.json<VaultLoginDetails>().identifierLabel, 'Phone number');
          assert.equal(details.json<VaultLoginDetails>().username, '+15555550124');
          assert.doesNotMatch(details.body, /synthetic-phone-password/);
        },
      );

      await t.test('labels are bounded and cannot be overridden by client fields', async () => {
        const id = await task();
        await submit(await form(id, 'identifier', `\u0000<${'Account '.repeat(20)}>\u200b`), {
          username: 'member-123',
        });
        await submit(await form(id, 'password', 'Secret'), {
          label: 'Bounded account',
          password: 'synthetic-password',
        });
        const entry = (await vault.list()).find((item) => item.label === 'Bounded account')!;
        assert.ok(entry.identifierLabel && entry.identifierLabel.length <= 80);
        assert.doesNotMatch(entry.identifierLabel!, /[<>\p{Cc}\p{Cf}]/u);
        for (const [method, url] of [
          ['POST', '/api/vault'],
          ['PATCH', `/api/vault/${entry.id}`],
        ] as const) {
          const response = await app.inject({
            method,
            url,
            payload: {
              label: 'Override',
              ...(method === 'POST' ? { origin } : {}),
              username: 'member',
              password: 'synthetic-password',
              identifierLabel: 'Forged',
            },
          });
          assert.equal(response.statusCode, 400);
          assert.doesNotMatch(response.body, /Forged|synthetic-password/);
        }
      });

      await t.test('staged labels cannot cross an exact website origin', async () => {
        const id = await task();
        await submit(await form(id, 'identifier', 'Phone number'), { username: '+15555550123' });
        await submit(await form(id, 'password', 'Password', 'https://other.example.test'), {
          label: 'Other website',
          username: 'other@example.test',
          password: 'synthetic-password',
        });
        const entry = (await vault.list()).find((item) => item.label === 'Other website')!;
        assert.equal(entry.identifierLabel, 'Email');
      });
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
