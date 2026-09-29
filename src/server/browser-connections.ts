import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { getDomain } from 'tldts';
import { z } from 'zod';
import { BrowserActionError, type Computer, type LoginInspection } from '../ports/computer.ts';
import type { Connection } from '../shared/contracts.ts';
import { browserInputSchema } from '../shared/browser-input.ts';

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
  task_id: string | null;
  task_revision: number | null;
  active_task_id: string | null;
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
    resume?(taskId: string, revision: number, service: string): Promise<boolean>;
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
      task_id uuid,
      task_revision integer,
      active_task_id uuid,
      checked_at timestamptz,
      sign_in_started boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS browser_connections_owner ON browser_connections(owner_id,origin);
    ALTER TABLE browser_connections ADD COLUMN IF NOT EXISTS sign_in_started boolean NOT NULL DEFAULT false;
  `);
  const leases = new Map<string, { revision: number; until: number }>();
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

  async function attempt(rawToken: string): Promise<Row> {
    const row = (
      await pool.query<Row>(
        'SELECT * FROM browser_connections WHERE token_hash=$1 AND owner_id=$2',
        [hash(rawToken), options.ownerId],
      )
    ).rows[0];
    if (!row || !row.expires_at || row.expires_at.getTime() <= Date.now())
      throw new BrowserConnectionError('This sign-in link has expired.', 404);
    if (!['pending', 'saved'].includes(row.state))
      throw new BrowserConnectionError('This sign-in link is no longer active.', 409);
    return row;
  }

  async function taskReady(row: Row) {
    if (!row.task_id) return;
    const current = (
      await pool.query<{ status: string; revision: number }>(
        'SELECT status,revision FROM tasks WHERE id=$1 AND owner_id=$2',
        [row.task_id, options.ownerId],
      )
    ).rows[0];
    if (current?.revision !== row.task_revision || current.status !== 'waiting_user')
      throw new BrowserConnectionError('This task is no longer waiting for sign-in.');
  }

  async function claim(id: string, taskId: string, states: Row['state'][]) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (
        await client.query<Row>(
          'SELECT * FROM browser_connections WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [id, options.ownerId],
        )
      ).rows[0];
      if (!row || row.state === 'disconnecting')
        throw new BrowserConnectionError('This browser connection is unavailable.', 404);
      if (!states.includes(row.state))
        throw new BrowserConnectionError('This connection is not ready for this step.');
      if (row.active_task_id && row.active_task_id !== taskId) {
        const active = (
          await client.query<{ status: string }>(
            'SELECT status FROM tasks WHERE id=$1 AND owner_id=$2',
            [row.active_task_id, options.ownerId],
          )
        ).rows[0];
        if (
          active &&
          ['queued', 'running', 'waiting_user', 'waiting_credentials'].includes(active.status)
        )
          throw new BrowserConnectionError('This account is in use by another task.');
      }
      await client.query(
        'UPDATE browser_connections SET active_task_id=$3,updated_at=now() WHERE id=$1 AND owner_id=$2',
        [id, options.ownerId, taskId],
      );
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function beginUnlocked(
    raw: unknown,
    task?: { id: string; revision: number },
    signal?: AbortSignal,
  ) {
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
    if (task) {
      const current = (
        await pool.query<{ status: string; revision: number }>(
          'SELECT status,revision FROM tasks WHERE id=$1 AND owner_id=$2',
          [idSchema.parse(task.id), options.ownerId],
        )
      ).rows[0];
      if (current?.status !== 'running' || current.revision !== task.revision)
        throw new BrowserConnectionError('This task has changed.');
    }
    const id = input.connectionId ?? randomUUID();
    pendingLogins.delete(id);
    const existing = input.connectionId ? await owned(id) : null;
    const profileId = existing?.profile_id ?? randomUUID();
    if (existing && existing.origin !== address.origin)
      throw new BrowserConnectionError('This account belongs to another website.');
    if (existing && leases.has(id))
      throw new BrowserConnectionError('Finish the open private browser step first.');
    if (existing?.state === 'pending') await taskReady(existing);
    const token = randomBytes(32).toString('base64url');
    const pendingTask = existing?.state === 'pending' ? existing.task_id : null;
    const pendingRevision = existing?.state === 'pending' ? existing.task_revision : null;
    const browserId = task?.id ?? pendingTask ?? id;
    const label = input.label ?? existing?.label ?? name(address.origin);
    if (input.connectionId) {
      const current = await claim(id, browserId, ['pending', 'saved', 'needs_sign_in']);
      if (current.active_task_id && current.active_task_id !== browserId)
        await browser.close(current.active_task_id);
      await pool.query(
        `UPDATE browser_connections SET start_url=$3,label=$4,state='pending',token_hash=$5,
         expires_at=$6,task_id=$7,task_revision=$8,active_task_id=$9,
         sign_in_started=false,updated_at=now()
         WHERE id=$1 AND owner_id=$2`,
        [
          id,
          options.ownerId,
          address.href,
          label,
          hash(token),
          new Date(Date.now() + duration),
          task?.id ?? pendingTask,
          task?.revision ?? pendingRevision,
          browserId,
        ],
      );
    } else {
      await pool.query(
        `INSERT INTO browser_connections
         (id,owner_id,origin,start_url,label,profile_id,state,token_hash,expires_at,task_id,task_revision,active_task_id)
         VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$11)`,
        [
          id,
          options.ownerId,
          address.origin,
          address.href,
          label,
          profileId,
          hash(token),
          new Date(Date.now() + duration),
          task?.id ?? null,
          task?.revision ?? null,
          browserId,
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
         active_task_id=NULL,updated_at=now() WHERE id=$1 AND owner_id=$2`,
        [id, options.ownerId],
      );
      await browser.close(browserId).catch(() => {});
      if (signal?.aborted) signal.throwIfAborted();
      if (error instanceof BrowserConnectionError) throw error;
      throw new BrowserConnectionError(
        'The website could not open in Otto’s browser. Try again.',
        503,
      );
    }
  }

  async function begin(
    raw: unknown,
    task?: { id: string; revision: number },
    signal?: AbortSignal,
  ) {
    const input = inputSchema.parse(raw);
    return input.connectionId
      ? exclusive(input.connectionId, () => beginUnlocked(input, task, signal))
      : beginUnlocked(input, task, signal);
  }

  async function use(
    rawId: string,
    task: { id: string; revision: number },
    rawUrl: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (!browser.bindProfile) throw unavailable();
    const address = site(rawUrl);
    const existing = await owned(rawId);
    if (existing.origin !== address.origin)
      throw new BrowserConnectionError('This connection belongs to another website.');
    if (existing.state === 'needs_sign_in') {
      const link = await begin(
        { url: existing.start_url, connectionId: existing.id },
        task,
        signal,
      );
      return { ...link, status: 'needs_sign_in' as const };
    }
    const result = await exclusive(existing.id, async () => {
      signal?.throwIfAborted();
      const row = await claim(existing.id, idSchema.parse(task.id), ['saved']);
      const release = () =>
        pool.query(
          'UPDATE browser_connections SET active_task_id=NULL WHERE id=$1 AND owner_id=$2 AND active_task_id=$3',
          [row.id, options.ownerId, task.id],
        );
      try {
        if (row.active_task_id && row.active_task_id !== task.id)
          await browser.close(row.active_task_id);
        signal?.throwIfAborted();
        await browser.bindProfile!(task.id, row.profile_id, row.origin);
        signal?.throwIfAborted();
        let observation;
        try {
          observation = await browser.act(task.id, { action: 'open', url: address.href }, signal);
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
          await release();
          return {
            connectionId: row.id,
            status: 'site_blocked' as const,
            message: 'This website blocked Otto’s browser. Try an official account page later.',
          };
        }
        const inspection = await browser.inspectLogin(task.id);
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
      } catch (error) {
        await release();
        if (signal?.aborted) await browser.close(task.id).catch(() => {});
        throw error;
      }
    });
    if (result.status !== 'needs_sign_in') return result;
    const link = await begin({ url: existing.start_url, connectionId: existing.id }, task, signal);
    return { ...result, ...link, status: 'needs_sign_in' as const };
  }

  async function request(
    raw: unknown,
    task: { id: string; revision: number },
    signal?: AbortSignal,
  ) {
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
          task,
          signal,
        )
      : use(input.data.connectionId, task, input.data.url, signal);
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
    const browserId = row.task_id ?? row.id;
    let inspection: LoginInspection | null = null;
    if (row.state === 'pending' && !leases.has(row.id))
      inspection = await browser.inspectLogin(browserId).catch(() => null);
    return {
      name: name(row.origin),
      label: row.label,
      origin: row.origin,
      state: row.state,
      fromTask: Boolean(row.task_id),
      expiresAt: row.expires_at?.toISOString(),
      inspection: publicInspection(inspection, row.origin),
    };
  }

  async function submit(rawToken: string, raw: unknown) {
    const initial = await attempt(rawToken);
    return exclusive(initial.id, async () => {
      const row = await attempt(rawToken);
      await taskReady(row);
      if (row.state !== 'pending' || leases.has(row.id))
        throw new BrowserConnectionError('Finish the current browser step first.');
      const input = fieldSchema.parse(raw);
      const browserId = row.task_id ?? row.id;
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
          const current = (
            await client.query<Row>(
              'SELECT * FROM browser_connections WHERE id=$1 AND owner_id=$2 FOR UPDATE',
              [row.id, options.ownerId],
            )
          ).rows[0];
          if (current?.state !== 'pending' || current.token_hash !== row.token_hash)
            throw new BrowserConnectionError('This sign-in link is no longer active.');
          if (row.task_id) {
            const task = (
              await client.query<{ status: string; revision: number }>(
                'SELECT status,revision FROM tasks WHERE id=$1 AND owner_id=$2 FOR UPDATE',
                [row.task_id, options.ownerId],
              )
            ).rows[0];
            if (task?.status !== 'waiting_user' || task.revision !== row.task_revision)
              throw new BrowserConnectionError('This task is no longer waiting for sign-in.');
          }
          const submitted = await browser.injectCredentials({
            taskId: browserId,
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
    const row = await attempt(rawToken);
    return exclusive(row.id, async () => {
      await taskReady(row);
      if (row.state !== 'pending') throw new BrowserConnectionError('This sign-in has finished.');
      const previous = leases.get(row.id);
      if (previous && previous.until > Date.now())
        return { revision: previous.revision, mode: 'sign_in' as const, resumable: false };
      await browser.openSignIn!(row.task_id ?? row.id);
      const lease = { revision: Date.now(), until: Date.now() + duration };
      leases.set(row.id, lease);
      return { revision: lease.revision, mode: 'sign_in' as const, resumable: false };
    });
  }

  async function controlState(rawToken: string) {
    const row = await attempt(rawToken);
    const lease = leases.get(row.id);
    const active = Boolean(row.state === 'pending' && lease && lease.until > Date.now());
    return {
      paused: active,
      active,
      revision: active ? lease!.revision : null,
      mode: active ? ('sign_in' as const) : null,
      signInAvailable: true,
      resumable: false,
    };
  }

  async function current(rawToken: string, revision: number) {
    const row = await attempt(rawToken);
    await taskReady(row);
    const lease = leases.get(row.id);
    if (
      !lease ||
      lease.revision !== revision ||
      lease.until <= Date.now() ||
      row.state !== 'pending'
    )
      throw new BrowserConnectionError('This browser control session has ended.');
    return row;
  }

  async function frame(rawToken: string, revision: number, signal?: AbortSignal) {
    const row = await current(rawToken, revision);
    const bytes = await browser.signInScreenshot!(row.task_id ?? row.id, signal);
    await current(rawToken, revision);
    if (!bytes?.length) throw unavailable();
    return bytes;
  }

  async function input(rawToken: string, revision: number, value: unknown) {
    const row = await current(rawToken, revision);
    return exclusive(row.id, async () => {
      const action = browserInputSchema.parse(value);
      await browser.signInControl!(row.task_id ?? row.id, action);
      await current(rawToken, revision);
      if (['click', 'type', 'press'].includes(action.action))
        await pool.query(
          'UPDATE browser_connections SET sign_in_started=true,updated_at=now() WHERE id=$1 AND owner_id=$2',
          [row.id, options.ownerId],
        );
      return { ok: true };
    });
  }

  async function finish(rawToken: string, revision?: number) {
    const initial = await attempt(rawToken);
    return exclusive(initial.id, async () => {
      const row = await attempt(rawToken);
      if (row.state === 'saved') return { ok: true, connected: true };
      await taskReady(row);
      if (!row.sign_in_started && !row.checked_at)
        throw new BrowserConnectionError('Sign in on the website before saving this session.');
      const lease = leases.get(row.id);
      if (lease && lease.until > Date.now() && lease.revision !== revision)
        throw new BrowserConnectionError('This browser control session has changed.');
      const browserId = row.task_id ?? row.id;
      if (lease) {
        await browser.finishSignIn!(browserId);
        await browser.releaseControl?.(browserId);
        leases.delete(row.id);
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
      await pool.query(
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
      options.refresh?.();
      if (row.task_id && row.task_revision !== null)
        await options.resume?.(row.task_id, row.task_revision, name(row.origin));
      return { ok: true, connected: true, loginSaved };
    });
  }

  async function disconnect(rawId: string) {
    const id = idSchema.parse(rawId);
    return exclusive(id, async () => {
      const row = await owned(id);
      if (row.active_task_id) {
        const task = (
          await pool.query<{ status: string }>(
            'SELECT status FROM tasks WHERE id=$1 AND owner_id=$2',
            [row.active_task_id, options.ownerId],
          )
        ).rows[0];
        if (
          task &&
          ['queued', 'running', 'waiting_user', 'waiting_credentials'].includes(task.status)
        )
          throw new BrowserConnectionError(
            'Stop the active task before disconnecting this account.',
          );
      }
      await pool.query(
        `UPDATE browser_connections SET state='disconnecting',token_hash=NULL,expires_at=NULL,
         updated_at=now() WHERE id=$1 AND owner_id=$2`,
        [row.id, options.ownerId],
      );
      leases.delete(row.id);
      pendingLogins.delete(row.id);
      if (!browser.deleteProfile) throw unavailable();
      try {
        if (row.active_task_id) await browser.close(row.active_task_id);
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
          z.object({}).strict().parse(request.body);
          return start(request.params.token);
        },
      );
      scope.post<{ Params: { token: string } }>(
        '/api/browser-connections/attempt/:token/control/input',
        async (request) => {
          const body = z
            .object({
              revision: z.number().int(),
              input: browserInputSchema,
            })
            .strict()
            .parse(request.body);
          return input(request.params.token, body.revision, body.input);
        },
      );
      scope.get<{ Params: { token: string } }>(
        '/api/browser-connections/attempt/:token/control/sign-in-screen',
        async (request, reply) => {
          const revision = z.coerce
            .number()
            .int()
            .parse((request.query as { revision?: unknown }).revision);
          const bytes = await frame(request.params.token, revision);
          return reply.header('Cache-Control', 'no-store').type('image/png').send(bytes);
        },
      );
      scope.post<{ Params: { token: string } }>(
        '/api/browser-connections/attempt/:token/control/resume',
        async (request) => {
          const body = z.object({ revision: z.number().int() }).strict().parse(request.body);
          return finish(request.params.token, body.revision);
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
