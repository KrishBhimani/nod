import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { getDomain } from 'tldts';
import { z } from 'zod';
import { BrowserActionError, type Computer, type LoginInspection } from '../ports/computer.ts';
import type { Connection } from '../shared/contracts.ts';
import { browserInputSchema } from '../shared/browser-input.ts';
import type { TurnRef } from './thread.ts';

const idSchema = z.uuid();
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const inputSchema = z
  .object({
    url: z.url().max(2048),
    label: z.string().trim().min(1).max(100).optional(),
    connectionId: idSchema.optional(),
  })
  .strict();
const requestSchema = z.discriminatedUnion('action', [
  inputSchema.extend({ action: z.literal('connect') }),
  inputSchema.omit({ label: true }).extend({ action: z.literal('use'), connectionId: idSchema }),
]);
const fieldSchema = z
  .object({
    origin: z.url().max(2048),
    username: z.string().max(320).optional(),
    password: z.string().max(8192).optional(),
    code: z
      .string()
      .regex(/^[0-9]{4,8}$/)
      .optional(),
    saveLogin: z.boolean().optional(),
  })
  .strict();
const duration = 30 * 60_000;

type Row = {
  id: string;
  owner_id: string;
  origin: string;
  start_url: string;
  label: string;
  profile_id: string;
  state: 'pending' | 'saved' | 'needs_sign_in' | 'disconnecting';
  token_hash: string | null;
  expires_at: Date | null;
  thread_id: string | null;
  turn_id: string | null;
  checked_at: Date | null;
  sign_in_started: boolean;
};

export class BrowserConnectionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}

function site(raw: string) {
  const url = new URL(raw);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new BrowserConnectionError('Use a secure website address.', 400);
  url.hash = '';
  return url;
}

function name(origin: string) {
  const hostname = new URL(origin).hostname;
  return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
}

function sameSite(left: string, right: string) {
  const first = new URL(left);
  const second = new URL(right);
  if (first.protocol !== second.protocol) return false;
  if (first.origin === second.origin) return true;
  if (first.protocol !== 'https:') return false;
  if (first.port !== second.port) return false;
  const leftDomain = getDomain(first.hostname, { allowPrivateDomains: true });
  return Boolean(
    leftDomain && leftDomain === getDomain(second.hostname, { allowPrivateDomains: true }),
  );
}

function blockedPage(text: string) {
  return /\b403 ERROR\b|request blocked|access denied/i.test(text);
}

function slug(origin: string) {
  return `browser-${name(origin)
    .replace(/[^a-z0-9]/gi, '-')
    .toLowerCase()
    .slice(0, 40)}-${createHash('sha256').update(origin).digest('hex').slice(0, 12)}`;
}

function publicInspection(inspection: LoginInspection | null, origin: string) {
  if (!inspection) return null;
  return {
    origin: inspection.origin,
    canSubmit: sameSite(inspection.origin, origin),
    fields: inspection.fields.map(({ kind, label }) => ({ kind, label })),
    methods: inspection.methods.map(({ label, kind, supported }) => ({
      label,
      kind,
      supported,
    })),
    issue: inspection.issue ?? null,
  };
}

export async function createBrowserConnections(
  pool: Pick<Pool, 'query' | 'connect'>,
  options: {
    ownerId: string;
    computer: Computer;
    resume?(turnId: string, service: string): Promise<boolean>;
    saveLogin?(origin: string, label: string, username: string, password: string): Promise<string>;
    refresh?(): void;
  },
) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS browser_connections (
      id uuid PRIMARY KEY,
      owner_id text NOT NULL,
      origin text NOT NULL,
      start_url text NOT NULL,
      label text NOT NULL,
      profile_id uuid NOT NULL UNIQUE,
      state text NOT NULL,
      token_hash text UNIQUE,
      expires_at timestamptz,
      thread_id uuid,
      turn_id uuid,
      checked_at timestamptz,
      sign_in_started boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS browser_connections_owner ON browser_connections(owner_id,origin);
    ALTER TABLE browser_connections ADD COLUMN IF NOT EXISTS sign_in_started boolean NOT NULL DEFAULT false;
    ALTER TABLE browser_connections ADD COLUMN IF NOT EXISTS thread_id uuid;
    ALTER TABLE browser_connections ADD COLUMN IF NOT EXISTS turn_id uuid;
  `);
  const controlled = new Set<string>();
  const pendingLogins = new Map<
    string,
    { origin: string; label: string; username: string; password: string; expiresAt: number }
  >();
  const queues = new Map<string, Promise<unknown>>();
  const browser = options.computer;
  const unavailable = () => new BrowserConnectionError('The private browser is unavailable.', 503);
  const hash = (token: string) =>
    createHash('sha256').update(tokenSchema.parse(token)).digest('hex');

  function exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const pending = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    queues.set(id, pending);
    void pending
      .finally(() => {
        if (queues.get(id) === pending) queues.delete(id);
      })
      .catch(() => {});
    return pending;
  }

  async function owned(id: string): Promise<Row> {
    const row = (
      await pool.query<Row>('SELECT * FROM browser_connections WHERE id=$1 AND owner_id=$2', [
        idSchema.parse(id),
        options.ownerId,
      ])
    ).rows[0];
    if (!row) throw new BrowserConnectionError('This browser connection is unavailable.', 404);
    return row;
  }

  async function attempt(
    rawToken: string,
    database: Pick<Pool, 'query'> = pool,
    lock = '',
  ): Promise<Row> {
    const row = (
      await database.query<Row>(
        `SELECT * FROM browser_connections WHERE token_hash=$1 AND owner_id=$2 ${lock}`,
        [hash(rawToken), options.ownerId],
      )
    ).rows[0];
    if (!row || !row.expires_at || row.expires_at.getTime() <= Date.now())
      throw new BrowserConnectionError('This sign-in link has expired.', 404);
    if (!['pending', 'saved'].includes(row.state))
      throw new BrowserConnectionError('This sign-in link is no longer active.', 409);
    return row;
  }

  async function threadReady(row: Row, database: Pick<Pool, 'query'> = pool, lock = '') {
    if (!row.turn_id && !row.thread_id) return;
    const thread = await database.query(
      `SELECT 1 FROM threads th JOIN turns u ON u.thread_id=th.id AND u.owner_id=th.owner_id
       WHERE th.id=$1 AND th.owner_id=$2 AND th.archived_at IS NULL
       AND u.id=$3 AND u.status='waiting' AND u.waiting_reason='browser' ${lock}`,
      [row.thread_id, options.ownerId, row.turn_id],
    );
    if (!thread.rowCount)
      throw new BrowserConnectionError('This conversation is no longer waiting for sign-in.');
  }

  async function signIn<T>(
    rawToken: string,
    operation: (row: Row, client: PoolClient) => Promise<T>,
  ) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':' || $1,0))",
        [`thread:${options.ownerId}`],
      );
      const row = await attempt(rawToken, client, 'FOR UPDATE');
      await threadReady(row, client, 'FOR SHARE OF th,u');
      const result = await operation(row, client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function ready(id: string, states: Row['state'][]) {
    const row = await owned(id);
    if (row.state === 'disconnecting')
      throw new BrowserConnectionError('This browser connection is unavailable.', 404);
    if (!states.includes(row.state))
      throw new BrowserConnectionError('This connection is not ready for this step.');
    return row;
  }

  async function beginUnlocked(raw: unknown, turn?: TurnRef, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (
      !browser.bindProfile ||
      !browser.openSignIn ||
      !browser.finishSignIn ||
      !browser.signInScreenshot ||
      !browser.signInControl
    )
      throw unavailable();
    const input = inputSchema.parse(raw);
    const address = site(input.url);
    const id = input.connectionId ?? randomUUID();
    pendingLogins.delete(id);
    const existing = input.connectionId ? await owned(id) : null;
    const profileId = existing?.profile_id ?? randomUUID();
    if (existing && existing.origin !== address.origin)
      throw new BrowserConnectionError('This account belongs to another website.');
    if (existing && controlled.has(id))
      throw new BrowserConnectionError('Finish the open private browser step first.');
    if (existing?.state === 'pending') {
      if (turn) {
        const current = await pool.query(
          `SELECT 1 FROM turns u JOIN threads th ON th.id=u.thread_id AND th.owner_id=u.owner_id
           WHERE u.id=$1 AND u.thread_id=$2 AND u.owner_id=$3 AND u.status='running' AND th.archived_at IS NULL`,
          [turn.turnId, turn.threadId, options.ownerId],
        );
        if (!current.rowCount)
          throw new BrowserConnectionError('This conversation can no longer request sign-in.');
      } else await threadReady(existing);
    }
    const token = randomBytes(32).toString('base64url');
    const pendingThread = existing?.state === 'pending' ? existing.thread_id : null;
    const pendingTurn = existing?.state === 'pending' ? existing.turn_id : null;
    const browserId = turn?.threadId ?? pendingThread ?? id;
    const label = input.label ?? existing?.label ?? name(address.origin);
    if (input.connectionId) {
      await ready(id, ['pending', 'saved', 'needs_sign_in']);
      await pool.query(
        `UPDATE browser_connections SET start_url=$3,label=$4,state='pending',token_hash=$5,
         expires_at=$6,thread_id=$7,turn_id=$8,
         sign_in_started=false,updated_at=now()
         WHERE id=$1 AND owner_id=$2`,
        [
          id,
          options.ownerId,
          address.href,
          label,
          hash(token),
          new Date(Date.now() + duration),
          turn?.threadId ?? pendingThread,
          turn?.turnId ?? pendingTurn,
        ],
      );
    } else {
      await pool.query(
        `INSERT INTO browser_connections
         (id,owner_id,origin,start_url,label,profile_id,state,token_hash,expires_at,thread_id,turn_id)
         VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10)`,
        [
          id,
          options.ownerId,
          address.origin,
          address.href,
          label,
          profileId,
          hash(token),
          new Date(Date.now() + duration),
          turn?.threadId ?? null,
          turn?.turnId ?? null,
        ],
      );
    }
    try {
      await browser.bindProfile(browserId, profileId);
      signal?.throwIfAborted();
      let observation = await browser.act(browserId, { action: 'open', url: address.href }, signal);
      for (let step = 0; step < 2; step += 1) {
        signal?.throwIfAborted();
        if (blockedPage(observation.text))
          throw new BrowserConnectionError(
            'This website blocked Otto’s browser. Try an official sign-in page for this service.',
          );
        const inspection = await browser.inspectLogin(browserId).catch(() => null);
        if (inspection?.fields.length || inspection?.methods.length) break;
        if (!sameSite(observation.url, address.origin)) break;
        const choices = observation.candidates.filter((candidate) =>
          /(?:sign\s*in|log\s*in|login|my account|account sign\s*in)/i.test(candidate.label),
        );
        if (choices.length !== 1) break;
        observation = await browser.act(
          browserId,
          {
            action: 'click',
            selector: choices[0].id,
          },
          signal,
        );
      }
      signal?.throwIfAborted();
      await browser.hold(browserId, Date.now() + duration);
      signal?.throwIfAborted();
      options.refresh?.();
      return { name: label, url: `/browser-connect/${token}`, connectionId: id };
    } catch (error) {
      await pool.query(
        `UPDATE browser_connections SET state='needs_sign_in',token_hash=NULL,expires_at=NULL,
         updated_at=now() WHERE id=$1 AND owner_id=$2`,
        [id, options.ownerId],
      );
      if (browserId === id) await browser.close(id).catch(() => {});
      if (signal?.aborted) signal.throwIfAborted();
      if (error instanceof BrowserConnectionError) throw error;
      throw new BrowserConnectionError(
        'The website could not open in Otto’s browser. Try again.',
        503,
      );
    }
  }

  async function begin(raw: unknown, turn?: TurnRef, signal?: AbortSignal) {
    const input = inputSchema.parse(raw);
    return input.connectionId
      ? exclusive(input.connectionId, () => beginUnlocked(input, turn, signal))
      : beginUnlocked(input, turn, signal);
  }

  async function use(rawId: string, turn: TurnRef, rawUrl: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!browser.bindProfile) throw unavailable();
    const address = site(rawUrl);
    const existing = await owned(rawId);
    if (existing.origin !== address.origin)
      throw new BrowserConnectionError('This connection belongs to another website.');
    if (existing.state === 'needs_sign_in') {
      const link = await begin(
        { url: existing.start_url, connectionId: existing.id },
        turn,
        signal,
      );
      return { ...link, status: 'needs_sign_in' as const };
    }
    const result = await exclusive(existing.id, async () => {
      signal?.throwIfAborted();
      const browserId = idSchema.parse(turn.threadId);
      const row = await ready(existing.id, ['saved']);
      await pool.query(
        'UPDATE browser_connections SET thread_id=$3,updated_at=now() WHERE id=$1 AND owner_id=$2',
        [row.id, options.ownerId, browserId],
      );
      await browser.bindProfile!(browserId, row.profile_id, row.origin);
      signal?.throwIfAborted();
      let observation;
      try {
        observation = await browser.act(browserId, { action: 'open', url: address.href }, signal);
      } catch (error) {
        if (!(error instanceof BrowserActionError) || error.code !== 'browser_origin_changed')
          throw error;
        await pool.query(
          `UPDATE browser_connections SET state='needs_sign_in',updated_at=now() WHERE id=$1 AND owner_id=$2`,
          [row.id, options.ownerId],
        );
        options.refresh?.();
        return { connectionId: row.id, status: 'needs_sign_in' as const };
      }
      signal?.throwIfAborted();
      if (blockedPage(observation.text)) {
        return {
          connectionId: row.id,
          status: 'site_blocked' as const,
          message: 'This website blocked Otto’s browser. Try an official account page later.',
        };
      }
      const inspection = await browser.inspectLogin(browserId);
      signal?.throwIfAborted();
      if (inspection?.fields.length || inspection?.methods.length) {
        await pool.query(
          `UPDATE browser_connections SET state='needs_sign_in',updated_at=now() WHERE id=$1 AND owner_id=$2`,
          [row.id, options.ownerId],
        );
        options.refresh?.();
        return { connectionId: row.id, status: 'needs_sign_in' as const };
      }
      await pool.query(
        `UPDATE browser_connections SET checked_at=now(),updated_at=now()
         WHERE id=$1 AND owner_id=$2 AND state='saved'`,
        [row.id, options.ownerId],
      );
      options.refresh?.();
      return {
        connectionId: row.id,
        status: 'session_opened' as const,
        message:
          'The saved browser session opened. Check the page before relying on account access.',
        observation,
      };
    });
    if (result.status !== 'needs_sign_in') return result;
    const link = await begin({ url: existing.start_url, connectionId: existing.id }, turn, signal);
    return { ...result, ...link, status: 'needs_sign_in' as const };
  }

  async function request(raw: unknown, turn: TurnRef, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const input = requestSchema.safeParse(raw);
    const invalid = {
      status: 'rejected' as const,
      code: 'invalid_browser_connection_arguments',
      message:
        'Use connect with a secure website URL, or use with a saved browser session UUID and URL. Saved Vault credentials require the browser and request_credentials after fresh inspection. No browser action was started.',
    };
    if (!input.success) return invalid;
    let address: URL;
    try {
      address = site(input.data.url);
    } catch (error) {
      if (error instanceof BrowserConnectionError && error.statusCode === 400) return invalid;
      throw error;
    }
    if (input.data.connectionId) {
      const found = await pool.query<{ id: string; origin: string; state: string }>(
        'SELECT id,origin,state FROM browser_connections WHERE id=$1 AND owner_id=$2',
        [input.data.connectionId, options.ownerId],
      );
      signal?.throwIfAborted();
      const states =
        input.data.action === 'connect'
          ? ['pending', 'saved', 'needs_sign_in']
          : ['saved', 'needs_sign_in'];
      if (!found.rows.length || !states.includes(found.rows[0].state))
        return {
          status: 'rejected' as const,
          code: 'browser_connection_unavailable',
          message:
            'The selected saved browser session is unavailable. Check manage_apps for browserAccess: browser_session. Entries marked credentials_saved require the browser and request_credentials after fresh inspection. No browser action was started.',
        };
      if (found.rows[0].origin !== address.origin)
        return {
          status: 'rejected' as const,
          code: 'browser_connection_origin_mismatch',
          message:
            'The selected saved browser session belongs to another website origin. Use its saved origin or connect to the requested website separately. No browser action was started.',
        };
    }
    signal?.throwIfAborted();
    return input.data.action === 'connect'
      ? begin(
          {
            url: input.data.url,
            connectionId: input.data.connectionId,
            label: input.data.label,
          },
          turn,
          signal,
        )
      : use(input.data.connectionId, turn, input.data.url, signal);
  }

  async function list(): Promise<Connection[]> {
    const rows = (
      await pool.query<Row>(
        `SELECT * FROM browser_connections WHERE owner_id=$1 ORDER BY created_at DESC`,
        [options.ownerId],
      )
    ).rows;
    return rows.map((row) => ({
      slug: slug(row.origin),
      name: name(row.origin),
      status: row.state === 'saved' ? 'connected' : 'disconnected',
      connectionId: row.id,
      accountName: row.label,
      triggersEnabled: false,
      supportsTriggers: false,
      browserState: row.state,
      checkedAt: row.checked_at?.toISOString(),
      browserUrl: row.start_url,
      accessPaths: [{ id: row.id, kind: 'browser' as const, endpoint: row.origin }],
    }));
  }

  async function describe(rawToken: string) {
    const row = await attempt(rawToken);
    await threadReady(row);
    const browserId = row.thread_id ?? row.id;
    let inspection: LoginInspection | null = null;
    if (row.state === 'pending' && !controlled.has(row.id))
      inspection = await browser.inspectLogin(browserId).catch(() => null);
    return {
      name: name(row.origin),
      label: row.label,
      origin: row.origin,
      state: row.state,
      fromChat: Boolean(row.turn_id),
      expiresAt: row.expires_at?.toISOString(),
      inspection: publicInspection(inspection, row.origin),
    };
  }

  async function submit(rawToken: string, raw: unknown) {
    const initial = await attempt(rawToken);
    return exclusive(initial.id, async () => {
      const row = await attempt(rawToken);
      await threadReady(row);
      if (row.state !== 'pending' || controlled.has(row.id))
        throw new BrowserConnectionError('Finish the current browser step first.');
      const input = fieldSchema.parse(raw);
      const browserId = row.thread_id ?? row.id;
      const inspection = await browser.inspectLogin(browserId);
      if (inspection.origin !== input.origin || !sameSite(inspection.origin, row.origin))
        throw new BrowserConnectionError(
          'The sign-in page changed. Check its address and try again.',
        );
      const username = inspection.fields.filter((field) => field.kind === 'identifier');
      const password = inspection.fields.filter((field) => field.kind === 'password');
      const code = inspection.fields.filter((field) => field.kind === 'otp');
      if (code.length && (username.length || password.length))
        throw new BrowserConnectionError('Use the private browser for this sign-in form.');
      const kind =
        password.length === 1 && input.password
          ? 'password'
          : username.length === 1 && input.username
            ? 'identifier'
            : code.length === 1 && input.code
              ? 'otp'
              : null;
      if (!kind) throw new BrowserConnectionError('Check the current sign-in fields.');
      const client = await pool.connect();
      const result = await (async () => {
        try {
          await client.query('BEGIN');
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':' || $1,0))",
            [`thread:${options.ownerId}`],
          );
          const current = (
            await client.query<Row>(
              'SELECT * FROM browser_connections WHERE id=$1 AND owner_id=$2 FOR UPDATE',
              [row.id, options.ownerId],
            )
          ).rows[0];
          if (
            current?.state !== 'pending' ||
            current.token_hash !== row.token_hash ||
            !current.expires_at ||
            current.expires_at.getTime() <= Date.now()
          )
            throw new BrowserConnectionError('This sign-in link is no longer active.');
          await threadReady(current, client, 'FOR SHARE OF th,u');
          const submitted = await browser.injectCredentials({
            threadId: browserId,
            origin: inspection.origin,
            kind,
            ...(kind === 'password'
              ? {
                  password: input.password,
                  passwordSelector: password[0].selector,
                  ...(username.length === 1 && input.username
                    ? {
                        username: input.username,
                        usernameSelector: username[0].selector,
                      }
                    : {}),
                }
              : kind === 'identifier'
                ? {
                    username: input.username,
                    usernameSelector: username[0].selector,
                  }
                : {
                    code: input.code,
                    passwordSelector: code[0].selector,
                  }),
            submitSelector: inspection.submitSelector,
          });
          if (submitted?.status !== 'rejected')
            await client.query(
              'UPDATE browser_connections SET sign_in_started=true,updated_at=now() WHERE id=$1 AND owner_id=$2',
              [row.id, options.ownerId],
            );
          await client.query('COMMIT');
          return submitted;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      })();
      if (
        result?.status === 'submitted' &&
        input.saveLogin &&
        kind === 'password' &&
        input.username &&
        options.saveLogin
      ) {
        const login = {
          origin: inspection.origin,
          label: row.label,
          username: input.username,
          password: input.password!,
          expiresAt: row.expires_at!.getTime(),
        };
        pendingLogins.set(row.id, login);
        const timer = setTimeout(
          () => {
            if (pendingLogins.get(row.id) === login) pendingLogins.delete(row.id);
          },
          Math.max(0, login.expiresAt - Date.now()),
        );
        timer.unref();
      } else if (kind === 'password') pendingLogins.delete(row.id);
      return {
        status: result?.status ?? 'submitted',
        inspection: publicInspection(
          await browser.inspectLogin(browserId).catch(() => null),
          row.origin,
        ),
      };
    });
  }

  async function start(rawToken: string) {
    const initial = await attempt(rawToken);
    return exclusive(initial.id, () =>
      signIn(rawToken, async (row) => {
        if (row.state !== 'pending') throw new BrowserConnectionError('This sign-in has finished.');
        if (!controlled.has(row.id)) {
          await browser.openSignIn!(row.thread_id ?? row.id);
          controlled.add(row.id);
        }
        return { mode: 'sign_in' as const, resumable: false };
      }),
    );
  }

  async function controlState(rawToken: string) {
    const row = await attempt(rawToken);
    await threadReady(row);
    const active = row.state === 'pending' && controlled.has(row.id);
    return {
      paused: active,
      active,
      mode: active ? ('sign_in' as const) : null,
      signInAvailable: true,
      resumable: false,
    };
  }

  async function current(rawToken: string) {
    const row = await attempt(rawToken);
    await threadReady(row);
    if (!controlled.has(row.id) || row.state !== 'pending')
      throw new BrowserConnectionError('This browser control session has ended.');
    return row;
  }

  async function frame(rawToken: string, signal?: AbortSignal) {
    const row = await current(rawToken);
    const bytes = await browser.signInScreenshot!(row.thread_id ?? row.id, signal);
    await current(rawToken);
    if (!bytes?.length) throw unavailable();
    return bytes;
  }

  async function input(rawToken: string, value: unknown) {
    const row = await current(rawToken);
    return exclusive(row.id, () =>
      signIn(rawToken, async (row, client) => {
        if (!controlled.has(row.id) || row.state !== 'pending')
          throw new BrowserConnectionError('This browser control session has ended.');
        const action = browserInputSchema.parse(value);
        await browser.signInControl!(row.thread_id ?? row.id, action);
        await current(rawToken);
        if (['click', 'type', 'press'].includes(action.action))
          await client.query(
            'UPDATE browser_connections SET sign_in_started=true,updated_at=now() WHERE id=$1 AND owner_id=$2',
            [row.id, options.ownerId],
          );
        return { ok: true };
      }),
    );
  }

  async function finish(rawToken: string) {
    const initial = await attempt(rawToken);
    return exclusive(initial.id, async () => {
      const completed = await signIn(rawToken, async (row, client) => {
        if (row.state === 'saved') return { row };
        if (!row.sign_in_started && !row.checked_at)
          throw new BrowserConnectionError('Sign in on the website before saving this session.');
        const browserId = row.thread_id ?? row.id;
        if (controlled.has(row.id)) {
          await browser.finishSignIn!(browserId);
          await browser.releaseControl?.(browserId);
          controlled.delete(row.id);
        }
        const current = await browser.inspectLogin(browserId);
        if (current.fields.some((field) => field.kind === 'otp'))
          throw new BrowserConnectionError(
            'This website needs a verification code. Enter it here or in the private browser.',
          );
        if (current.fields.length || current.methods.length)
          throw new BrowserConnectionError(
            'Sign-in is still needed. Complete it here or in the private browser.',
          );
        const observation = await browser.act(browserId, { action: 'open', url: row.start_url });
        if (blockedPage(observation.text))
          throw new BrowserConnectionError('This website blocked Otto’s browser. Try again later.');
        const inspection = await browser.inspectLogin(browserId);
        if (
          new URL(observation.url).origin !== row.origin ||
          inspection?.fields.length ||
          inspection?.methods.length
        )
          throw new BrowserConnectionError(
            'Sign-in is still needed. Complete it in the browser and try again.',
          );
        await browser.bindProfile!(browserId, row.profile_id, row.origin);
        await browser.hold(browserId, null);
        await client.query(
          `UPDATE browser_connections SET state='saved',checked_at=now(),updated_at=now()
         WHERE id=$1 AND owner_id=$2 AND state='pending'`,
          [row.id, options.ownerId],
        );
        const login = pendingLogins.get(row.id);
        pendingLogins.delete(row.id);
        let loginSaved: boolean | undefined;
        if (login && login.expiresAt > Date.now() && options.saveLogin) {
          try {
            await options.saveLogin(login.origin, login.label, login.username, login.password);
            loginSaved = true;
          } catch {
            loginSaved = false;
          }
        }
        return { row, loginSaved };
      });
      options.refresh?.();
      if (completed.row.turn_id)
        await options.resume?.(completed.row.turn_id, name(completed.row.origin));
      return { ok: true, connected: true, loginSaved: completed.loginSaved };
    });
  }

  async function disconnect(rawId: string) {
    const id = idSchema.parse(rawId);
    return exclusive(id, async () => {
      const row = await owned(id);
      const browserId = row.thread_id ?? row.id;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':' || $1,0))",
          [`thread:${options.ownerId}`],
        );
        const working = await client.query(
          `SELECT 1 FROM threads th WHERE th.id=$1 AND th.owner_id=$2 AND th.archived_at IS NULL
           AND (th.status<>'idle' OR EXISTS(SELECT 1 FROM turns u WHERE u.thread_id=th.id
           AND u.owner_id=th.owner_id AND u.status IN ('queued','running','waiting')))`,
          [browserId, options.ownerId],
        );
        if (working.rowCount)
          throw new BrowserConnectionError(
            'Stop the active work before disconnecting this account.',
          );
        await client.query(
          `UPDATE browser_connections SET state='disconnecting',token_hash=NULL,expires_at=NULL,
           updated_at=now() WHERE id=$1 AND owner_id=$2`,
          [row.id, options.ownerId],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      controlled.delete(row.id);
      pendingLogins.delete(row.id);
      if (!browser.deleteProfile) throw unavailable();
      try {
        await browser.close(browserId);
        await browser.deleteProfile(row.profile_id);
      } catch {
        throw new BrowserConnectionError(
          'The private browser profile could not be removed. Try again.',
          503,
        );
      }
      await pool.query('DELETE FROM browser_connections WHERE id=$1 AND owner_id=$2', [
        row.id,
        options.ownerId,
      ]);
      options.refresh?.();
      return { ok: true };
    });
  }

  function registerRoutes(app: FastifyInstance) {
    app.register(async (scope) => {
      scope.setErrorHandler((error, _request, reply) => {
        const status =
          error instanceof BrowserConnectionError
            ? error.statusCode
            : error instanceof z.ZodError
              ? 400
              : 503;
        reply.code(status).send({
          error:
            error instanceof BrowserConnectionError
              ? error.message
              : status === 400
                ? 'Check the connection fields.'
                : 'The browser connection is unavailable.',
        });
      });
      scope.post('/api/browser-connections', async (request) => begin(request.body));
      scope.get('/api/browser-connections', list);
      scope.get<{ Params: { token: string } }>(
        '/api/browser-connections/attempt/:token',
        async (request) => describe(request.params.token),
      );
      scope.post<{ Params: { token: string } }>(
        '/api/browser-connections/attempt/:token/credentials',
        { bodyLimit: 16_384 },
        async (request) => submit(request.params.token, request.body),
      );
      scope.get<{ Params: { token: string } }>(
        '/api/browser-connections/attempt/:token/control',
        async (request) => controlState(request.params.token),
      );
      scope.post<{ Params: { token: string } }>(
        '/api/browser-connections/attempt/:token/control/start',
        async (request) => {
          z.object({})
            .strict()
            .parse(request.body ?? {});
          return start(request.params.token);
        },
      );
      scope.post<{ Params: { token: string } }>(
        '/api/browser-connections/attempt/:token/control/input',
        async (request) => {
          const body = z.object({ input: browserInputSchema }).strict().parse(request.body);
          return input(request.params.token, body.input);
        },
      );
      scope.get<{ Params: { token: string } }>(
        '/api/browser-connections/attempt/:token/control/sign-in-screen',
        async (request, reply) => {
          const bytes = await frame(request.params.token);
          return reply.header('Cache-Control', 'no-store').type('image/png').send(bytes);
        },
      );
      scope.post<{ Params: { token: string } }>(
        '/api/browser-connections/attempt/:token/control/resume',
        async (request) => {
          z.object({})
            .strict()
            .parse(request.body ?? {});
          return finish(request.params.token);
        },
      );
      scope.post<{ Params: { token: string } }>(
        '/api/browser-connections/attempt/:token/finish',
        async (request) => {
          z.object({}).strict().parse(request.body);
          return finish(request.params.token);
        },
      );
      scope.post<{ Params: { id: string } }>(
        '/api/browser-connections/:id/disconnect',
        async (request) => disconnect(request.params.id),
      );
    });
  }

  return { begin, use, request, list, disconnect, registerRoutes };
}
