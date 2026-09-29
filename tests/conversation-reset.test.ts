import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { RuntimeContext } from '../src/ports/agent.ts';

test(
  'reset archives the thread, revokes old work and resumes on a fresh thread while preserving saved data',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_reset_${suffix}`;
    const bossSchema = `test_reset_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const thread = await import('../src/server/thread.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { createVault } = await import('../src/server/vault.ts');
    const { createApprovals } = await import('../src/server/approvals.ts');
    const { createTriage } = await import('../src/server/triage.ts');
    const { configuration, ownerId, port, dataRoot } = await import('../src/server/config.ts');
    const { events } = await import('../src/server/events.ts');
    await db.initializeDatabase();
    await thread.initializeThreads();
    const personal = createPersonalService({
      pool: db.pool,
      ownerId,
      scheduler: thread.boss,
      enqueueTurn: thread.enqueueTurn,
      refresh() {},
    });
    await personal.initialize({ workers: false });
    let injected = 0;
    let executed = 0;
    const fixtureKey = randomBytes(32);
    const vault = await createVault(db.pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => fixtureKey },
      inject: async () => {
        injected++;
      },
      resume: thread.resumeAfterCredentials,
      retry: thread.retryCredentials,
    });
    const approvals = await createApprovals(async () => {
      executed++;
      return {};
    });
    const userMessages = thread.createUserMessageService({ confirmAction: approvals.acceptChat });
    const app = await createApp({
      submitMessage: userMessages.submit,
      configuration: () => ({ ...configuration(), llmReady: true }),
      onboard: (_timeZone, threadId) => thread.restartOnboarding(threadId),
    });
    personal.registerRoutes(app);
    vault.registerRoutes(app);
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    const request = (
      method: 'GET' | 'POST' | 'PUT',
      path: string,
      payload?: Record<string, unknown>,
    ) => app.inject({ method, url: path, headers, payload });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: RuntimeContext[] = [];
    const deltas: Array<{ turnId?: string; threadId?: string }> = [];
    const onEvent = (event: { type: string; turnId?: string; threadId?: string }) => {
      if (event.type === 'delta') deltas.push(event);
    };
    events.on('event', onEvent);
    const waitFor = async (predicate: () => Promise<boolean>) => {
      for (let i = 0; i < 100; i++) {
        if (await predicate()) return;
        await delay(30);
      }
      throw new Error('Reset fixture did not complete.');
    };
    const running = async (text: string, channel?: string) => {
      const turn = await thread.submitUserMessage(text, [], channel ? { channel } : {});
      await db.pool.query("UPDATE turns SET status='running' WHERE id=$1", [turn.turnId]);
      return turn;
    };
    try {
      const old = await running('Archived unique conversation phrase');
      await thread.reply(old, 'Archived answer.');
      await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [old.turnId]);
      const oldMessage = (
        await db.pool.query("SELECT id FROM messages WHERE turn_id=$1 AND role='assistant'", [
          old.turnId,
        ])
      ).rows[0].id as string;
      const oldUser = old.messageId;
      await request('PUT', '/api/profile', {
        name: 'Fixture name',
        location: 'Lisbon',
        phone: '',
        preferences: 'Concise',
      });
      await db.pool.query(
        "INSERT INTO memory_facts(id,owner_id,text,source_message_id) VALUES($1,$2,'Saved fixture preference',$3)",
        [randomUUID(), ownerId, oldUser],
      );
      assert.equal((await request('POST', '/api/goals', { title: 'Saved goal' })).statusCode, 200);
      assert.equal(
        (
          await request('POST', '/api/schedules', {
            title: 'Saved routine',
            prompt: 'Check a fixture',
            cron: '0 9 * * 1',
            timeZone: 'Europe/Lisbon',
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await request('POST', '/api/vault', {
            label: 'Saved account',
            origin: 'https://example.com',
            username: 'fixture',
            password: 'synthetic-secret',
          })
        ).statusCode,
        200,
      );
      await db.pool.query(
        'CREATE TABLE app_connections(id uuid PRIMARY KEY,owner_id text,account_id text)',
      );
      await db.pool.query("INSERT INTO app_connections VALUES($1,$2,'saved-fixture-account')", [
        randomUUID(),
        ownerId,
      ]);
      const credentialTurn = await running('Old credential task');
      const credential = await vault.request(credentialTurn, ownerId, {
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password',
        passwordSelector: '#password',
      });
      await db.pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1",
        [credentialTurn.turnId],
      );
      const approvalTurn = await running('Old approval task');
      await approvals.request(approvalTurn, 'FIXTURE_WRITE', {});
      const confirmationMessageId = (
        await db.pool.query('SELECT confirmation_message_id FROM approvals WHERE turn_id=$1', [
          approvalTurn.turnId,
        ])
      ).rows[0].confirmation_message_id;
      await db.pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='approval' WHERE id=$1",
        [approvalTurn.turnId],
      );
      const other = await running('Telegram message on the same thread', 'telegram:fixture');
      await thread.reply(other, 'Telegram answer.');
      await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [other.turnId]);
      assert.equal(other.threadId, old.threadId);
      for (const reaction of ['🧑🏽‍💻', '🧑🏽‍💻'])
        assert.equal(
          (await request('POST', `/api/messages/${oldMessage}/reaction`, { reaction })).statusCode,
          200,
        );
      assert.equal(
        (await db.pool.query("SELECT id FROM turns WHERE source_id LIKE 'reaction:%'")).rowCount,
        1,
      );
      assert.equal(
        (await request('POST', `/api/messages/${oldMessage}/reaction`, { reaction: 'not emoji' }))
          .statusCode,
        400,
      );
      await thread.stopThread();
      await thread.boss.deleteAllJobs('thread-drain');
      await thread.startThreadWorkers({
        runTurn: async (context) => {
          seen.push(context);
          if (context.prompt === 'Hold old worker') {
            context.delta('Old stream', randomUUID());
            await new Promise<void>((resolve) => {
              context.signal.addEventListener('abort', () => resolve());
              void gate.then(resolve);
            });
          } else if (context.prompt === 'Fresh conversation') {
            context.delta('Fresh stream', randomUUID());
            await context.reply('Fresh answer.');
          }
          return { status: 'succeeded' };
        },
        speech: {
          synthesize: async () => {
            throw new Error('Unused');
          },
        },
        requestCredential: async () => ({}),
        integration: async () => ({}),
        manage: async () => ({}),
      });
      const held = await thread.submitUserMessage('Hold old worker');
      await waitFor(async () => seen.some((context) => context.turnId === held.turnId));
      const heldContext = seen.find((context) => context.turnId === held.turnId)!;
      assert.equal(heldContext.threadId, old.threadId);
      const reset = await request('POST', '/api/conversation/reset', {});
      assert.equal(reset.statusCode, 200, reset.body);
      const freshThread = reset.json<{ ok: boolean; threadId: string }>().threadId;
      assert.equal(reset.json().ok, true);
      assert.notEqual(freshThread, old.threadId);
      assert.deepEqual(
        (
          await db.pool.query(
            'SELECT archived_at IS NOT NULL AS archived FROM threads WHERE id=$1',
            [old.threadId],
          )
        ).rows[0],
        { archived: true },
      );
      assert.equal(heldContext.signal.aborted, true);
      await assert.rejects(heldContext.reply('Late old answer'), /no longer active/);
      await assert.rejects(
        heldContext.publishScreenshot!(Buffer.from('Late screen')),
        /no longer active/,
      );
      assert.equal(
        (await db.pool.query('SELECT id FROM artifacts WHERE thread_id=$1', [old.threadId]))
          .rowCount,
        0,
      );
      const before = deltas.length;
      heldContext.delta('Late old stream', randomUUID());
      assert.equal(deltas.length, before);
      const state = (await request('GET', '/api/state')).json();
      assert.equal(state.threadId, freshThread);
      assert.deepEqual(state.messages, []);
      assert.deepEqual(state.turns, []);
      assert.equal(
        (await db.pool.query("SELECT thread_id FROM messages WHERE text='Telegram answer.'"))
          .rows[0].thread_id,
        old.threadId,
      );
      assert.deepEqual((await request('GET', '/api/messages')).json(), {
        messages: [],
        hasMore: false,
      });
      assert.equal(
        (await request('GET', `/api/messages?threadId=${old.threadId}`)).statusCode,
        409,
      );
      assert.equal(
        (await request('POST', '/api/messages', { text: 'Stale draft', threadId: old.threadId }))
          .statusCode,
        409,
      );
      assert.equal(
        (await request('POST', '/api/onboarding', { threadId: old.threadId })).statusCode,
        409,
      );
      assert.equal(
        (await request('POST', `/api/messages/${oldMessage}/reaction`, { reaction: '😀' }))
          .statusCode,
        404,
      );
      assert.equal(
        (
          await request('POST', '/api/messages', {
            text: 'Old reply',
            replyToMessageId: oldMessage,
          })
        ).statusCode,
        404,
      );
      const archived = await personal.manage('history_search', { query: 'Archived' });
      assert.deepEqual(archived, { turns: [], messages: [] });
      const triageContexts: unknown[] = [];
      const triage = createTriage({
        getProfile: personal.getProfile,
        listGoals: personal.listGoals,
        classifier: {
          id: 'fixture',
          configured: true,
          classify: async (context) => {
            triageContexts.push(context);
            return 'digest';
          },
        },
      });
      await triage.initializeHeartbeat();
      await triage.triageEvent('Synthetic update after reset', 'reset-triage-fixture');
      assert.equal(triageContexts.length, 1);
      assert.equal(JSON.stringify(triageContexts).includes('Archived'), false);
      assert.equal(JSON.stringify(triageContexts).includes('Hold old worker'), false);
      assert.equal(
        (
          await request('POST', '/api/messages', {
            text: 'yes',
            replyToMessageId: confirmationMessageId,
            threadId: freshThread,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await request('POST', credential.url.replace('/vault/', '/api/credential-requests/'), {
            password: 'must-not-inject',
          })
        ).statusCode,
        409,
      );
      assert.equal(executed, 0);
      assert.equal(injected, 0);
      assert.equal((await request('GET', '/api/goals')).json().length, 1);
      assert.equal((await request('GET', '/api/schedules')).json().length, 1);
      assert.equal((await request('GET', '/api/vault')).json().length, 1);
      assert.equal((await request('GET', '/api/profile')).json().name, 'Fixture name');
      assert.equal((await request('GET', '/api/memory')).json().length, 1);
      assert.equal(
        (await db.pool.query('SELECT account_id FROM app_connections')).rows[0].account_id,
        'saved-fixture-account',
      );
      assert.ok(
        (await db.pool.query('SELECT id FROM messages WHERE turn_id=$1', [old.turnId])).rowCount,
      );
      await waitFor(
        async () =>
          (await db.pool.query('SELECT status FROM turns WHERE id=$1', [held.turnId])).rows[0]
            .status === 'cancelled',
      );
      const fresh = await request('POST', '/api/messages', {
        text: 'Fresh conversation',
        threadId: freshThread,
      });
      assert.equal(fresh.statusCode, 200, fresh.body);
      assert.equal(fresh.json().threadId, freshThread);
      await waitFor(
        async () =>
          (await db.pool.query('SELECT status FROM turns WHERE id=$1', [fresh.json().turnId]))
            .rows[0].status === 'succeeded',
      );
      const current = seen.find((context) => context.turnId === fresh.json().turnId)!;
      assert.equal(current.threadId, freshThread);
      assert.notEqual(current.workspacePath, heldContext.workspacePath);
      assert.deepEqual(current.history, []);
      assert.ok(current.memories.some((text) => text.includes('Saved fixture preference')));
      assert.equal(deltas.find((event) => event.turnId === held.turnId)?.threadId, old.threadId);
      assert.equal(
        deltas.find((event) => event.turnId === fresh.json().turnId)?.threadId,
        freshThread,
      );
      assert.equal(
        (await db.pool.query("SELECT id FROM messages WHERE text='Late old answer'")).rowCount,
        0,
      );
    } finally {
      release();
      events.off('event', onEvent);
      await app.close();
      await thread.stopThreadWorkers();
      const ids = (await db.pool.query('SELECT id FROM threads')).rows.map(
        (row) => row.id as string,
      );
      await db.pool.end();
      for (const id of ids)
        await rm(join(dataRoot, 'workspaces', id), { recursive: true, force: true });
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
