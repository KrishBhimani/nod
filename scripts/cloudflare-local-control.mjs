import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import { parseCredentialKey } from '../src/providers/environment/key-store.ts';
import {
  deploymentHeader,
  deploymentPath,
  deploymentRequestSchema,
  signDeploymentRequest,
} from '../src/server/deployment-auth.ts';

const origin = 'http://localhost:4330';
const unavailable = () => new Error('Local Cloudflare control could not confirm a safe state.');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const installationSchema = z
  .object({
    version: z.literal(1),
    release: z.string().regex(/^[a-f0-9]{40}$/),
    binding: digest,
  })
  .strict();
const operationSchema = deploymentRequestSchema.omit({ action: true });
const stateSchema = operationSchema
  .extend({
    phase: z.enum([
      'draining',
      'prepared',
      'activating',
      'aborting',
      'failed',
      'complete',
      'aborted',
    ]),
    receipts: z
      .array(
        z
          .object({
            ownerId: z.uuid(),
            generation: z.string().regex(/^[1-9]\d{0,19}$/),
          })
          .strict(),
      )
      .max(1024),
  })
  .strict();
const journalSchema = z
  .object({
    version: z.literal(1),
    binding: digest,
    operation: operationSchema,
    prepared: stateSchema.nullable(),
  })
  .strict();

export async function assertLocalCloudflarePortFree(port = 4330) {
  const server = createServer();
  try {
    await new Promise((complete, reject) => {
      server.once('error', () => reject(unavailable()));
      server.listen({ port, host: '127.0.0.1', exclusive: true }, complete);
    });
  } finally {
    if (server.listening) await new Promise((complete) => server.close(complete));
  }
}

async function readPrivate(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 256 * 1024 ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw unavailable();
    return JSON.parse(await file.readFile('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw unavailable();
  } finally {
    await file?.close();
  }
}

async function syncDirectory(directory) {
  const file = await open(directory, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function writePrivate(directory, path, value, replace = false) {
  const target = replace ? `${path}.${randomUUID()}.tmp` : path;
  const file = await open(target, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  if (replace) await rename(target, path);
  await syncDirectory(directory);
}

async function lock(directory, name) {
  const path = join(directory, name);
  const token = { pid: process.pid, nonce: randomUUID() };
  await writePrivate(directory, path, token);
  return async () => {
    const current = await readPrivate(path);
    if (current?.pid !== token.pid || current?.nonce !== token.nonce) throw unavailable();
    await unlink(path);
    await syncDirectory(directory);
  };
}

function matches(state, input) {
  return (
    state?.nonce === input.nonce &&
    state.targetRelease === input.targetRelease &&
    state.previousRelease === input.previousRelease &&
    state.deadline === input.deadline
  );
}

function sameReceipts(first, second) {
  const canonical = (state) =>
    state.receipts
      .map(({ ownerId, generation }) => [ownerId, generation])
      .sort(([first], [second]) => first.localeCompare(second));
  return JSON.stringify(canonical(first)) === JSON.stringify(canonical(second));
}

export async function openLocalCloudflareControl(
  directory,
  environment,
  {
    resume = false,
    fetcher = fetch,
    now = Date.now,
    readinessMs = 600_000,
    requestMs = 50_000,
    drainMs = 300_000,
    intervalMs = 1000,
  } = {},
) {
  let releaseLauncher;
  try {
    if (
      environment.COMPUTER_PROVIDER !== 'cloudflare' ||
      environment.SIDEKICK_ENVIRONMENT?.toLowerCase() === 'production' ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(environment.SIDEKICK_ENVIRONMENT ?? '') ||
      environment.SIDEKICK_PUBLIC_URL !== origin
    )
      throw unavailable();
    const masterKey = parseCredentialKey(environment.SIDEKICK_MASTER_KEY ?? '');
    const database = new URL(environment.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw unavailable();
    const binding = createHash('sha256')
      .update(
        JSON.stringify([
          environment.SIDEKICK_ENVIRONMENT,
          origin,
          database.href,
          masterKey.toString('base64'),
        ]),
      )
      .digest('hex');
    if (!resume) await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw unavailable();
    if (!resume) releaseLauncher = await lock(directory, 'launcher.lock');
    const installationFile = join(directory, 'local-installation.json');
    let installation = await readPrivate(installationFile);
    if (!installation) {
      if (resume) throw unavailable();
      installation = { version: 1, release: randomBytes(20).toString('hex'), binding };
      await writePrivate(directory, installationFile, installation);
    }
    installation = installationSchema.parse(installation);
    if (installation.binding !== binding) throw unavailable();
    const release = installation.release;
    const journalFile = join(directory, 'local-shutdown.json');
    const cancellation = new AbortController();
    const pending = new Set();
    let releaseControl;
    let closing;

    async function readJournal() {
      const raw = await readPrivate(journalFile);
      if (!raw) return null;
      const journal = journalSchema.parse(raw);
      if (
        journal.binding !== binding ||
        journal.operation.previousRelease !== release ||
        journal.operation.targetRelease !== release ||
        (journal.prepared &&
          (journal.prepared.phase !== 'prepared' || !matches(journal.prepared, journal.operation)))
      )
        throw unavailable();
      return journal;
    }

    async function request(path, options = {}, timeout = requestMs) {
      const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(timeout)]);
      let rejectAborted;
      const aborted = new Promise((_, reject) => {
        rejectAborted = () =>
          reject(
            cancellation.signal.aborted
              ? unavailable()
              : Object.assign(unavailable(), { name: 'TimeoutError' }),
          );
      });
      signal.addEventListener('abort', rejectAborted, { once: true });
      let reader;
      const fetching = Promise.resolve().then(() =>
        fetcher(new URL(path, origin), {
          ...options,
          redirect: 'error',
          cache: 'no-store',
          signal,
        }),
      );
      void fetching
        .then((response) => {
          if (signal.aborted) void response.body?.cancel().catch(() => {});
        })
        .catch(() => {});
      const chunks = [];
      let size = 0;
      try {
        signal.throwIfAborted();
        const response = await Promise.race([fetching, aborted]);
        reader = response.body?.getReader();
        if (!reader) throw unavailable();
        while (true) {
          signal.throwIfAborted();
          const result = await Promise.race([reader.read(), aborted]);
          if (result.done) break;
          size += result.value.byteLength;
          if (size > 128 * 1024) throw unavailable();
          chunks.push(result.value);
        }
        signal.throwIfAborted();
        let value;
        try {
          value = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
          );
        } catch {
          throw unavailable();
        }
        return { status: response.status, value };
      } finally {
        signal.removeEventListener('abort', rejectAborted);
        if (reader) {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
    }

    async function healthy() {
      const deadline = now() + readinessMs;
      while (true) {
        cancellation.signal.throwIfAborted();
        let result;
        try {
          result = await request(
            '/api/health',
            {},
            Math.max(1, Math.min(requestMs, deadline - now())),
          );
        } catch (error) {
          if (
            cancellation.signal.aborted ||
            now() >= deadline ||
            !['TypeError', 'TimeoutError', 'AbortError'].includes(error?.name)
          )
            throw unavailable();
        }
        if (result?.status === 200) {
          if (result.value?.ok !== true || result.value.release !== release) throw unavailable();
          return;
        }
        if ((result && result.status !== 503) || now() >= deadline) throw unavailable();
        await wait(Math.min(intervalMs, Math.max(1, deadline - now())), undefined, {
          signal: cancellation.signal,
        });
      }
    }

    function newOperation() {
      return {
        nonce: randomUUID(),
        previousRelease: release,
        targetRelease: release,
        deadline: now() + drainMs,
      };
    }

    async function control(action, input) {
      const body = Buffer.from(JSON.stringify({ ...input, action }));
      const token = signDeploymentRequest({
        masterKey,
        environment: environment.SIDEKICK_ENVIRONMENT,
        body,
        now: now(),
      });
      const result = await request(
        deploymentPath,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', [deploymentHeader]: token },
          body,
        },
        action === 'prepare' ? Math.max(1, input.deadline - now() + 1000) : requestMs,
      );
      if (result.status !== 200 || result.value?.ok !== true) throw unavailable();
      const state = stateSchema.nullable().parse(result.value.state);
      if (
        state &&
        new Set(state.receipts.map((receipt) => receipt.ownerId)).size !== state.receipts.length
      )
        throw unavailable();
      if (action !== 'status' && !matches(state, input)) throw unavailable();
      return state;
    }

    async function recover(explicit) {
      const journal = await readJournal();
      if (explicit && !journal) throw unavailable();
      await healthy();
      const state = await control('status', journal?.operation ?? newOperation());
      if (!journal) {
        if (state && !['complete', 'aborted'].includes(state.phase)) throw unavailable();
        return;
      }
      if (
        !matches(state, journal.operation) ||
        (journal.prepared && !sameReceipts(state, journal.prepared)) ||
        !['prepared', 'aborted', ...(explicit ? ['draining', 'failed', 'aborting'] : [])].includes(
          state.phase,
        )
      )
        throw unavailable();
      if (state.phase !== 'aborted') {
        const aborted = await control('abort', journal.operation);
        if (aborted.phase !== 'aborted' || !sameReceipts(aborted, state)) throw unavailable();
      }
      cancellation.signal.throwIfAborted();
      await unlink(journalFile);
      await syncDirectory(directory);
    }

    function operation(run, hold = false) {
      const result = (async () => {
        const unlock = await lock(directory, 'local-control.lock');
        let retained = false;
        try {
          cancellation.signal.throwIfAborted();
          const value = await run();
          if (hold) {
            releaseControl = unlock;
            retained = true;
          }
          return value;
        } finally {
          if (!retained) await unlock();
        }
      })().catch(() => {
        throw unavailable();
      });
      pending.add(result);
      void result.finally(() => pending.delete(result)).catch(() => {});
      return result;
    }

    return {
      release,
      recover: () => operation(() => recover(false)),
      resume: () => operation(() => recover(true)),
      prepare: () =>
        operation(async () => {
          if (await readJournal()) throw unavailable();
          await healthy();
          const input = newOperation();
          const previous = await control('status', input);
          if (previous && !['complete', 'aborted'].includes(previous.phase)) throw unavailable();
          const journal = { version: 1, binding, operation: input, prepared: null };
          await writePrivate(directory, journalFile, journal);
          const state = await control('prepare', input);
          if (state.phase !== 'prepared') throw unavailable();
          cancellation.signal.throwIfAborted();
          await writePrivate(directory, journalFile, { ...journal, prepared: state }, true);
        }, true),
      cancel: () => cancellation.abort(),
      close() {
        closing ??= (async () => {
          cancellation.abort();
          await Promise.allSettled([...pending]);
          await releaseControl?.();
          releaseControl = undefined;
          await releaseLauncher?.();
          releaseLauncher = undefined;
        })();
        return closing;
      },
    };
  } catch {
    await releaseLauncher?.();
    throw unavailable();
  }
}

export async function superviseLocalCloudflare(
  child,
  control,
  { signals = process, report = console.log } = {},
) {
  let running = true;
  let stopping = false;
  let stop;
  const exited = new Promise((complete) => {
    child.once('error', () => complete(1));
    child.once('exit', (code) => complete(code ?? 1));
  }).finally(() => {
    running = false;
    control.cancel();
  });
  const ready = control.recover();
  void ready.catch(() =>
    report(
      'Local Cloudflare recovery was refused. Keep its state and use --resume only for the recorded operation.',
    ),
  );
  const handlers = new Map(
    ['SIGINT', 'SIGTERM'].map((signal) => [
      signal,
      () => {
        if (!running) return;
        if (stop) {
          report('Local Cloudflare is still draining. Repeated signals do not force shutdown.');
          return;
        }
        stop = (async () => {
          await ready.catch(() => {});
          report('Waiting for accepted work and clean computer checkpoints before stopping.');
          await control.prepare();
          if (!running) return;
          stopping = true;
          child.kill(signal);
        })()
          .catch(() =>
            report(
              'Local Cloudflare could not stop safely and remains running. Use the same --env file with --resume before another stop request.',
            ),
          )
          .finally(() => {
            stop = undefined;
          });
      },
    ]),
  );
  for (const [signal, handler] of handlers) signals.on(signal, handler);
  try {
    const code = await exited;
    await Promise.allSettled([ready, stop]);
    if (!stopping)
      report(
        'Local Cloudflare exited without a confirmed safe shutdown. Its recorded state was preserved.',
      );
    return code;
  } finally {
    for (const [signal, handler] of handlers) signals.off(signal, handler);
  }
}
