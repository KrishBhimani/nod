import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type {
  CredentialRequest,
  VaultEntry,
  VaultEntryDetails,
  VaultEntryPassword,
  VaultLoginEntry,
  VaultListEntry,
  VaultCardEntry,
  VaultCardNumber,
  VaultCardSecurityCode,
} from '../shared/contracts.ts';
import type { CredentialKind, CredentialSubmission, LoginInspection } from '../ports/computer.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { CredentialInvitation } from '../ports/agent.ts';

const owner = 'local-development';
const passwordInput = z
  .object({
    kind: z.literal('login').optional(),
    label: z.string().trim().min(1).max(100),
    origin: z.string().max(2048),
    username: z.string().max(320),
    password: z.string().min(1).max(8192),
  })
  .strict();
const updateInput = z
  .object({
    kind: z.literal('login').optional(),
    label: z.string().trim().min(1).max(100),
    username: z.string().max(320),
    password: z.string().max(8192).optional(),
  })
  .strict();
const cardFields = {
  label: z.string().trim().min(1).max(100),
  cardholder: z.string().trim().min(1).max(200),
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int().min(2000).max(9999),
};
const securityCodeInput = z
  .string()
  .trim()
  .regex(/^(?:\d{3,4})?$/);
const cardInput = z
  .object({
    kind: z.literal('card'),
    ...cardFields,
    cardNumber: z.string().max(40),
    securityCode: securityCodeInput.optional(),
  })
  .strict();
const cardUpdateInput = cardInput.extend({
  cardNumber: z.string().max(40).optional(),
  securityCode: securityCodeInput.nullable().optional(),
});
const cardSecret = z
  .object({
    cardholder: cardFields.cardholder,
    cardNumber: z.string().regex(/^\d{12,19}$/),
    expiryMonth: cardFields.expiryMonth,
    expiryYear: cardFields.expiryYear,
    securityCode: z
      .string()
      .regex(/^\d{3,4}$/)
      .optional(),
  })
  .strict();
type CardSecret = z.infer<typeof cardSecret>;
const submissionInput = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    username: z.string().max(320).optional(),
    password: z.string().min(1).max(8192).optional(),
    code: z.string().min(1).max(100).optional(),
  })
  .strict();
const requestInput = z
  .object({
    origin: z.string().max(2048),
    label: z.string().trim().min(1).max(100),
    kind: z.enum(['identifier', 'password', 'otp']),
    usernameSelector: z.string().min(1).max(2048).optional(),
    passwordSelector: z.string().min(1).max(2048).optional(),
    submitSelector: z.string().min(1).max(2048).optional(),
  })
  .strict();
type CredentialInput = z.infer<typeof requestInput>;
export type CredentialInjection = CredentialInput & {
  taskId: string;
  username?: string;
  password?: string;
  code?: string;
};
type VaultOptions = {
  resume(taskId: string, expectedRevision: number): Promise<void>;
  retry(taskId: string, expectedRevision: number): Promise<void>;
  inject(input: CredentialInjection): Promise<CredentialSubmission | void>;
  keyStore: CredentialKeyStore;
  inspect?(taskId: string): Promise<LoginInspection>;
  hold?(taskId: string, until: number | null): Promise<void>;
  selectMethod?(taskId: string, origin: string, methodId: string): Promise<void>;
};
type EntryRow = {
  id: string;
  owner_id: string;
  label: string;
  origin: string;
  username_hint: string;
  identifier_label: string;
  ciphertext: string;
  updated_at: Date;
};
type CardRow = {
  id: string;
  owner_id: string;
  label: string;
  brand: string;
  last4: string;
  expiry_month: number;
  expiry_year: number;
  ciphertext: string;
  updated_at: Date;
};
type RequestRow = {
  id: string;
  task_id: string;
  owner_id: string;
  origin: string;
  label: string;
  kind: CredentialKind;
  status: 'pending' | 'processing' | 'filled';
  selectors: CredentialInput;
  inspection: LoginInspection | null;
  expires_at: Date;
  task_revision: number;
};
type SelectionRow = {
  id: string;
  task_id: string;
  owner_id: string;
  origin: string;
  entry_id: string | null;
  identifier_label: string;
  ciphertext: string;
  blocked: boolean;
  task_revision: number;
  expires_at: Date;
};

class VaultError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

function assertSupportedBrowser(inspection: LoginInspection) {
  if (inspection.issue === 'browser_not_supported')
    throw new VaultError(
      'This provider has blocked sign-in in the automated browser. Choose "Sign in in browser" under browser controls, then "Continue in Sidekick" after finishing there.',
      409,
    );
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

function savedCredentialOrigin(value: string) {
  const trimmed = value.trim();
  return credentialOrigin(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
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
  return z
    .object({ username: z.string().max(320), password: z.string().max(8192) })
    .strict()
    .parse(
      JSON.parse(
        Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'),
      ),
    );
}

function safeIdentifierLabel(value: string | undefined) {
  return value
    ?.replace(/[\p{Cc}\p{Cf}<>]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80)
    .trim();
}

function inferredIdentifierLabel(username: string) {
  return z.email().safeParse(username).success ? 'Email' : 'Username';
}

function observedIdentifierLabel(inspection: LoginInspection) {
  const fields = inspection.fields.filter((field) => field.kind === 'identifier');
  return fields.length === 1 ? safeIdentifierLabel(fields[0].label) : undefined;
}

function metadata(entry: EntryRow, username?: string): VaultLoginEntry {
  return {
    kind: 'login',
    id: entry.id,
    label: entry.label,
    origin: entry.origin,
    usernameHint: entry.username_hint,
    identifierLabel:
      safeIdentifierLabel(entry.identifier_label) || inferredIdentifierLabel(username ?? ''),
    updatedAt: new Date(entry.updated_at).toISOString(),
  };
}

function normalizedCardNumber(value: string) {
  if (!/^[0-9 -]+$/.test(value)) throw new VaultError('Check the card number.');
  const number = value.replace(/[ -]/g, '');
  if (!/^\d{12,19}$/.test(number) || /^(\d)\1+$/.test(number))
    throw new VaultError('Check the card number.');
  let sum = 0;
  let double = false;
  for (let index = number.length - 1; index >= 0; index--) {
    let digit = Number(number[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  if (sum % 10 !== 0) throw new VaultError('Check the card number.');
  return number;
}

function validateCardExpiry(month: number, year: number) {
  const now = new Date();
  if (
    year < now.getUTCFullYear() ||
    year > now.getUTCFullYear() + 30 ||
    (year === now.getUTCFullYear() && month < now.getUTCMonth() + 1)
  )
    throw new VaultError('Check the card expiry date.');
}

function cardBrand(number: string) {
  if (number.startsWith('4')) return 'Visa';
  if (/^3[47]/.test(number)) return 'American Express';
  const prefix = Number(number.slice(0, 4));
  if (/^5[1-5]/.test(number) || (prefix >= 2221 && prefix <= 2720)) return 'Mastercard';
  if (/^(6011|65|64[4-9])/.test(number)) return 'Discover';
  return 'Card';
}

function cardBinding(entry: Pick<CardRow, 'id' | 'owner_id'>) {
  return Buffer.from(JSON.stringify(['sidekick-vault-card-v1', entry.owner_id, entry.id]));
}

function sealCard(key: Buffer, entry: Pick<CardRow, 'id' | 'owner_id'>, secret: CardSecret) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(cardBinding(entry));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function openCard(key: Buffer, entry: Pick<CardRow, 'id' | 'owner_id' | 'ciphertext'>) {
  try {
    const data = Buffer.from(entry.ciphertext, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAAD(cardBinding(entry));
    decipher.setAuthTag(data.subarray(12, 28));
    return cardSecret.parse(
      JSON.parse(
        Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'),
      ),
    );
  } catch {
    throw new VaultError('This saved card could not be opened.', 500);
  }
}

function cardMetadata(entry: CardRow): VaultCardEntry {
  return {
    kind: 'card',
    id: entry.id,
    label: entry.label,
    brand: entry.brand,
    last4: entry.last4,
    expiryMonth: entry.expiry_month,
    expiryYear: entry.expiry_year,
    updatedAt: new Date(entry.updated_at).toISOString(),
  };
}

export async function createVault(pool: Pool, options: VaultOptions) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_entries (
      id text PRIMARY KEY, owner_id text NOT NULL, label text NOT NULL, origin text NOT NULL,
      username_hint text NOT NULL, ciphertext text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE vault_entries ADD COLUMN IF NOT EXISTS identifier_label text NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS vault_cards (
      id text PRIMARY KEY, owner_id text NOT NULL, label text NOT NULL,
      brand text NOT NULL, last4 text NOT NULL, expiry_month integer NOT NULL, expiry_year integer NOT NULL,
      ciphertext text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS vault_cards_owner ON vault_cards(owner_id);
    CREATE TABLE IF NOT EXISTS credential_requests (
      id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, task_id text NOT NULL, owner_id text NOT NULL,
      origin text NOT NULL, label text NOT NULL, kind text NOT NULL, status text NOT NULL DEFAULT 'pending',
      selectors jsonb NOT NULL, expires_at timestamptz NOT NULL, resume_pending boolean NOT NULL DEFAULT false, task_revision integer NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS credential_autofill_attempts (
      task_id text NOT NULL, owner_id text NOT NULL, origin text NOT NULL, entry_id text NOT NULL,
      attempted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(task_id,owner_id,origin)
    );
    CREATE TABLE IF NOT EXISTS credential_account_selections (
      id text NOT NULL, task_id text NOT NULL, owner_id text NOT NULL, origin text NOT NULL,
      entry_id text, ciphertext text NOT NULL, blocked boolean NOT NULL DEFAULT false,
      task_revision integer NOT NULL, expires_at timestamptz NOT NULL,
      PRIMARY KEY(task_id,owner_id,origin)
    );
    ALTER TABLE credential_account_selections ADD COLUMN IF NOT EXISTS identifier_label text NOT NULL DEFAULT '';
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='credential_requests' AND column_name='task_revision') THEN
        ALTER TABLE credential_requests ADD COLUMN task_revision integer NOT NULL DEFAULT 0;
        UPDATE credential_requests SET expires_at=least(expires_at,now()),resume_pending=false;
        UPDATE credential_requests r SET task_revision=t.revision FROM tasks t WHERE t.id::text=r.task_id AND t.owner_id=r.owner_id;
      END IF;
    END $$;
    ALTER TABLE credential_requests ADD COLUMN IF NOT EXISTS failed_at timestamptz;
    ALTER TABLE credential_requests ADD COLUMN IF NOT EXISTS inspection jsonb;
    UPDATE credential_requests SET expires_at=least(expires_at,now()) WHERE inspection IS NULL AND status='pending';
    ALTER TABLE credential_autofill_attempts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'password';
    ALTER TABLE credential_autofill_attempts DROP CONSTRAINT IF EXISTS credential_autofill_attempts_pkey;
    ALTER TABLE credential_autofill_attempts ADD PRIMARY KEY(task_id,owner_id,origin,kind);
    CREATE INDEX IF NOT EXISTS vault_entries_owner ON vault_entries(owner_id);
    UPDATE credential_requests SET status = 'pending' WHERE status = 'processing';
  `);
  const identifiers = new Map<
    string,
    { value: string; identifierLabel: string; expiresAt: number }
  >();
  const identifierKey = (taskId: string, ownerId: string, origin: string) =>
    JSON.stringify([taskId, ownerId, origin]);
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
          await options.resume(row.task_id, row.task_revision);
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
    for (const [id, value] of identifiers)
      if (value.expiresAt <= Date.now()) identifiers.delete(id);
    void resumePending().catch(() => {});
  }, 5000);
  timer.unref();

  async function list(ownerId = owner) {
    const { rows } = await pool.query<EntryRow>(
      'SELECT * FROM vault_entries WHERE owner_id = $1 ORDER BY updated_at DESC',
      [ownerId],
    );
    return rows.map((entry) => metadata(entry));
  }

  async function listEntries(): Promise<VaultListEntry[]> {
    let logins = await pool.query<EntryRow>(
      'SELECT * FROM vault_entries WHERE owner_id=$1 ORDER BY updated_at DESC',
      [owner],
    );
    const entries: VaultListEntry[] = [];
    if (logins.rows.length) {
      const credentialKey = await key();
      logins = await pool.query<EntryRow>(
        'SELECT * FROM vault_entries WHERE owner_id=$1 ORDER BY updated_at DESC',
        [owner],
      );
      for (const entry of logins.rows) {
        try {
          const { username } = openCredential(credentialKey, entry);
          entries.push({ ...metadata(entry, username), username });
        } catch {
          throw new VaultError('A saved login could not be opened.', 500);
        }
      }
    }
    const cards = await pool.query<CardRow>(
      'SELECT * FROM vault_cards WHERE owner_id=$1 ORDER BY updated_at DESC',
      [owner],
    );
    entries.push(...cards.rows.map(cardMetadata));
    return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async function ownedEntry(id: string) {
    const { rows } = await pool.query<EntryRow>(
      'SELECT * FROM vault_entries WHERE id=$1 AND owner_id=$2',
      [id, owner],
    );
    if (!rows[0]) throw new VaultError('This saved login could not be found.', 404);
    return rows[0];
  }

  async function readCredential(rawId: string) {
    const id = z.uuid().parse(rawId);
    await ownedEntry(id);
    const credentialKey = await key();
    const entry = await ownedEntry(id);
    try {
      return { entry, secret: openCredential(credentialKey, entry) };
    } catch {
      throw new VaultError('This saved login could not be opened.', 500);
    }
  }

  async function save(
    ownerId: string,
    raw: unknown,
    database: Pick<PoolClient, 'query'> = pool,
    identifierLabel?: string,
  ) {
    const input = passwordInput.parse(raw);
    const entry = {
      id: randomUUID(),
      owner_id: ownerId,
      origin: savedCredentialOrigin(input.origin),
    };
    const ciphertext = sealCredential(await key(), entry, input);
    const hint = input.username ? `${input.username.slice(0, 2)}…` : '';
    const { rows } = await database.query<EntryRow>(
      'INSERT INTO vault_entries (id, owner_id, label, origin, username_hint, ciphertext, identifier_label) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [
        entry.id,
        ownerId,
        input.label,
        entry.origin,
        hint,
        ciphertext,
        safeIdentifierLabel(identifierLabel) || inferredIdentifierLabel(input.username),
      ],
    );
    return metadata(rows[0]);
  }

  async function update(rawId: string, raw: unknown) {
    const id = z.uuid().parse(rawId);
    const input = updateInput.parse(raw);
    await ownedEntry(id);
    const credentialKey = await key();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<EntryRow>(
        'SELECT * FROM vault_entries WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [id, owner],
      );
      const entry = rows[0];
      if (!entry) throw new VaultError('This saved login could not be found.', 404);
      let secret: ReturnType<typeof openCredential>;
      try {
        secret = openCredential(credentialKey, entry);
      } catch {
        throw new VaultError('This saved login could not be opened.', 500);
      }
      const ciphertext = sealCredential(credentialKey, entry, {
        username: input.username,
        password: input.password || secret.password,
      });
      const result = await client.query<EntryRow>(
        'UPDATE vault_entries SET label=$3,username_hint=$4,ciphertext=$5,identifier_label=$6,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *',
        [
          id,
          owner,
          input.label,
          input.username ? `${input.username.slice(0, 2)}…` : '',
          ciphertext,
          safeIdentifierLabel(entry.identifier_label) || inferredIdentifierLabel(secret.username),
        ],
      );
      await client.query('COMMIT');
      return metadata(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function ownedCard(id: string) {
    const { rows } = await pool.query<CardRow>(
      'SELECT * FROM vault_cards WHERE id=$1 AND owner_id=$2',
      [id, owner],
    );
    if (!rows[0]) throw new VaultError('This saved card could not be found.', 404);
    return rows[0];
  }

  async function readCard(rawId: string) {
    const id = z.uuid().parse(rawId);
    await ownedCard(id);
    const credentialKey = await key();
    const entry = await ownedCard(id);
    return { entry, secret: openCard(credentialKey, entry) };
  }

  async function saveCard(raw: unknown) {
    const input = cardInput.parse(raw);
    validateCardExpiry(input.expiryMonth, input.expiryYear);
    const number = normalizedCardNumber(input.cardNumber);
    const entry = { id: randomUUID(), owner_id: owner };
    const ciphertext = sealCard(await key(), entry, {
      cardholder: input.cardholder,
      cardNumber: number,
      expiryMonth: input.expiryMonth,
      expiryYear: input.expiryYear,
      securityCode: input.securityCode || undefined,
    });
    const { rows } = await pool.query<CardRow>(
      'INSERT INTO vault_cards(id,owner_id,label,brand,last4,expiry_month,expiry_year,ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [
        entry.id,
        owner,
        input.label,
        cardBrand(number),
        number.slice(-4),
        input.expiryMonth,
        input.expiryYear,
        ciphertext,
      ],
    );
    return cardMetadata(rows[0]);
  }

  async function updateCard(rawId: string, raw: unknown) {
    const id = z.uuid().parse(rawId);
    const input = cardUpdateInput.parse(raw);
    validateCardExpiry(input.expiryMonth, input.expiryYear);
    const replacement = input.cardNumber?.trim()
      ? normalizedCardNumber(input.cardNumber)
      : undefined;
    await ownedCard(id);
    const credentialKey = await key();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<CardRow>(
        'SELECT * FROM vault_cards WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [id, owner],
      );
      const entry = rows[0];
      if (!entry) throw new VaultError('This saved card could not be found.', 404);
      const secret = openCard(credentialKey, entry);
      const number = replacement ?? secret.cardNumber;
      const ciphertext = sealCard(credentialKey, entry, {
        cardholder: input.cardholder,
        cardNumber: number,
        expiryMonth: input.expiryMonth,
        expiryYear: input.expiryYear,
        securityCode:
          input.securityCode === null ? undefined : input.securityCode || secret.securityCode,
      });
      const result = await client.query<CardRow>(
        'UPDATE vault_cards SET label=$3,brand=$4,last4=$5,expiry_month=$6,expiry_year=$7,ciphertext=$8,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *',
        [
          id,
          owner,
          input.label,
          cardBrand(number),
          number.slice(-4),
          input.expiryMonth,
          input.expiryYear,
          ciphertext,
        ],
      );
      await client.query('COMMIT');
      return cardMetadata(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function selection(
    taskId: string,
    ownerId: string,
    origin: string,
    database: Pick<PoolClient, 'query'> = pool,
  ) {
    const result = await database.query<SelectionRow>(
      'SELECT * FROM credential_account_selections WHERE task_id=$1 AND owner_id=$2 AND origin=$3',
      [taskId, ownerId, origin],
    );
    return result.rows[0];
  }

  async function rememberSelection(
    database: Pick<PoolClient, 'query'>,
    value: {
      taskId: string;
      ownerId: string;
      origin: string;
      entryId: string | null;
      username: string;
      identifierLabel?: string;
      revision: number;
      expiresAt: Date;
      blocked: boolean;
    },
  ) {
    const entry = { id: randomUUID(), owner_id: value.ownerId, origin: value.origin };
    const ciphertext = sealCredential(await key(), entry, {
      username: value.username,
      password: '',
    });
    await database.query(
      `INSERT INTO credential_account_selections(id,task_id,owner_id,origin,entry_id,ciphertext,blocked,task_revision,expires_at,identifier_label)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(task_id,owner_id,origin) DO UPDATE
       SET id=excluded.id,entry_id=excluded.entry_id,ciphertext=excluded.ciphertext,blocked=excluded.blocked,task_revision=excluded.task_revision,expires_at=excluded.expires_at,identifier_label=excluded.identifier_label`,
      [
        entry.id,
        value.taskId,
        value.ownerId,
        value.origin,
        value.entryId,
        ciphertext,
        value.blocked,
        value.revision,
        value.expiresAt,
        safeIdentifierLabel(value.identifierLabel) || inferredIdentifierLabel(value.username),
      ],
    );
  }

  async function stagedUsername(selected: SelectionRow | undefined, revision: number) {
    if (
      !selected ||
      selected.task_revision !== revision ||
      new Date(selected.expires_at).getTime() <= Date.now()
    )
      return undefined;
    return openCredential(await key(), selected).username;
  }

  async function inspectRequest(taskId: string, raw: CredentialInput) {
    const input = requestInput.parse(raw);
    const origin = credentialOrigin(input.origin);
    if (!options.inspect) {
      const fields: LoginInspection['fields'] = [];
      if (input.usernameSelector || input.kind === 'identifier')
        fields.push({
          kind: 'identifier',
          selector: input.usernameSelector ?? '',
          label: 'Email, phone number or username',
        });
      if (input.kind !== 'identifier')
        fields.push({
          kind: input.kind,
          selector: input.passwordSelector ?? '',
          label: input.kind === 'otp' ? 'Verification code' : 'Password',
        });
      return {
        input: { ...input, origin },
        inspection: {
          origin,
          url: origin,
          fields,
          methods: [
            {
              id: 'credentials',
              kind: 'credentials' as const,
              label: 'Use the secure form',
              supported: true,
            },
          ],
          submitSelector: input.submitSelector,
        },
      };
    }
    const inspection = await options.inspect(taskId);
    if (inspection.origin !== origin)
      throw new VaultError(
        'The login page origin changed. Request a new secure sign-in step.',
        409,
      );
    assertSupportedBrowser(inspection);
    if (inspection.fields.length === 0 && inspection.methods.length === 0)
      throw new VaultError(
        'There is no sign-in step on the current page. Inspect the browser before continuing.',
        409,
      );
    const kind =
      (['otp', 'password', 'identifier'] as const).find((value) =>
        inspection.fields.some((field) => field.kind === value),
      ) ?? input.kind;
    const target = inspection.fields.filter((field) => field.kind === kind);
    const username = inspection.fields.filter((field) => field.kind === 'identifier');
    const resolved: CredentialInput = {
      origin,
      label: input.label,
      kind,
      usernameSelector: username.length === 1 ? username[0].selector : undefined,
      passwordSelector:
        kind !== 'identifier' && target.length === 1 ? target[0].selector : undefined,
      submitSelector: inspection.submitSelector,
    };
    return {
      input: resolved,
      inspection: {
        ...inspection,
        url: origin,
        fields: inspection.fields.map((field) =>
          field.kind === 'identifier'
            ? { ...field, label: safeIdentifierLabel(field.label) || 'Username' }
            : field,
        ),
      },
    };
  }

  async function request(
    taskId: string,
    ownerId: string,
    raw: CredentialInput,
  ): Promise<{ url: string; invitation: CredentialInvitation }> {
    const task = await pool.query(
      "SELECT revision FROM tasks WHERE id::text=$1 AND owner_id=$2 AND status IN ('running','waiting_credentials')",
      [taskId, ownerId],
    );
    if (!task.rowCount) throw new VaultError('This task can no longer request credentials.', 409);
    const { input, inspection } = await inspectRequest(taskId, raw);
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    const expiresAt = Date.now() + 10 * 60_000;
    await options.hold?.(taskId, expiresAt);
    const result = await pool.query(
      `INSERT INTO credential_requests (id,token_hash,task_id,owner_id,origin,label,kind,selectors,expires_at,task_revision,inspection)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,revision,$10 FROM tasks
       WHERE id::text=$3 AND owner_id=$4 AND revision=$11 AND status IN ('running','waiting_credentials')`,
      [
        randomUUID(),
        hash,
        taskId,
        ownerId,
        input.origin,
        input.label,
        input.kind,
        JSON.stringify(input),
        new Date(expiresAt),
        JSON.stringify(inspection),
        task.rows[0].revision,
      ],
    );
    if (!result.rowCount) throw new VaultError('This task can no longer request credentials.', 409);
    const savedLoginAvailable =
      input.kind === 'otp'
        ? undefined
        : (
            await pool.query<{ available: boolean }>(
              'SELECT EXISTS(SELECT 1 FROM vault_entries WHERE owner_id=$1 AND origin=$2) AS available',
              [ownerId, input.origin],
            )
          ).rows[0]?.available;
    return {
      url: `/vault/${token}`,
      invitation: {
        origin: input.origin,
        kind: input.kind,
        methodSelection:
          inspection.fields.length === 0 && inspection.methods.some((method) => method.supported),
        ...(savedLoginAvailable === undefined ? {} : { savedLoginAvailable }),
      },
    };
  }

  function tokenHash(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new VaultError('Credential request not found.', 404);
    return createHash('sha256').update(token).digest('hex');
  }

  async function describe(token: string): Promise<CredentialRequest> {
    const { rows } = await pool.query<RequestRow & { current_step: boolean; expired: boolean }>(
      `SELECT r.*,r.expires_at<=now() AS expired,EXISTS(SELECT 1 FROM tasks t WHERE t.id::text=r.task_id AND t.owner_id=r.owner_id AND t.revision=r.task_revision
        AND t.status IN ('running','waiting_credentials')) AS current_step FROM credential_requests r WHERE token_hash=$1 AND owner_id=$2`,
      [tokenHash(token), owner],
    );
    const row = rows[0];
    if (!row) throw new VaultError('Credential request not found.', 404);
    const pending = row.status === 'pending' && row.current_step && !row.expired;
    let savedEntries: VaultLoginEntry[] | undefined;
    let selectedEntryId: string | undefined;
    if (pending && row.kind !== 'otp') {
      const selected = await selection(row.task_id, row.owner_id, row.origin);
      const username = await stagedUsername(selected, row.task_revision);
      const entries = await pool.query<EntryRow>(
        `SELECT e.* FROM vault_entries e WHERE e.owner_id=$1 AND e.origin=$2
         AND NOT EXISTS(SELECT 1 FROM credential_autofill_attempts a WHERE a.task_id=$3 AND a.owner_id=e.owner_id AND a.origin=e.origin AND a.kind=$4 AND a.entry_id=e.id)
         ORDER BY e.updated_at DESC`,
        [row.owner_id, row.origin, row.task_id, row.kind],
      );
      const matches =
        row.kind === 'password' && selected && username === undefined ? [] : entries.rows;
      savedEntries = [];
      for (const entry of matches) {
        if (
          row.kind === 'password' &&
          username !== undefined &&
          openCredential(await key(), entry).username !== username
        )
          continue;
        savedEntries.push(metadata(entry));
      }
      if (
        selected &&
        !selected.blocked &&
        savedEntries.some((entry) => entry.id === selected.entry_id)
      )
        selectedEntryId = selected.entry_id ?? undefined;
    }
    return {
      id: token,
      taskId: row.task_id,
      origin: row.origin,
      label: row.label,
      kind: row.kind,
      fields: row.inspection?.fields ?? [],
      methods: (row.inspection?.methods ?? []).map(({ selector: _selector, ...method }) => method),
      status:
        row.status === 'filled'
          ? 'filled'
          : !row.current_step || row.expired
            ? 'expired'
            : 'pending',
      expiresAt: new Date(row.expires_at).toISOString(),
      ...(savedEntries ? { savedEntries } : {}),
      ...(selectedEntryId ? { selectedEntryId } : {}),
    };
  }

  async function refreshRequest(token: string): Promise<CredentialRequest> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const rows = await client.query<RequestRow>(
        `SELECT r.* FROM credential_requests r JOIN tasks t ON t.id::text=r.task_id AND t.owner_id=r.owner_id
         WHERE r.token_hash=$1 AND r.owner_id=$2 AND r.status='pending' AND r.expires_at>now()
         AND t.revision=r.task_revision AND t.status='waiting_credentials' FOR UPDATE OF t,r NOWAIT`,
        [tokenHash(token), owner],
      );
      const row = rows.rows[0];
      if (!row)
        throw new VaultError('This Vault link has expired. Return to chat for a new link.', 409);
      const fresh = await inspectRequest(row.task_id, row.selectors);
      await client.query(
        'UPDATE credential_requests SET kind=$2,selectors=$3,inspection=$4 WHERE id=$1',
        [row.id, fresh.input.kind, JSON.stringify(fresh.input), JSON.stringify(fresh.inspection)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof VaultError) throw error;
      throw new VaultError(
        'The sign-in page could not be checked. Try again or return to chat.',
        409,
      );
    } finally {
      client.release();
    }
    return describe(token);
  }

  async function consume(
    token: string,
    operation: (
      row: RequestRow,
      client: PoolClient,
    ) => Promise<{ retry: Awaited<ReturnType<typeof inspectRequest>>; error?: string } | void>,
  ) {
    const client = await pool.connect();
    let submittedId: string | undefined;
    let retryUrl: string | undefined;
    let retryError: string | undefined;
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
      submittedId = row.id;
      const result = await operation(row, client);
      await client.query(
        "UPDATE credential_requests SET status='filled',resume_pending=$2 WHERE id=$1",
        [row.id, !result?.retry],
      );
      if (result?.retry) {
        retryError = result.error;
        const freshToken = randomBytes(32).toString('base64url');
        const { input, inspection } = result.retry;
        await client.query(
          `INSERT INTO credential_requests(id,token_hash,task_id,owner_id,origin,label,kind,selectors,expires_at,task_revision,inspection)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            randomUUID(),
            createHash('sha256').update(freshToken).digest('hex'),
            row.task_id,
            row.owner_id,
            row.origin,
            row.label,
            input.kind,
            JSON.stringify(input),
            row.expires_at,
            row.task_revision,
            JSON.stringify(inspection),
          ],
        );
        retryUrl = `/vault/${freshToken}`;
      }
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
    if (retryUrl)
      return {
        ok: false,
        retryUrl,
        error: retryError ?? 'Those sign-in details were not accepted. Please try again.',
      };
    await resumePending();
    return { ok: true };
  }

  async function submit(token: string, raw: unknown) {
    const values = submissionInput.parse(raw);
    return consume(token, async (row, client) => {
      const { input, inspection } = await inspectRequest(row.task_id, row.selectors);
      if (input.kind !== row.kind)
        throw new VaultError('The login step changed. Request a fresh secure form.', 409);
      if (
        options.inspect &&
        (!inspection.methods.some((method) => method.id === 'credentials' && method.supported) ||
          !inspection.fields.some((field) => field.kind === row.kind))
      )
        throw new VaultError('The current page does not support this credential step.', 409);
      const savedIdentifier = identifiers.get(identifierKey(row.task_id, row.owner_id, row.origin));
      const selected = await selection(row.task_id, row.owner_id, row.origin, client);
      const staged = await stagedUsername(selected, row.task_revision);
      if (
        row.kind === 'password' &&
        !input.usernameSelector &&
        values.username &&
        staged !== undefined &&
        values.username !== staged
      )
        throw new VaultError('This password step belongs to the login you already chose.', 409);
      const username =
        values.username ||
        staged ||
        (savedIdentifier && savedIdentifier.expiresAt > Date.now() ? savedIdentifier.value : '');
      const identifierLabel =
        (options.inspect && observedIdentifierLabel(inspection)) ||
        (staged !== undefined && safeIdentifierLabel(selected?.identifier_label)) ||
        (savedIdentifier &&
          savedIdentifier.expiresAt > Date.now() &&
          savedIdentifier.identifierLabel) ||
        inferredIdentifierLabel(username);
      if (row.kind === 'identifier' && !username)
        throw new VaultError('Enter the email, phone number or username.');
      if (row.kind === 'password' && !values.password) throw new VaultError('Enter the password.');
      if (row.kind === 'password' && !values.label) throw new VaultError('Give this login a name.');
      if (row.kind === 'password' && input.usernameSelector && !username)
        throw new VaultError('Enter the email, phone number or username.');
      if (row.kind === 'otp' && !values.code) throw new VaultError('Enter the verification code.');
      if (row.kind === 'password') await key();
      const submission = await options.inject({
        ...input,
        taskId: row.task_id,
        ...(row.kind === 'otp'
          ? { code: values.code }
          : row.kind === 'identifier'
            ? { username }
            : {
                username: input.usernameSelector ? username : undefined,
                password: values.password,
              }),
      });
      if (row.kind !== 'otp')
        await rememberSelection(client, {
          taskId: row.task_id,
          ownerId: row.owner_id,
          origin: row.origin,
          entryId: null,
          username,
          identifierLabel,
          revision: row.task_revision + (submission?.status === 'rejected' ? 0 : 1),
          expiresAt: row.expires_at,
          blocked: true,
        });
      if (submission?.status === 'rejected')
        return { retry: await inspectRequest(row.task_id, row.selectors) };
      if (row.kind === 'identifier')
        identifiers.set(identifierKey(row.task_id, row.owner_id, row.origin), {
          value: username,
          identifierLabel,
          expiresAt: Date.now() + 10 * 60_000,
        });
      if (row.kind === 'password') {
        await save(
          row.owner_id,
          { label: values.label, origin: row.origin, username, password: values.password },
          client,
          identifierLabel,
        );
      }
    });
  }

  async function selectSaved(token: string, raw: unknown) {
    const { entryId } = z
      .object({ entryId: z.string().min(1).max(100) })
      .strict()
      .parse(raw);
    return consume(token, async (row, client) => {
      if (row.kind === 'otp') throw new VaultError('Enter the current verification code.', 409);
      const fresh = await inspectRequest(row.task_id, row.selectors);
      if (
        fresh.input.kind !== row.kind ||
        (options.inspect &&
          (!fresh.inspection.fields.some((field) => field.kind === row.kind) ||
            !fresh.inspection.methods.some(
              (method) => method.id === 'credentials' && method.supported,
            )))
      )
        throw new VaultError('The login step changed. Request a fresh secure form.', 409);
      const selected = await selection(row.task_id, row.owner_id, row.origin, client);
      const staged = await stagedUsername(selected, row.task_revision);
      const entries = await client.query<EntryRow>(
        'SELECT * FROM vault_entries WHERE id=$1 AND owner_id=$2 AND origin=$3 FOR SHARE',
        [entryId, row.owner_id, row.origin],
      );
      const entry = entries.rows[0];
      if (!entry) {
        await rememberSelection(client, {
          taskId: row.task_id,
          ownerId: row.owner_id,
          origin: row.origin,
          entryId: null,
          username: staged ?? '',
          identifierLabel: staged !== undefined ? selected?.identifier_label : undefined,
          revision: row.task_revision,
          expiresAt: row.expires_at,
          blocked: true,
        });
        return {
          retry: fresh,
          error: 'That saved login is no longer available. Enter a new login.',
        };
      }
      const secret = openCredential(await key(), entry);
      if (
        row.kind === 'password' &&
        selected &&
        (staged === undefined || staged !== secret.username)
      )
        throw new VaultError(
          'Choose the saved login that matches the account already entered.',
          409,
        );
      if (row.kind === 'identifier' && !secret.username)
        throw new VaultError('This login has no username. Enter it in the form.', 409);
      await client.query(
        `INSERT INTO credential_autofill_attempts(task_id,owner_id,origin,entry_id,kind) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(task_id,owner_id,origin,kind) DO UPDATE SET entry_id=excluded.entry_id,attempted_at=now()`,
        [row.task_id, row.owner_id, row.origin, entry.id, row.kind],
      );
      const submission = await options.inject({
        ...fresh.input,
        taskId: row.task_id,
        username:
          row.kind === 'identifier' || fresh.input.usernameSelector ? secret.username : undefined,
        password: row.kind === 'password' ? secret.password : undefined,
      });
      await rememberSelection(client, {
        taskId: row.task_id,
        ownerId: row.owner_id,
        origin: row.origin,
        entryId: entry.id,
        username: secret.username,
        identifierLabel:
          (options.inspect && observedIdentifierLabel(fresh.inspection)) ||
          (staged !== undefined && selected?.identifier_label) ||
          entry.identifier_label ||
          inferredIdentifierLabel(secret.username),
        revision: row.task_revision + (submission?.status === 'rejected' ? 0 : 1),
        expiresAt: row.expires_at,
        blocked: submission?.status === 'rejected',
      });
      if (submission?.status === 'rejected')
        return { retry: await inspectRequest(row.task_id, row.selectors) };
    });
  }

  async function selectMethod(token: string, raw: unknown) {
    const { methodId } = z
      .object({ methodId: z.string().min(1).max(100) })
      .strict()
      .parse(raw);
    return consume(token, async (row) => {
      if (!options.selectMethod || !options.inspect)
        throw new VaultError('Sign-in method selection is not available.', 409);
      const inspection = await options.inspect(row.task_id);
      assertSupportedBrowser(inspection);
      const method = inspection.methods.find((item) => item.id === methodId);
      if (
        inspection.origin !== row.origin ||
        !method?.supported ||
        !(['oauth', 'credentials'].includes(method.kind) && method.id !== 'credentials')
      )
        throw new VaultError(
          'This sign-in method is no longer available on the current page.',
          409,
        );
      await options.selectMethod(row.task_id, row.origin, methodId);
    });
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
        `INSERT INTO credential_autofill_attempts(task_id,owner_id,origin,entry_id,kind) VALUES($1,$2,$3,'manual-retry',$4) ON CONFLICT DO NOTHING`,
        [row.task_id, row.owner_id, row.origin, row.kind],
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

  async function fillSaved(taskId: string, ownerId: string, id: string, raw: CredentialInput) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const task = await client.query(
        "SELECT revision FROM tasks WHERE id::text=$1 AND owner_id=$2 AND status IN ('running','waiting_credentials') FOR UPDATE NOWAIT",
        [taskId, ownerId],
      );
      if (!task.rowCount)
        throw new VaultError('This task can no longer use saved credentials.', 409);
      const { input, inspection } = await inspectRequest(taskId, raw);
      const origin = input.origin;
      const { rows } = await client.query<EntryRow>(
        'SELECT * FROM vault_entries WHERE id=$1 AND owner_id=$2 AND origin=$3',
        [id, ownerId, origin],
      );
      if (!rows[0] || !['identifier', 'password'].includes(input.kind))
        throw new VaultError('No saved password is available for this website.', 404);
      if (
        options.inspect &&
        !inspection.methods.some((method) => method.id === 'credentials' && method.supported)
      )
        throw new VaultError('The current page does not support saved credentials.', 409);
      const attempt = await client.query(
        `INSERT INTO credential_autofill_attempts(task_id,owner_id,origin,entry_id,kind)
         SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS(SELECT 1 FROM credential_requests WHERE task_id=$1 AND owner_id=$2 AND origin=$3 AND kind=$5 AND status='filled')
         ON CONFLICT DO NOTHING RETURNING task_id`,
        [taskId, ownerId, origin, id, input.kind],
      );
      if (!attempt.rowCount)
        throw new VaultError('Enter fresh credentials to retry this website.', 409);
      await client.query('COMMIT');
      const encryptionKey = await key();
      await client.query('BEGIN');
      const current = await client.query(
        "SELECT id FROM tasks WHERE id::text=$1 AND owner_id=$2 AND revision=$3 AND status IN ('running','waiting_credentials') FOR UPDATE NOWAIT",
        [taskId, ownerId, task.rows[0].revision],
      );
      if (!current.rowCount) throw new VaultError('This task step is no longer active.', 409);
      const entries = await client.query<EntryRow>(
        'SELECT * FROM vault_entries WHERE id=$1 AND owner_id=$2 AND origin=$3 FOR SHARE',
        [id, ownerId, origin],
      );
      if (!entries.rows[0]) throw new VaultError('This saved login is no longer available.', 409);
      const secret = openCredential(encryptionKey, entries.rows[0]);
      if (input.kind === 'identifier' && !secret.username)
        throw new VaultError('Enter a username in the secure form.', 409);
      const selected = await selection(taskId, ownerId, origin, client);
      const staged = await stagedUsername(selected, task.rows[0].revision);
      if (selected && (selected.blocked || selected.entry_id !== id || staged === undefined))
        throw new VaultError('Enter fresh credentials to retry this website.', 409);
      if (
        input.kind === 'password' &&
        selected &&
        (staged === undefined || staged !== secret.username)
      )
        throw new VaultError(
          'Choose the saved login that matches the account already entered.',
          409,
        );
      const submission = await options.inject({
        ...input,
        taskId,
        origin,
        username:
          input.kind === 'identifier' || input.usernameSelector ? secret.username : undefined,
        password: input.kind === 'password' ? secret.password : undefined,
      });
      const identifierLabel =
        (options.inspect && observedIdentifierLabel(inspection)) ||
        (staged !== undefined && selected?.identifier_label) ||
        entries.rows[0].identifier_label ||
        inferredIdentifierLabel(secret.username);
      await rememberSelection(client, {
        taskId,
        ownerId,
        origin,
        entryId: id,
        username: secret.username,
        identifierLabel,
        revision: task.rows[0].revision,
        expiresAt:
          selected && staged !== undefined
            ? selected.expires_at
            : new Date(Date.now() + 10 * 60_000),
        blocked: submission?.status === 'rejected',
      });
      await client.query('COMMIT');
      if (submission?.status === 'rejected')
        throw new VaultError(
          'The saved details were not accepted. Enter fresh details in Vault.',
          409,
        );
      if (input.kind === 'identifier')
        identifiers.set(identifierKey(taskId, ownerId, origin), {
          value: secret.username,
          identifierLabel,
          expiresAt: Date.now() + 10 * 60_000,
        });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function fillSelected(taskId: string, ownerId: string, raw: CredentialInput) {
    const origin = credentialOrigin(raw.origin);
    const selected = await selection(taskId, ownerId, origin);
    if (!selected) return undefined;
    const task = await pool.query(
      "SELECT revision FROM tasks WHERE id::text=$1 AND owner_id=$2 AND status IN ('running','waiting_credentials')",
      [taskId, ownerId],
    );
    if (
      !task.rowCount ||
      selected.blocked ||
      !selected.entry_id ||
      selected.task_revision !== task.rows[0].revision ||
      new Date(selected.expires_at).getTime() <= Date.now()
    )
      return false;
    try {
      await fillSaved(taskId, ownerId, selected.entry_id, raw);
      return true;
    } catch {
      return false;
    }
  }

  function registerRoutes(app: FastifyInstance) {
    app.addHook('onClose', async () => {
      clearInterval(timer);
      identifiers.clear();
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
      scope.get('/api/vault', listEntries);
      scope.post('/api/vault', { bodyLimit: 16_384 }, async (request) => {
        const { kind } = z
          .object({ kind: z.enum(['login', 'card']).optional() })
          .parse(request.body);
        return kind === 'card' ? saveCard(request.body) : save(owner, request.body);
      });
      scope.patch<{ Params: { id: string } }>(
        '/api/vault/:id',
        { bodyLimit: 16_384 },
        async (request): Promise<VaultEntry> => {
          const { kind } = z
            .object({ kind: z.enum(['login', 'card']).optional() })
            .parse(request.body);
          return kind === 'card'
            ? updateCard(request.params.id, request.body)
            : update(request.params.id, request.body);
        },
      );
      scope.post<{ Params: { id: string } }>(
        '/api/vault/:id/details',
        async (request): Promise<VaultEntryDetails> => {
          z.object({})
            .strict()
            .parse(request.body ?? {});
          const id = z.uuid().parse(request.params.id);
          const card = await pool.query('SELECT id FROM vault_cards WHERE id=$1 AND owner_id=$2', [
            id,
            owner,
          ]);
          if (card.rowCount) {
            const { entry, secret } = await readCard(id);
            return {
              ...cardMetadata(entry),
              cardholder: secret.cardholder,
              hasSecurityCode: Boolean(secret.securityCode),
            };
          }
          const { entry, secret } = await readCredential(request.params.id);
          return { ...metadata(entry, secret.username), username: secret.username };
        },
      );
      scope.post<{ Params: { id: string } }>(
        '/api/vault/:id/password',
        async (request): Promise<VaultEntryPassword> => {
          z.object({})
            .strict()
            .parse(request.body ?? {});
          const { secret } = await readCredential(request.params.id);
          return { password: secret.password };
        },
      );
      scope.post<{ Params: { id: string } }>(
        '/api/vault/:id/security-code',
        async (request): Promise<VaultCardSecurityCode> => {
          z.object({})
            .strict()
            .parse(request.body ?? {});
          const { secret } = await readCard(request.params.id);
          if (!secret.securityCode)
            throw new VaultError('This card has no saved security code.', 404);
          return { securityCode: secret.securityCode };
        },
      );
      scope.post<{ Params: { id: string } }>(
        '/api/vault/:id/card-number',
        async (request): Promise<VaultCardNumber> => {
          z.object({})
            .strict()
            .parse(request.body ?? {});
          const { secret } = await readCard(request.params.id);
          return { cardNumber: secret.cardNumber };
        },
      );
      scope.delete<{ Params: { id: string } }>('/api/vault/:id', async (request) => {
        await pool.query(
          'WITH login AS (DELETE FROM vault_entries WHERE id=$1 AND owner_id=$2 RETURNING id) DELETE FROM vault_cards WHERE id=$1 AND owner_id=$2',
          [z.uuid().parse(request.params.id), owner],
        );
        return { ok: true };
      });
      scope.get<{ Params: { id: string } }>('/api/credential-requests/:id', async (request) =>
        describe(request.params.id),
      );
      scope.post<{ Params: { id: string } }>(
        '/api/credential-requests/:id/refresh',
        async (request) => refreshRequest(request.params.id),
      );
      scope.post<{ Params: { id: string } }>(
        '/api/credential-requests/:id/retry',
        async (request) => retry(request.params.id),
      );
      scope.post<{ Params: { id: string } }>(
        '/api/credential-requests/:id/method',
        async (request) => selectMethod(request.params.id, request.body),
      );
      scope.post<{ Params: { id: string } }>(
        '/api/credential-requests/:id/saved',
        async (request) => selectSaved(request.params.id, request.body),
      );
      scope.post<{ Params: { id: string } }>(
        '/api/credential-requests/:id',
        { bodyLimit: 16_384 },
        async (request) => submit(request.params.id, request.body),
      );
    });
  }

  return { registerRoutes, request, list, fillSaved, fillSelected, resumePending };
}
