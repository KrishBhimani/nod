import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { credentialOrigin, createVault, openCredential, sealCredential } from '../src/server/vault.ts';

test('vault encryption binds the secret to its record, owner, and exact origin', () => {
  const key = randomBytes(32);
  const entry = { id: randomUUID(), owner_id: 'local-development', origin: 'https://example.com' };
  const secret = { username: 'private@example.com', password: 'do-not-print-this-password' };
  const ciphertext = sealCredential(key, entry, secret);
  assert.equal(ciphertext.includes(secret.password), false);
  assert.deepEqual(openCredential(key, { ...entry, ciphertext }), secret);
  for (const replacement of [{ id: randomUUID() }, { owner_id: 'another-owner' }, { origin: 'https://other.example.com' }]) {
    assert.throws(() => openCredential(key, { ...entry, ...replacement, ciphertext }));
  }
  const damaged = Buffer.from(ciphertext, 'base64');
  damaged[damaged.length - 1] ^= 1;
  assert.throws(() => openCredential(key, { ...entry, ciphertext: damaged.toString('base64') }));
  assert.throws(() => openCredential(randomBytes(32), { ...entry, ciphertext }));
});

test('vault accepts exact HTTPS origins and explicit local development origins', () => {
  assert.equal(credentialOrigin('https://EXAMPLE.com:443/'), 'https://example.com');
  assert.equal(credentialOrigin('http://127.0.0.1:4310'), 'http://127.0.0.1:4310');
  for (const invalid of ['http://example.com', 'file:///tmp/a', 'https://user:password@example.com', 'https://example.com/login', 'https://example.com?key=secret', 'https://example.com/#fragment']) {
    assert.throws(() => credentialOrigin(invalid));
  }
});

test('vault stores only encrypted secrets, isolates requests, consumes once, and resumes after injection', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const app = Fastify();
  let injected = 0;
  let resumed = 0;
  let complete: () => void = () => {};
  let started: () => void = () => {};
  const injectionStarted = new Promise<void>(resolve => { started = resolve; });
  const injectionComplete = new Promise<void>(resolve => { complete = resolve; });
  const vault = await createVault(pool, {
    masterKey: randomBytes(32),
    inject: async input => {
      assert.equal(input.origin, 'https://example.com');
      assert.equal(input.password, 'secret-password');
      injected++;
      started();
      await injectionComplete;
    },
    resume: async () => { resumed++; },
  });
  vault.registerRoutes(app);
  try {
    const input = { origin: 'https://example.com', label: 'Example', kind: 'password' as const, passwordSelector: '#password' };
    const hidden = await vault.request('other-task', 'other-user', input);
    assert.equal((await app.inject({ url: hidden.url.replace('/credentials/', '/api/credential-requests/') })).statusCode, 404);
    const result = await vault.request('task-1', 'local-development', input);
    const url = result.url.replace('/credentials/', '/api/credential-requests/');
    const form = await app.inject({ url });
    assert.equal(form.statusCode, 200);
    assert.equal(form.headers['cache-control'], 'no-store');
    const first = app.inject({ method: 'POST', url, payload: { username: 'person@example.com', password: 'secret-password' } });
    await injectionStarted;
    assert.equal(resumed, 0);
    assert.equal((await app.inject({ method: 'POST', url, payload: { password: 'second-secret' } })).statusCode, 409);
    complete();
    assert.equal((await first).statusCode, 200);
    assert.equal(injected, 1);
    assert.equal(resumed, 1);
    assert.equal((await app.inject({ method: 'POST', url, payload: { password: 'secret-password' } })).statusCode, 409);
    const metadata = await app.inject({ url: '/api/vault' });
    assert.equal(metadata.json().length, 1);
    assert.equal(metadata.body.includes('secret-password'), false);
    assert.equal(metadata.body.includes('person@example.com'), false);
    const stored = await pool.query('SELECT * FROM vault_entries');
    assert.equal(JSON.stringify(stored.rows).includes('secret-password'), false);
    await assert.rejects(vault.fillSaved('task-2', 'another-owner', stored.rows[0].id, input));
    await assert.rejects(vault.fillSaved('task-2', 'local-development', stored.rows[0].id, { ...input, origin: 'https://other.example.com' }));
    await vault.fillSaved('task-2', 'local-development', stored.rows[0].id, input);
    assert.equal(injected, 2);
    assert.equal(resumed, 1);
    await assert.rejects(vault.fillSaved('task-2', 'local-development', stored.rows[0].id, input), /fresh credentials/);
    await assert.rejects(vault.fillSaved('task-1', 'local-development', stored.rows[0].id, input), /fresh credentials/);
    assert.equal(injected, 2);
    const requests = await pool.query('SELECT * FROM credential_requests');
    assert.equal(JSON.stringify(requests.rows).includes('secret-password'), false);
    assert.equal(JSON.stringify(requests.rows).includes(result.url.split('/').at(-1)!), false);
    const expired = await vault.request('expired-task', 'local-development', input);
    await pool.query("UPDATE credential_requests SET expires_at = now() - interval '1 second' WHERE task_id = 'expired-task'");
    const expiredUrl = expired.url.replace('/credentials/', '/api/credential-requests/');
    assert.equal((await app.inject({ url: expiredUrl })).json().status, 'expired');
    assert.equal((await app.inject({ method: 'POST', url: expiredUrl, payload: { password: 'expired-secret' } })).statusCode, 409);
  } finally {
    complete();
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('OTP failures return safe errors, allow fresh input, and never persist the code', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const app = Fastify();
  let calls = 0;
  let resumeAttempts = 0;
  const vault = await createVault(pool, {
    inject: async input => { calls++; if (calls === 1) throw new Error(`Provider leaked ${input.code}`); },
    resume: async () => { resumeAttempts++; if (resumeAttempts === 1) throw new Error('Queue temporarily unavailable'); },
  });
  vault.registerRoutes(app);
  try {
    const request = await vault.request('otp-task', 'local-development', { origin: 'https://example.com', label: 'Verification', kind: 'otp', passwordSelector: '#code' });
    const url = request.url.replace('/credentials/', '/api/credential-requests/');
    const failed = await app.inject({ method: 'POST', url, payload: { code: '123456' } });
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.body.includes('123456'), false);
    assert.equal((await app.inject({ url })).json().status, 'pending');
    assert.equal((await app.inject({ method: 'POST', url, payload: { code: '789012' } })).statusCode, 200);
    assert.equal((await pool.query('SELECT * FROM credential_requests WHERE resume_pending = true')).rowCount, 1);
    await vault.resumePending();
    assert.equal((await pool.query('SELECT * FROM credential_requests WHERE resume_pending = true')).rowCount, 0);
    assert.equal(calls, 2);
    assert.equal((await pool.query('SELECT * FROM vault_entries')).rowCount, 0);
    assert.equal(JSON.stringify((await pool.query('SELECT * FROM credential_requests')).rows).includes('789012'), false);
  } finally {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('failed autofill requires fresh input and interrupted forms recover after restart', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  let app = Fastify();
  let attempts = 0;
  const options = {
    masterKey: randomBytes(32),
    inject: async () => { attempts++; if (attempts === 1) throw new Error('Synthetic injection failure'); },
    resume: async () => {},
  };
  const vault = await createVault(pool, options);
  vault.registerRoutes(app);
  try {
    const saved = await app.inject({ method: 'POST', url: '/api/vault', payload: { label: 'Example', origin: 'https://example.com', username: 'person', password: 'old-password' } });
    const input = { origin: 'https://example.com', label: 'Example', kind: 'password' as const, passwordSelector: '#password' };
    await assert.rejects(vault.fillSaved('task-retry', 'local-development', saved.json().id, input));
    await assert.rejects(vault.fillSaved('task-retry', 'local-development', saved.json().id, input), /fresh credentials/);
    assert.equal(attempts, 1);
    const retry = await vault.request('task-retry', 'local-development', input);
    const response = await app.inject({ method: 'POST', url: retry.url.replace('/credentials/', '/api/credential-requests/'), payload: { username: 'person', password: 'replacement-password' } });
    assert.equal(response.statusCode, 200);
    assert.equal(attempts, 2);
    const interrupted = await vault.request('task-interrupted', 'local-development', input);
    await pool.query("UPDATE credential_requests SET status = 'processing' WHERE task_id = 'task-interrupted'");
    await app.close();
    app = Fastify();
    const restarted = await createVault(pool, options);
    restarted.registerRoutes(app);
    const url = interrupted.url.replace('/credentials/', '/api/credential-requests/');
    assert.equal((await app.inject({ url })).json().status, 'pending');
    assert.equal((await app.inject({ method: 'POST', url, payload: { password: 'fresh-after-restart' } })).statusCode, 200);
    assert.equal(attempts, 3);
    await assert.rejects(restarted.fillSaved('task-interrupted', 'local-development', saved.json().id, input), /fresh credentials/);
  } finally {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
