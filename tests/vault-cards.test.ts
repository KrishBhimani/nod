import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { registerLocalAccess } from '../src/server/access.ts';
import { createVault, sealCredential } from '../src/server/vault.ts';
import type { VaultCardEntry, VaultListEntry } from '../src/shared/contracts.ts';

test(
  'payment cards stay encrypted, owner-bound and separate from saved website logins',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_vault_cards_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const key = randomBytes(32);
    const owner = 'local-development';
    const headers = { host: 'localhost:4310', origin: 'http://localhost:4310' };
    const expiryYear = new Date().getUTCFullYear() + 3;
    const input = {
      kind: 'card',
      label: 'Everyday card',
      cardholder: 'Synthetic Cardholder',
      cardNumber: '4242 4242-4242 4242',
      expiryMonth: 12,
      expiryYear,
    };
    await pool.query(`
      CREATE TABLE tasks(id text PRIMARY KEY,owner_id text NOT NULL,revision integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'running');
      CREATE TABLE vault_entries(id text PRIMARY KEY,owner_id text NOT NULL,label text NOT NULL,origin text NOT NULL,username_hint text NOT NULL,ciphertext text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
    `);
    const login = { id: randomUUID(), owner_id: owner, origin: 'https://login.example.test' };
    const legacyCiphertext = sealCredential(key, login, {
      username: 'full-username@example.test',
      password: 'legacy-synthetic-password',
    });
    await pool.query(
      'INSERT INTO vault_entries(id,owner_id,label,origin,username_hint,ciphertext) VALUES($1,$2,$3,$4,$5,$6)',
      [login.id, owner, 'Legacy login', login.origin, 'fu…', legacyCiphertext],
    );
    const start = async (getKey: () => Promise<Buffer> = async () => key) => {
      const app = Fastify({ logger: false });
      registerLocalAccess(app, 4310);
      const vault = await createVault(pool, {
        keyStore: { id: 'synthetic', configured: true, getKey },
        inject: async () => assert.fail('Cards must never enter a website login.'),
        resume: async () => assert.fail('Card management must not resume a task.'),
        retry: async () => assert.fail('Card management must not retry a task.'),
      });
      vault.registerRoutes(app);
      return { app, vault };
    };
    let { app, vault } = await start();
    const create = async (payload: Record<string, unknown> = input) => {
      const response = await app.inject({ method: 'POST', url: '/api/vault', headers, payload });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<VaultCardEntry>();
    };
    const read = (id: string, field: string, instance: FastifyInstance = app) =>
      instance.inject({ method: 'POST', url: `/api/vault/${id}/${field}`, headers, payload: {} });
    const update = (
      id: string,
      payload: Record<string, unknown>,
      instance: FastifyInstance = app,
    ) => instance.inject({ method: 'PATCH', url: `/api/vault/${id}`, headers, payload });
    try {
      const first = await create();
      const second = await create({
        ...input,
        label: 'Travel card',
        cardNumber: '378282246310005',
      });
      await t.test(
        'creation and private lists expose useful identity but never payment or login secrets',
        async () => {
          assert.equal(first.kind, 'card');
          assert.equal(first.brand, 'Visa');
          assert.equal(first.last4, '4242');
          assert.equal(second.brand, 'American Express');
          assert.equal(second.last4, '0005');
          const listed = await app.inject({ url: '/api/vault', headers });
          assert.equal(listed.headers['cache-control'], 'no-store');
          const entries = listed.json<VaultListEntry[]>();
          assert.equal(entries.length, 3);
          const account = entries.find((entry) => entry.kind === 'login');
          assert.equal(account?.kind === 'login' && account.username, 'full-username@example.test');
          assert.doesNotMatch(
            listed.body,
            /4242424242424242|378282246310005|Synthetic Cardholder|legacy-synthetic-password|ciphertext/,
          );
          const stored = (await pool.query('SELECT * FROM vault_cards')).rows;
          assert.doesNotMatch(
            JSON.stringify(stored),
            /4242424242424242|378282246310005|Synthetic Cardholder/,
          );
          assert.equal((await vault.list()).length, 1);
          assert.doesNotMatch(
            JSON.stringify(await vault.list()),
            /full-username|card|legacy-synthetic-password/,
          );
          assert.equal(
            (await read(login.id, 'password')).json().password,
            'legacy-synthetic-password',
          );
          assert.equal(
            (await pool.query('SELECT ciphertext FROM vault_entries WHERE id=$1', [login.id]))
              .rows[0].ciphertext,
            legacyCiphertext,
          );
        },
      );
      await t.test('details and card number are separate explicit no-store reads', async () => {
        const details = await read(first.id, 'details');
        assert.equal(details.statusCode, 200);
        assert.deepEqual(details.json(), {
          ...first,
          cardholder: input.cardholder,
          hasSecurityCode: false,
        });
        assert.doesNotMatch(details.body, /4242424242424242/);
        const number = await read(first.id, 'card-number');
        assert.deepEqual(number.json(), { cardNumber: '4242424242424242' });
        for (const result of [details, number]) {
          assert.equal(result.headers['cache-control'], 'no-store');
          assert.equal(result.headers['referrer-policy'], 'no-referrer');
        }
        assert.equal((await read(first.id, 'password')).statusCode, 404);
        assert.equal((await read(first.id, 'security-code')).statusCode, 404);
        assert.equal((await read(login.id, 'card-number')).statusCode, 404);
        assert.equal(
          (await app.inject({ url: `/api/vault/${first.id}/card-number`, headers })).statusCode,
          404,
        );
      });
      await t.test(
        'optional security codes stay encrypted, reveal separately and preserve or remove explicitly',
        async () => {
          const card = await create({ ...input, label: 'Code card', securityCode: ' 314 ' });
          const details = await read(card.id, 'details');
          assert.equal(details.json().hasSecurityCode, true);
          assert.equal('securityCode' in details.json(), false);
          assert.equal('securityCode' in card, false);
          assert.equal('hasSecurityCode' in card, false);
          const stored = (await pool.query('SELECT * FROM vault_cards WHERE id=$1', [card.id]))
            .rows[0];
          assert.equal('security_code' in stored, false);
          assert.equal('securityCode' in stored, false);
          assert.doesNotMatch(
            Buffer.from(stored.ciphertext, 'base64').toString('utf8'),
            /securityCode|Synthetic Cardholder|4242424242424242/,
          );
          const code = await read(card.id, 'security-code');
          assert.deepEqual(code.json(), { securityCode: '314' });
          assert.equal(code.headers['cache-control'], 'no-store');
          assert.equal(code.headers['referrer-policy'], 'no-referrer');
          assert.deepEqual((await read(card.id, 'card-number')).json(), {
            cardNumber: '4242424242424242',
          });
          const listed = (await app.inject({ url: '/api/vault', headers })).json<
            VaultListEntry[]
          >();
          assert.ok(
            listed.every((entry) => !('securityCode' in entry) && !('hasSecurityCode' in entry)),
          );
          assert.equal((await read(login.id, 'security-code')).statusCode, 404);
          assert.equal(
            (await app.inject({ url: `/api/vault/${card.id}/security-code`, headers })).statusCode,
            404,
          );
          assert.equal(
            (
              await app.inject({
                method: 'POST',
                url: `/api/vault/${card.id}/security-code`,
                headers,
                payload: { ownerId: owner },
              })
            ).statusCode,
            400,
          );
          assert.equal(
            (
              await app.inject({
                method: 'POST',
                url: `/api/vault/${card.id}/security-code`,
                headers: { ...headers, origin: 'https://attacker.example' },
                payload: {},
              })
            ).statusCode,
            403,
          );
          for (const securityCode of [undefined, '']) {
            const response = await update(card.id, {
              ...input,
              ...(securityCode === undefined ? {} : { securityCode }),
            });
            assert.equal(response.statusCode, 200);
            assert.equal('securityCode' in response.json(), false);
            assert.equal((await read(card.id, 'security-code')).json().securityCode, '314');
          }
          assert.equal((await update(card.id, { ...input, securityCode: '2718' })).statusCode, 200);
          await app.close();
          ({ app, vault } = await start());
          assert.deepEqual((await read(card.id, 'security-code')).json(), { securityCode: '2718' });
          assert.equal((await update(card.id, { ...input, securityCode: null })).statusCode, 200);
          assert.equal((await read(card.id, 'details')).json().hasSecurityCode, false);
          const removed = await read(card.id, 'security-code');
          assert.equal(removed.statusCode, 404);
          assert.deepEqual(removed.json(), { error: 'This card has no saved security code.' });
          assert.equal((await read(card.id, 'card-number')).json().cardNumber, '4242424242424242');
        },
      );
      await t.test(
        'cards never appear in login choices, invitations or automatic fills',
        async () => {
          const taskId = randomUUID();
          await pool.query('INSERT INTO tasks(id,owner_id) VALUES($1,$2)', [taskId, owner]);
          const requested = await vault.request(taskId, owner, {
            origin: 'https://cards.example.test',
            label: 'Login',
            kind: 'password',
            usernameSelector: '#username',
            passwordSelector: '#password',
          });
          assert.equal(requested.invitation.savedLoginAvailable, false);
          const token = requested.url.split('/').at(-1)!;
          const description = await app.inject({
            url: `/api/credential-requests/${token}`,
            headers,
          });
          assert.deepEqual(description.json().savedEntries, []);
          await assert.rejects(
            vault.fillSaved(taskId, owner, first.id, {
              origin: 'https://cards.example.test',
              label: 'Login',
              kind: 'password',
              passwordSelector: '#password',
            }),
          );
        },
      );
      await t.test(
        'edits preserve an omitted number, replace it explicitly and survive restart',
        async () => {
          for (const cardNumber of [undefined, '']) {
            const { cardNumber: _number, ...fields } = input;
            const updated = await update(first.id, {
              ...fields,
              label: 'Renamed card',
              ...(cardNumber === undefined ? {} : { cardNumber }),
            });
            assert.equal(updated.statusCode, 200);
            assert.equal(updated.json().label, 'Renamed card');
            assert.equal(updated.headers['cache-control'], 'no-store');
            assert.doesNotMatch(updated.body, /4242424242424242|Synthetic Cardholder/);
            assert.equal(
              (await read(first.id, 'card-number')).json().cardNumber,
              '4242424242424242',
            );
          }
          assert.equal(
            (
              await update(first.id, {
                ...input,
                cardNumber: '5555-5555-5555-4444',
                cardholder: 'Updated Holder',
              })
            ).statusCode,
            200,
          );
          await app.close();
          ({ app, vault } = await start());
          const details = (await read(first.id, 'details')).json();
          assert.equal(details.brand, 'Mastercard');
          assert.equal(details.last4, '4444');
          assert.equal(details.cardholder, 'Updated Holder');
          assert.equal((await read(first.id, 'card-number')).json().cardNumber, '5555555555554444');
          assert.equal((await read(second.id, 'card-number')).json().cardNumber, '378282246310005');
        },
      );
      await t.test(
        'invalid card values and ownership or kind overrides fail without exposing input',
        async () => {
          for (const overrides of [
            { cardNumber: '4242424242424241' },
            { cardNumber: '0000000000000000' },
            { cardNumber: '4242.4242.4242.4242' },
            { cardNumber: '42' },
            { cardNumber: '4'.repeat(41) },
            { expiryMonth: 0 },
            { expiryMonth: 13 },
            { expiryMonth: 1.5 },
            { expiryYear: new Date().getUTCFullYear() - 1 },
            { expiryYear: new Date().getUTCFullYear() + 31 },
            { expiryYear: '2030' },
            { label: '' },
            { cardholder: '' },
            { cardholder: 'x'.repeat(201) },
            { cvv: '123' },
            { securityCode: '12' },
            { securityCode: '12345' },
            { securityCode: 'a12' },
            { securityCode: 123 },
            { ownerId: 'foreign' },
            { origin: 'https://attacker.example' },
          ]) {
            const invalid = { ...input, ...overrides };
            for (const response of [
              await app.inject({ method: 'POST', url: '/api/vault', headers, payload: invalid }),
              await update(first.id, invalid),
            ]) {
              assert.equal(response.statusCode, 400);
              assert.doesNotMatch(
                response.body,
                /4242|attacker|Synthetic Cardholder|foreign|cvv|5555555555554444/,
              );
            }
          }
          assert.equal((await update(login.id, input)).statusCode, 404);
          assert.equal(
            (await update(first.id, { label: 'Changed kind', username: 'user' })).statusCode,
            404,
          );
          assert.equal((await read('invalid-id', 'card-number')).statusCode, 400);
          const forbidden = await app.inject({
            method: 'POST',
            url: `/api/vault/${first.id}/card-number`,
            headers,
            payload: { ownerId: owner },
          });
          assert.equal(forbidden.statusCode, 400);
          for (const changedHeaders of [
            { ...headers, origin: 'https://attacker.example' },
            { ...headers, host: 'attacker.example:4310' },
            { ...headers, 'sec-fetch-site': 'cross-site' },
          ])
            assert.equal(
              (
                await app.inject({
                  method: 'POST',
                  url: `/api/vault/${first.id}/card-number`,
                  headers: changedHeaders,
                  payload: {},
                })
              ).statusCode,
              403,
            );
        },
      );
      await t.test('foreign records and transplanted ciphertext cannot reveal a card', async () => {
        const foreign = await create({ ...input, label: 'Foreign card' });
        await pool.query('UPDATE vault_cards SET owner_id=$2 WHERE id=$1', [
          foreign.id,
          'foreign-owner',
        ]);
        assert.equal((await read(foreign.id, 'card-number')).statusCode, 404);
        assert.equal((await read(foreign.id, 'security-code')).statusCode, 404);
        assert.equal((await update(foreign.id, input)).statusCode, 404);
        const transplanted = await create({ ...input, label: 'Transplanted card' });
        await pool.query(
          'UPDATE vault_cards SET ciphertext=(SELECT ciphertext FROM vault_cards WHERE id=$2) WHERE id=$1',
          [transplanted.id, first.id],
        );
        for (const result of [
          await read(transplanted.id, 'card-number'),
          await read(transplanted.id, 'security-code'),
          await update(transplanted.id, input),
        ]) {
          assert.equal(result.statusCode, 500);
          assert.deepEqual(result.json(), { error: 'This saved card could not be opened.' });
        }
        await app.inject({ method: 'DELETE', url: `/api/vault/${foreign.id}`, headers });
        assert.equal(
          (await pool.query('SELECT id FROM vault_cards WHERE id=$1', [foreign.id])).rowCount,
          1,
        );
      });
      await t.test(
        'key failures and pending-key races cannot reveal stale owners or overwrite the latest number',
        async () => {
          const unavailable = await start(async () => {
            throw new Error('private-key-error');
          });
          try {
            for (const response of [
              await read(first.id, 'card-number', unavailable.app),
              await read(first.id, 'security-code', unavailable.app),
              await update(first.id, input, unavailable.app),
            ]) {
              assert.equal(response.statusCode, 503);
              assert.doesNotMatch(
                response.body,
                /private-key-error|4242424242424242|5555555555554444/,
              );
            }
          } finally {
            await unavailable.app.close();
          }
          for (const change of [
            'number',
            'code',
            'owner-code',
            'delete-code',
            'owner-read',
            'delete-read',
            'owner-update',
            'delete-update',
          ]) {
            const record = await create({ ...input, securityCode: '314', label: `Race ${change}` });
            let release!: (value: Buffer) => void;
            let reached!: () => void;
            const started = new Promise<void>((resolve) => {
              reached = resolve;
            });
            const waiting = new Promise<Buffer>((resolve) => {
              release = resolve;
            });
            const delayed = await start(async () => {
              reached();
              return waiting;
            });
            try {
              const pending =
                change === 'number' || change === 'code' || change.endsWith('update')
                  ? update(
                      record.id,
                      { ...input, cardNumber: '', label: 'Race renamed' },
                      delayed.app,
                    ).then((value) => value)
                  : read(
                      record.id,
                      change.endsWith('code') ? 'security-code' : 'card-number',
                      delayed.app,
                    ).then((value) => value);
              await started;
              if (change === 'number')
                assert.equal(
                  (await update(record.id, { ...input, cardNumber: '5555555555554444' }))
                    .statusCode,
                  200,
                );
              else if (change === 'code')
                assert.equal(
                  (await update(record.id, { ...input, securityCode: '2718' })).statusCode,
                  200,
                );
              else if (change.startsWith('owner'))
                await pool.query('UPDATE vault_cards SET owner_id=$2 WHERE id=$1', [
                  record.id,
                  'foreign-owner',
                ]);
              else await pool.query('DELETE FROM vault_cards WHERE id=$1', [record.id]);
              release(key);
              const result = await pending;
              assert.equal(result.statusCode, change === 'number' || change === 'code' ? 200 : 404);
              if (change === 'number')
                assert.equal(
                  (await read(record.id, 'card-number')).json().cardNumber,
                  '5555555555554444',
                );
              else if (change === 'code')
                assert.equal((await read(record.id, 'security-code')).json().securityCode, '2718');
              else assert.doesNotMatch(result.body, /4242424242424242|314/);
            } finally {
              release(key);
              await delayed.app.close();
            }
          }
        },
      );
      await t.test('private username lists recheck ownership after key access', async () => {
        let release!: (value: Buffer) => void;
        let reached!: () => void;
        const started = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const waiting = new Promise<Buffer>((resolve) => {
          release = resolve;
        });
        const delayed = await start(async () => {
          reached();
          return waiting;
        });
        try {
          const response = delayed.app
            .inject({ url: '/api/vault', headers })
            .then((value) => value);
          await started;
          await pool.query('UPDATE vault_entries SET owner_id=$2 WHERE id=$1', [
            login.id,
            'foreign-owner',
          ]);
          release(key);
          const listed = await response;
          assert.equal(listed.statusCode, 200);
          assert.doesNotMatch(listed.body, /full-username@example|legacy-synthetic-password/);
          assert.equal(
            listed.json<VaultListEntry[]>().some((entry) => entry.id === login.id),
            false,
          );
        } finally {
          release(key);
          await delayed.app.close();
          await pool.query('UPDATE vault_entries SET owner_id=$2 WHERE id=$1', [login.id, owner]);
        }
      });
      await t.test('deleting a card leaves other cards and legacy logins intact', async () => {
        assert.equal(
          (await app.inject({ method: 'DELETE', url: `/api/vault/${first.id}`, headers }))
            .statusCode,
          200,
        );
        assert.equal((await read(first.id, 'card-number')).statusCode, 404);
        assert.equal((await read(second.id, 'card-number')).json().cardNumber, '378282246310005');
        assert.equal(
          (await read(login.id, 'password')).json().password,
          'legacy-synthetic-password',
        );
      });
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
