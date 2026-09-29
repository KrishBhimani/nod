import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { ThreadDependencies } from '../src/server/thread.ts';

test(
  'connection callbacks wait durably for the originating turn to finish its consent wait',
  {
    skip: !process.env.TEST_DATABASE_URL,
    timeout: 30_000,
  },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '');
    const schema = `connection_resume_${suffix}`;
    const bossSchema = `connection_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const root = await mkdtemp(join(tmpdir(), 'otto-connection-resume-'));
    const previous = {
      DATABASE_URL: process.env.DATABASE_URL,
      PGBOSS_SCHEMA: process.env.PGBOSS_SCHEMA,
      OTTO_DATA_ROOT: process.env.OTTO_DATA_ROOT,
    };
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    process.env.OTTO_DATA_ROOT = root;
    const db = await import('../src/server/db.ts');
    const thread = await import('../src/server/thread.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const release = new Map<string, () => void>();
    const ready = new Set<string>();
    const runs: string[] = [];
    async function waitFor(condition: () => Promise<boolean>) {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (await condition()) return;
        await delay(10);
      }
      assert.fail('The connection resume fixture did not settle.');
    }
    const dependencies: ThreadDependencies = {
      speech: {
        synthesize: async () => ({
          bytes: Buffer.from('fixture'),
          fileName: 'fixture.mp3',
          mimeType: 'audio/mpeg',
        }),
      },
      requestCredential: async () => {
        throw new Error('Unused fixture');
      },
      integration: async () => {
        throw new Error('Unused fixture');
      },
      manage: async () => {
        throw new Error('Unused fixture');
      },
      runTurn: async (context) => {
        runs.push(context.turnId);
        if (!context.prompt.startsWith('connect-')) return { status: 'succeeded' };
        await context.waitForUser!('Complete the fixture connection.');
        await new Promise<void>((resolve) => {
          release.set(context.prompt, resolve);
          ready.add(context.prompt);
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        context.signal.throwIfAborted();
        if (context.prompt === 'connect-failure') throw new Error('Fixture runtime failed');
        return {
          status: 'waiting_user',
          waitingFor: context.prompt === 'connect-browser' ? 'browser' : 'question',
        };
      },
    };
    async function origin(prompt: string) {
      const accepted = await thread.submitUserMessage(prompt);
      await waitFor(async () => ready.has(prompt));
      assert.equal(await thread.resumeAfterConnection(accepted.turnId, 'Fixture'), true);
      const row = (
        await db.pool.query('SELECT status,pending_connection_service FROM turns WHERE id=$1', [
          accepted.turnId,
        ])
      ).rows[0];
      assert.deepEqual(row, { status: 'running', pending_connection_service: 'Fixture' });
      assert.equal(
        (
          await db.pool.query('SELECT count(*)::int AS count FROM turns WHERE source_id=$1', [
            `connection:${accepted.turnId}`,
          ])
        ).rows[0].count,
        0,
      );
      return accepted;
    }
    try {
      await db.initializeDatabase();
      await thread.initializeThreads();
      await createPersonalService({
        pool: db.pool,
        ownerId: 'local-development',
        scheduler: thread.boss,
        enqueueTurn: thread.enqueueTurn,
        refresh() {},
      }).initialize({ workers: false });
      await thread.startThreadWorkers(dependencies);
      for (const reason of ['question', 'browser'])
        await t.test(
          `a callback during the ${reason} wait queues exactly one resume after finalization`,
          async () => {
            const prompt = `connect-${reason}`;
            const accepted = await origin(prompt);
            assert.equal(await thread.resumeAfterConnection(accepted.turnId, 'Fixture'), true);
            release.get(prompt)!();
            await waitFor(async () =>
              Boolean(
                (
                  await db.pool.query(
                    "SELECT 1 FROM turns WHERE source_id=$1 AND status='succeeded'",
                    [`connection:${accepted.turnId}`],
                  )
                ).rowCount,
              ),
            );
            const rows = (
              await db.pool.query('SELECT id,thread_id,status FROM turns WHERE source_id=$1', [
                `connection:${accepted.turnId}`,
              ])
            ).rows;
            assert.equal(rows.length, 1);
            assert.equal(rows[0].thread_id, accepted.threadId);
            assert.equal(runs.filter((id) => id === rows[0].id).length, 1);
            assert.deepEqual(
              (
                await db.pool.query(
                  'SELECT status,waiting_reason,pending_connection_service FROM turns WHERE id=$1',
                  [accepted.turnId],
                )
              ).rows[0],
              { status: 'succeeded', waiting_reason: null, pending_connection_service: null },
            );
            assert.equal(await thread.resumeAfterConnection(accepted.turnId, 'Fixture'), true);
            assert.equal(
              (
                await db.pool.query('SELECT count(*)::int AS count FROM turns WHERE source_id=$1', [
                  `connection:${accepted.turnId}`,
                ])
              ).rows[0].count,
              1,
            );
          },
        );
      for (const outcome of ['failure', 'stop', 'reset'])
        await t.test(`${outcome} discards a deferred callback without replay`, async () => {
          const prompt = `connect-${outcome}`;
          const accepted = await origin(prompt);
          if (outcome === 'stop') await thread.stopThread();
          if (outcome === 'reset') await thread.resetThread();
          release.get(prompt)!();
          await waitFor(async () =>
            Boolean(
              (
                await db.pool.query(
                  "SELECT 1 FROM turns WHERE id=$1 AND status IN ('failed','cancelled')",
                  [accepted.turnId],
                )
              ).rowCount,
            ),
          );
          assert.equal(
            (
              await db.pool.query('SELECT pending_connection_service FROM turns WHERE id=$1', [
                accepted.turnId,
              ])
            ).rows[0].pending_connection_service,
            null,
          );
          assert.equal(
            (
              await db.pool.query('SELECT count(*)::int AS count FROM turns WHERE source_id=$1', [
                `connection:${accepted.turnId}`,
              ])
            ).rows[0].count,
            0,
          );
          assert.equal(await thread.resumeAfterConnection(accepted.turnId, 'Fixture'), false);
        });
    } finally {
      for (const resolve of release.values()) resolve();
      await thread.stopThreadWorkers();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
