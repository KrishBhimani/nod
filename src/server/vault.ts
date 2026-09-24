import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { CredentialRequest, RuntimeContext, VaultEntry } from '../shared/contracts.ts';

const run = promisify(execFile);
const owner = 'local-development';
const service = 'dev.sidekick.vault';
const account = 'master-key-v1';
const passwordInput = z.object({
  label: z.string().trim().min(1).max(100),
  origin: z.string().max(2048),
  username: z.string().max(320),
  password: z.string().min(1).max(8192),
}).strict();
const submissionInput = z.object({
  username: z.string().max(320).optional(),
  password: z.string().min(1).max(8192).optional(),
  code: z.string().min(1).max(100).optional(),
}).strict();
const requestInput = z.object({
  origin: z.string().max(2048), label: z.string().trim().min(1).max(100),
  kind: z.enum(['password', 'otp']),
  usernameSelector: z.string().min(1).max(2048).optional(),
  passwordSelector: z.string().min(1).max(2048),
  submitSelector: z.string().min(1).max(2048).optional(),
}).strict();
type CredentialInput = Parameters<RuntimeContext['requestCredential']>[0];
export type CredentialInjection = CredentialInput & {
  taskId: string; username?: string; password?: string; code?: string;
};
type VaultOptions = {
  resume(taskId: string): Promise<void>;
  inject(input: CredentialInjection): Promise<unknown>;
  masterKey?: Buffer;
};
type EntryRow = {
  id: string; owner_id: string; label: string; origin: string;
  username_hint: string; ciphertext: string; updated_at: Date;
};
type RequestRow = {
  id: string; task_id: string; owner_id: string; origin: string; label: string;
  kind: 'password' | 'otp'; status: 'pending' | 'processing' | 'filled';
  selectors: CredentialInput; expires_at: Date;
};

class VaultError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

export function credentialOrigin(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new VaultError('Enter a valid website origin.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new VaultError('Use an HTTPS origin, such as https://example.com, without a path.');
  }
  return url.origin;
}

function binding(entry: Pick<EntryRow, 'id' | 'owner_id' | 'origin'>) {
  return Buffer.from(JSON.stringify(['sidekick-vault-v1', entry.owner_id, entry.origin, entry.id]));
}

export function sealCredential(key: Buffer, entry: Pick<EntryRow, 'id' | 'owner_id' | 'origin'>, secret: { username: string; password: string }) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(binding(entry));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ username: secret.username, password: secret.password }), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function openCredential(key: Buffer, entry: Pick<EntryRow, 'id' | 'owner_id' | 'origin' | 'ciphertext'>) {
  const data = Buffer.from(entry.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAAD(binding(entry));
  decipher.setAuthTag(data.subarray(12, 28));
  return submissionInput.required({ username: true, password: true }).parse(
    JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')),
  );
}

function metadata(entry: EntryRow): VaultEntry {
  return { id: entry.id, label: entry.label, origin: entry.origin, usernameHint: entry.username_hint, updatedAt: new Date(entry.updated_at).toISOString() };
}

function parseKey(value: string) {
  const key = Buffer.from(value.trim(), 'base64');
  if (key.length !== 32 || key.toString('base64') !== value.trim()) {
    throw new VaultError('SIDEKICK_VAULT_KEY must be a base64-encoded 32-byte key.', 503);
  }
  return key;
}

async function loadMasterKey(): Promise<Buffer> {
  if (process.env.SIDEKICK_VAULT_KEY) return parseKey(process.env.SIDEKICK_VAULT_KEY);
  if (process.platform !== 'darwin') throw new VaultError('Configure SIDEKICK_VAULT_KEY before saving credentials.', 503);
  try {
    const { stdout } = await run('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w']);
    return parseKey(stdout.trim());
  } catch (error) {
    if (error instanceof VaultError) throw error;
    if ((error as { code?: number }).code !== 44) throw new VaultError('The macOS Keychain could not be opened.', 503);
  }
  const key = randomBytes(32);
  try {
    await run('/usr/bin/security', ['add-generic-password', '-s', service, '-a', account, '-w', key.toString('base64')]);
  } catch {
    key.fill(0);
    throw new VaultError('The macOS Keychain could not save the vault key.', 503);
  }
  return key;
}

export async function createVault(pool: Pool, options: VaultOptions) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_entries (
      id text PRIMARY KEY, owner_id text NOT NULL, label text NOT NULL, origin text NOT NULL,
      username_hint text NOT NULL, ciphertext text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS credential_requests (
      id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, task_id text NOT NULL, owner_id text NOT NULL,
      origin text NOT NULL, label text NOT NULL, kind text NOT NULL, status text NOT NULL DEFAULT 'pending',
      selectors jsonb NOT NULL, expires_at timestamptz NOT NULL, resume_pending boolean NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS credential_autofill_attempts (
      task_id text NOT NULL, owner_id text NOT NULL, origin text NOT NULL, entry_id text NOT NULL,
      attempted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(task_id,owner_id,origin)
    );
    CREATE INDEX IF NOT EXISTS vault_entries_owner ON vault_entries(owner_id);
    UPDATE credential_requests SET status = 'pending' WHERE status = 'processing';
  `);
  let keyPromise: Promise<Buffer> | undefined;
  const key = () => {
    keyPromise ??= (options.masterKey ? Promise.resolve(options.masterKey) : loadMasterKey()).catch(error => {
      keyPromise = undefined;
      throw error;
    });
    return keyPromise;
  };
  let resuming = false;
  async function resumePending() {
    if (resuming) return;
    resuming = true;
    try {
      const { rows } = await pool.query<RequestRow>('SELECT * FROM credential_requests WHERE resume_pending = true');
      for (const row of rows) {
        try {
          await options.resume(row.task_id);
          await pool.query('UPDATE credential_requests SET resume_pending = false WHERE id = $1', [row.id]);
        } catch { }
      }
    } finally { resuming = false; }
  }
  const timer = setInterval(() => { void resumePending().catch(() => {}); }, 5000);
  timer.unref();

  async function list(ownerId = owner) {
    const { rows } = await pool.query<EntryRow>('SELECT * FROM vault_entries WHERE owner_id = $1 ORDER BY updated_at DESC', [ownerId]);
    return rows.map(metadata);
  }

  async function save(ownerId: string, raw: unknown) {
    const input = passwordInput.parse(raw);
    const entry = { id: randomUUID(), owner_id: ownerId, origin: credentialOrigin(input.origin) };
    const ciphertext = sealCredential(await key(), entry, input);
    const hint = input.username ? `${input.username.slice(0, 2)}…` : '';
    const { rows } = await pool.query<EntryRow>(
      'INSERT INTO vault_entries (id, owner_id, label, origin, username_hint, ciphertext) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [entry.id, ownerId, input.label, entry.origin, hint, ciphertext],
    );
    return metadata(rows[0]);
  }

  async function request(taskId: string, ownerId: string, raw: CredentialInput): Promise<{ url: string }> {
    const input = requestInput.parse(raw);
    const origin = credentialOrigin(input.origin);
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    await pool.query(
      `INSERT INTO credential_requests (id, token_hash, task_id, owner_id, origin, label, kind, selectors, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now() + interval '10 minutes')`,
      [randomUUID(), hash, taskId, ownerId, origin, input.label, input.kind, JSON.stringify({ ...input, origin })],
    );
    return { url: `/credentials/${token}` };
  }

  function tokenHash(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new VaultError('Credential request not found.', 404);
    return createHash('sha256').update(token).digest('hex');
  }

  async function describe(token: string): Promise<CredentialRequest> {
    const { rows } = await pool.query<RequestRow>(
      'SELECT * FROM credential_requests WHERE token_hash = $1 AND owner_id = $2', [tokenHash(token), owner],
    );
    const row = rows[0];
    if (!row) throw new VaultError('Credential request not found.', 404);
    return {
      id: token, taskId: row.task_id, origin: row.origin, label: row.label, kind: row.kind,
      status: row.status === 'filled' ? 'filled' : new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : 'pending',
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }

  async function submit(token: string, raw: unknown) {
    const input = submissionInput.parse(raw);
    const { rows } = await pool.query<RequestRow>(
      `UPDATE credential_requests SET status = 'processing' WHERE token_hash = $1 AND owner_id = $2
       AND status = 'pending' AND expires_at > now() RETURNING *`, [tokenHash(token), owner],
    );
    const row = rows[0];
    if (!row) throw new VaultError('This request is expired, already used, or being filled.', 409);
    try {
      if (row.kind === 'password' && !input.password) throw new VaultError('Enter the password.');
      if (row.kind === 'otp' && !input.code) throw new VaultError('Enter the verification code.');
      if (row.kind === 'password') await key();
      await options.inject({
        ...row.selectors, origin: row.origin, kind: row.kind, taskId: row.task_id,
        ...(row.kind === 'otp' ? { code: input.code } : { username: input.username ?? '', password: input.password }),
      });
      if (row.kind === 'password') {
        await save(row.owner_id, { label: row.label, origin: row.origin, username: input.username ?? '', password: input.password });
      }
      await pool.query("UPDATE credential_requests SET status = 'filled', resume_pending = true WHERE id = $1", [row.id]);
    } catch (error) {
      await pool.query("UPDATE credential_requests SET status = 'pending' WHERE id = $1 AND status = 'processing'", [row.id]);
      if (error instanceof VaultError) throw error;
      throw new VaultError('Credential entry failed. Check the website and complete this form again.', 502);
    }
    await resumePending();
    return { ok: true };
  }

  async function fillSaved(taskId: string, ownerId: string, id: string, input: CredentialInput) {
    const origin = credentialOrigin(input.origin);
    const { rows } = await pool.query<EntryRow>(
      'SELECT * FROM vault_entries WHERE id = $1 AND owner_id = $2 AND origin = $3', [id, ownerId, origin],
    );
    if (!rows[0] || input.kind !== 'password') throw new VaultError('No saved password is available for this website.', 404);
    const attempt = await pool.query(
      `INSERT INTO credential_autofill_attempts (task_id,owner_id,origin,entry_id)
       SELECT $1,$2,$3,$4 WHERE NOT EXISTS (
         SELECT 1 FROM credential_requests WHERE task_id = $1 AND owner_id = $2 AND origin = $3
         AND kind = 'password' AND status = 'filled'
       ) ON CONFLICT DO NOTHING RETURNING task_id`, [taskId, ownerId, origin, id],
    );
    if (!attempt.rowCount) throw new VaultError('Enter fresh credentials to retry this website.', 409);
    const secret = openCredential(await key(), rows[0]);
    await options.inject({ ...requestInput.parse(input), taskId, origin, username: secret.username, password: secret.password });
  }

  function registerRoutes(app: FastifyInstance) {
    app.addHook('onClose', async () => { clearInterval(timer); });
    app.register(async scope => {
      scope.addHook('onSend', async (_request, reply, payload) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        return payload;
      });
      scope.setErrorHandler((error, _request, reply) => {
        const status = error instanceof VaultError ? error.statusCode : error instanceof z.ZodError ? 400 : 500;
        reply.code(status).send({ error: error instanceof VaultError ? error.message : status === 400 ? 'Check the credential fields.' : 'The vault request could not be completed.' });
      });
      scope.get('/api/vault', async () => list());
      scope.post('/api/vault', { bodyLimit: 16_384 }, async request => save(owner, request.body));
      scope.delete<{ Params: { id: string } }>('/api/vault/:id', async request => {
        await pool.query('DELETE FROM vault_entries WHERE id = $1 AND owner_id = $2', [request.params.id, owner]);
        return { ok: true };
      });
      scope.get<{ Params: { id: string } }>('/api/credential-requests/:id', async request => describe(request.params.id));
      scope.post<{ Params: { id: string } }>('/api/credential-requests/:id', { bodyLimit: 16_384 }, async request => submit(request.params.id, request.body));
    });
  }

  return { registerRoutes, request, list, fillSaved, resumePending };
}
