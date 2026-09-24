import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { CredentialRequest, VaultEntry } from '../shared/contracts.ts';
import type { RuntimeContext } from '../ports/agent.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';

const owner = 'local-development';
const passwordInput = z
  .object({
    label: z.string().trim().min(1).max(100),
    origin: z.string().max(2048),
    username: z.string().max(320),
    password: z.string().min(1).max(8192),
  })
  .strict();
const submissionInput = z
  .object({
    username: z.string().max(320).optional(),
    password: z.string().min(1).max(8192).optional(),
    code: z.string().min(1).max(100).optional(),
  })
  .strict();
const requestInput = z
  .object({
    origin: z.string().max(2048),
    label: z.string().trim().min(1).max(100),
    kind: z.enum(['password', 'otp']),
    usernameSelector: z.string().min(1).max(2048).optional(),
    passwordSelector: z.string().min(1).max(2048),
    submitSelector: z.string().min(1).max(2048).optional(),
  })
  .strict();
type CredentialInput = Parameters<RuntimeContext['requestCredential']>[0];
export type CredentialInjection = CredentialInput & {
  taskId: string;
  username?: string;
  password?: string;
  code?: string;
};
type VaultOptions = {
  resume(taskId: string): Promise<void>;
  retry(taskId: string, expectedRevision: number): Promise<void>;
  inject(input: CredentialInjection): Promise<unknown>;
  keyStore: CredentialKeyStore;
};
type EntryRow = {
  id: string;
  owner_id: string;
  label: string;
  origin: string;
  username_hint: string;
  ciphertext: string;
  updated_at: Date;
};
type RequestRow = {
  id: string;
  task_id: string;
  owner_id: string;
  origin: string;
  label: string;
  kind: 'password' | 'otp';
  status: 'pending' | 'processing' | 'filled';
  selectors: CredentialInput;
  expires_at: Date;
  task_revision: number;
};

class VaultError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export function credentialOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VaultError('Enter a valid website origin.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new VaultError('Use an HTTPS origin, such as https://example.com, without a path.');
  }
  return url.origin;
}

function binding(entry: Pick<EntryRow, 'id' | 'owner_id' | 'origin'>) {
  return Buffer.from(JSON.stringify(['sidekick-vault-v1', entry.owner_id, entry.origin, entry.id]));
}

export function sealCredential(
  key: Buffer,
  entry: Pick<EntryRow, 'id' | 'owner_id' | 'origin'>,
  secret: { username: string; password: string },
) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(binding(entry));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ username: secret.username, password: secret.password }), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function openCredential(
  key: Buffer,
  entry: Pick<EntryRow, 'id' | 'owner_id' | 'origin' | 'ciphertext'>,
) {
  const data = Buffer.from(entry.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAAD(binding(entry));
  decipher.setAuthTag(data.subarray(12, 28));
  return submissionInput
    .required({ username: true, password: true })
    .parse(
      JSON.parse(
        Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'),
      ),
    );
}

function metadata(entry: EntryRow): VaultEntry {
  return {
    id: entry.id,
    label: entry.label,
    origin: entry.origin,
    usernameHint: entry.username_hint,
    updatedAt: new Date(entry.updated_at).toISOString(),
  };
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
      selectors jsonb NOT NULL, expires_at timestamptz NOT NULL, resume_pending boolean NOT NULL DEFAULT false, task_revision integer NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS credential_autofill_attempts (
      task_id text NOT NULL, owner_id text NOT NULL, origin text NOT NULL, entry_id text NOT NULL,
      attempted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(task_id,owner_id,origin)
    );
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='credential_requests' AND column_name='task_revision') THEN
        ALTER TABLE credential_requests ADD COLUMN task_revision integer NOT NULL DEFAULT 0;
        UPDATE credential_requests SET expires_at=least(expires_at,now()),resume_pending=false;
        UPDATE credential_requests r SET task_revision=t.revision FROM tasks t WHERE t.id::text=r.task_id AND t.owner_id=r.owner_id;
      END IF;
    END $$;
    ALTER TABLE credential_requests ADD COLUMN IF NOT EXISTS failed_at timestamptz;
    CREATE INDEX IF NOT EXISTS vault_entries_owner ON vault_entries(owner_id);
    UPDATE credential_requests SET status = 'pending' WHERE status = 'processing';
  `);
  let keyPromise: Promise<Buffer> | undefined;
  const key = () => {
    keyPromise ??= options.keyStore
      .getKey()
      .then((value) => {
        if (!Buffer.isBuffer(value) || value.length !== 32)
          throw new Error('Invalid credential key.');
        return value;
      })
      .catch(() => {
        keyPromise = undefined;
        throw new VaultError(
          'The credential key is unavailable. Check the configured key store.',
          503,
        );
      });
    return keyPromise;
  };
  let resuming = false;
  async function resumePending() {
    if (resuming) return;
    resuming = true;
    try {
      await pool.query(`UPDATE credential_requests r SET resume_pending=false FROM tasks t WHERE r.resume_pending=true
        AND t.id::text=r.task_id AND t.owner_id=r.owner_id AND (t.revision<>r.task_revision OR t.status<>'waiting_credentials')`);
      const { rows } =
        await pool.query<RequestRow>(`SELECT r.* FROM credential_requests r JOIN tasks t ON t.id::text=r.task_id AND t.owner_id=r.owner_id
        WHERE r.resume_pending=true AND t.revision=r.task_revision AND t.status='waiting_credentials'`);
      for (const row of rows) {
        try {
          await options.resume(row.task_id);
          await pool.query('UPDATE credential_requests SET resume_pending = false WHERE id = $1', [
            row.id,
          ]);
        } catch {}
      }
    } finally {
      resuming = false;
    }
  }
  const timer = setInterval(() => {
    void resumePending().catch(() => {});
  }, 5000);
  timer.unref();

  async function list(ownerId = owner) {
    const { rows } = await pool.query<EntryRow>(
      'SELECT * FROM vault_entries WHERE owner_id = $1 ORDER BY updated_at DESC',
      [ownerId],
    );
    return rows.map(metadata);
  }

  async function save(ownerId: string, raw: unknown, database: Pick<PoolClient, 'query'> = pool) {
    const input = passwordInput.parse(raw);
    const entry = { id: randomUUID(), owner_id: ownerId, origin: credentialOrigin(input.origin) };
    const ciphertext = sealCredential(await key(), entry, input);
    const hint = input.username ? `${input.username.slice(0, 2)}…` : '';
    const { rows } = await database.query<EntryRow>(
      'INSERT INTO vault_entries (id, owner_id, label, origin, username_hint, ciphertext) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [entry.id, ownerId, input.label, entry.origin, hint, ciphertext],
    );
    return metadata(rows[0]);
  }

  async function request(
    taskId: string,
    ownerId: string,
    raw: CredentialInput,
  ): Promise<{ url: string }> {
    const input = requestInput.parse(raw);
    const origin = credentialOrigin(input.origin);
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    const result = await pool.query(
      `INSERT INTO credential_requests (id, token_hash, task_id, owner_id, origin, label, kind, selectors, expires_at,task_revision)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,now() + interval '10 minutes',revision FROM tasks
       WHERE id::text=$3 AND owner_id=$4 AND status IN ('running','waiting_credentials')`,
      [
        randomUUID(),
        hash,
        taskId,
        ownerId,
        origin,
        input.label,
        input.kind,
        JSON.stringify({ ...input, origin }),
      ],
    );
    if (!result.rowCount) throw new VaultError('This task can no longer request credentials.', 409);
    return { url: `/credentials/${token}` };
  }

  function tokenHash(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new VaultError('Credential request not found.', 404);
    return createHash('sha256').update(token).digest('hex');
  }

  async function describe(token: string): Promise<CredentialRequest> {
    const { rows } = await pool.query<RequestRow & { current_step: boolean }>(
      `SELECT r.*,EXISTS(SELECT 1 FROM tasks t WHERE t.id::text=r.task_id AND t.owner_id=r.owner_id AND t.revision=r.task_revision
        AND t.status IN ('running','waiting_credentials')) AS current_step FROM credential_requests r WHERE token_hash=$1 AND owner_id=$2`,
      [tokenHash(token), owner],
    );
    const row = rows[0];
    if (!row) throw new VaultError('Credential request not found.', 404);
    return {
      id: token,
      taskId: row.task_id,
      origin: row.origin,
      label: row.label,
      kind: row.kind,
      status:
        row.status === 'filled'
          ? 'filled'
          : !row.current_step || new Date(row.expires_at).getTime() <= Date.now()
            ? 'expired'
            : 'pending',
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }

  async function submit(token: string, raw: unknown) {
    const input = submissionInput.parse(raw);
    const client = await pool.connect();
    let submittedId: string | undefined;
    try {
      await client.query('BEGIN');
      const task = await client.query(
        `SELECT t.id FROM tasks t JOIN credential_requests r ON t.id::text=r.task_id AND t.owner_id=r.owner_id
        WHERE r.token_hash=$1 AND r.owner_id=$2 AND r.task_revision=t.revision AND t.status='waiting_credentials'
        AND r.status='pending' AND r.expires_at>now() FOR UPDATE OF t NOWAIT`,
        [tokenHash(token), owner],
      );
      if (!task.rowCount)
        throw new VaultError(
          'This request is expired, already used, or belongs to an earlier task step.',
          409,
        );
      const { rows } = await client.query<RequestRow>(
        `UPDATE credential_requests SET status='processing'
        WHERE token_hash=$1 AND owner_id=$2 AND status='pending' AND expires_at>now() RETURNING *`,
        [tokenHash(token), owner],
      );
      const row = rows[0];
      if (!row) throw new VaultError('This request is already being filled.', 409);
      if (row.kind === 'password' && !input.password) throw new VaultError('Enter the password.');
      if (row.kind === 'otp' && !input.code) throw new VaultError('Enter the verification code.');
      submittedId = row.id;
      if (row.kind === 'password') await key();
      await options.inject({
        ...row.selectors,
        origin: row.origin,
        kind: row.kind,
        taskId: row.task_id,
        ...(row.kind === 'otp'
          ? { code: input.code }
          : { username: input.username ?? '', password: input.password }),
      });
      if (row.kind === 'password')
        await save(
          row.owner_id,
          {
            label: row.label,
            origin: row.origin,
            username: input.username ?? '',
            password: input.password,
          },
          client,
        );
      await client.query(
        "UPDATE credential_requests SET status='filled',resume_pending=true WHERE id=$1",
        [row.id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (submittedId)
        await client.query(
          "UPDATE credential_requests SET failed_at=now() WHERE id=$1 AND status='pending'",
          [submittedId],
        );
      if (error instanceof VaultError) throw error;
      if ((error as { code?: string }).code === '55P03')
        throw new VaultError('This task is already processing another request.', 409);
      throw new VaultError(
        'Credential entry failed. Check the website and complete this form again.',
        502,
      );
    } finally {
      client.release();
    }
    await resumePending();
    return { ok: true };
  }

  async function retry(token: string) {
    const client = await pool.connect();
    let row: RequestRow;
    try {
      await client.query('BEGIN');
      const result = await client.query<RequestRow>(
        `SELECT r.* FROM credential_requests r JOIN tasks t ON t.id::text=r.task_id AND t.owner_id=r.owner_id
        WHERE r.token_hash=$1 AND r.owner_id=$2 AND r.status='pending' AND r.task_revision=t.revision AND t.status='waiting_credentials'
        AND (r.expires_at<=now() OR r.failed_at IS NOT NULL) FOR UPDATE OF t,r NOWAIT`,
        [tokenHash(token), owner],
      );
      row = result.rows[0];
      if (!row)
        throw new VaultError(
          'This request can no longer be retried. Return to the latest task step.',
          409,
        );
      await client.query(
        `INSERT INTO credential_autofill_attempts(task_id,owner_id,origin,entry_id) VALUES($1,$2,$3,'manual-retry') ON CONFLICT DO NOTHING`,
        [row.task_id, row.owner_id, row.origin],
      );
      await client.query(
        'UPDATE credential_requests SET expires_at=least(expires_at,now()) WHERE task_id=$1 AND owner_id=$2 AND task_revision=$3',
        [row.task_id, owner, row.task_revision],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof VaultError) throw error;
      if ((error as { code?: string }).code === '55P03')
        throw new VaultError('This task is already processing another request.', 409);
      throw new VaultError('The credential step could not restart. Try again.', 503);
    } finally {
      client.release();
    }
    try {
      await options.retry(row.task_id, row.task_revision);
    } catch (error) {
      throw new VaultError(
        'The credential step could not restart. Return to chat and try again.',
        (error as { statusCode?: number }).statusCode === 409 ? 409 : 503,
      );
    }
    return { ok: true };
  }

  async function fillSaved(taskId: string, ownerId: string, id: string, input: CredentialInput) {
    const origin = credentialOrigin(input.origin);
    const { rows } = await pool.query<EntryRow>(
      'SELECT * FROM vault_entries WHERE id = $1 AND owner_id = $2 AND origin = $3',
      [id, ownerId, origin],
    );
    if (!rows[0] || input.kind !== 'password')
      throw new VaultError('No saved password is available for this website.', 404);
    const attempt = await pool.query(
      `INSERT INTO credential_autofill_attempts (task_id,owner_id,origin,entry_id)
       SELECT $1,$2,$3,$4 WHERE NOT EXISTS (
         SELECT 1 FROM credential_requests WHERE task_id = $1 AND owner_id = $2 AND origin = $3
         AND kind = 'password' AND status = 'filled'
       ) ON CONFLICT DO NOTHING RETURNING task_id`,
      [taskId, ownerId, origin, id],
    );
    if (!attempt.rowCount)
      throw new VaultError('Enter fresh credentials to retry this website.', 409);
    const secret = openCredential(await key(), rows[0]);
    await options.inject({
      ...requestInput.parse(input),
      taskId,
      origin,
      username: secret.username,
      password: secret.password,
    });
  }

  function registerRoutes(app: FastifyInstance) {
    app.addHook('onClose', async () => {
      clearInterval(timer);
    });
    app.register(async (scope) => {
      scope.addHook('onSend', async (_request, reply, payload) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        return payload;
      });
      scope.setErrorHandler((error, _request, reply) => {
        const status =
          error instanceof VaultError ? error.statusCode : error instanceof z.ZodError ? 400 : 500;
        reply.code(status).send({
          error:
            error instanceof VaultError
              ? error.message
              : status === 400
                ? 'Check the credential fields.'
                : 'The vault request could not be completed.',
        });
      });
      scope.get('/api/vault', async () => list());
      scope.post('/api/vault', { bodyLimit: 16_384 }, async (request) => save(owner, request.body));
      scope.delete<{ Params: { id: string } }>('/api/vault/:id', async (request) => {
        await pool.query('DELETE FROM vault_entries WHERE id = $1 AND owner_id = $2', [
          request.params.id,
          owner,
        ]);
        return { ok: true };
      });
      scope.get<{ Params: { id: string } }>('/api/credential-requests/:id', async (request) =>
        describe(request.params.id),
      );
      scope.post<{ Params: { id: string } }>(
        '/api/credential-requests/:id/retry',
        async (request) => retry(request.params.id),
      );
      scope.post<{ Params: { id: string } }>(
        '/api/credential-requests/:id',
        { bodyLimit: 16_384 },
        async (request) => submit(request.params.id, request.body),
      );
    });
  }

  return { registerRoutes, request, list, fillSaved, resumePending };
}
