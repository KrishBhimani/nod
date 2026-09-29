import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import pg from 'pg';
import { registerLocalAccess } from '../src/server/access.ts';
import type { ApprovalExecutionContext } from '../src/server/approvals.ts';

test('localhost access rejects foreign Host, Origin and browser cross-site requests', async () => {
  const app = Fastify();
  registerLocalAccess(app, 4310);
  app.get('/api/fixture', async () => ({ ok: true }));
  app.post('/api/fixture', async () => ({ ok: true }));
  app.get('/api/apps/callback', async () => ({ ok: true }));
  try {
    for (const headers of [
      { host: 'attacker.example:4310' },
      { host: 'localhost:4311' },
      { host: 'localhost:4310', origin: 'https://attacker.example' },
      { host: 'localhost:4310', origin: 'null' },
      { host: 'localhost:4310', origin: 'https://localhost:4310' },
      { host: 'localhost:4310', 'sec-fetch-site': 'cross-site' },
    ])
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/fixture', headers })).statusCode,
        403,
      );
    for (const host of ['localhost:4310', '127.0.0.1:4310', '[::1]:4310']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/fixture',
        headers: { host, origin: `http://${host}` },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
    }
    assert.equal(
      (
        await app.inject({
          url: '/api/apps/callback?fixture=yes',
          headers: { host: 'localhost:4310', 'sec-fetch-site': 'cross-site' },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});

test(
  'server artifacts, approvals and personal data preserve PostgreSQL ownership and review boundaries',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 45_000 },
  async (t) => {
    const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'otto-server-boundaries-')));
    const previousDirectory = process.cwd();
    process.chdir(fixtureRoot);
    t.after(async () => {
      process.chdir(previousDirectory);
      await rm(fixtureRoot, { recursive: true, force: true });
    });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_server_${suffix}`;
    const bossSchema = `test_server_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = databaseUrl.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const thread = await import('../src/server/thread.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const artifacts = await import('../src/server/artifacts.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { createApprovals } = await import('../src/server/approvals.ts');
    const { dataRoot, ownerId, port, configuration } = await import('../src/server/config.ts');
    assert.equal(dataRoot, join(fixtureRoot, '.local'));
    let userMessages: ReturnType<typeof thread.createUserMessageService>;
    const app = await createApp({
      submitMessage: (text, attachments, options) =>
        userMessages.submit(text, attachments, options),
      configuration: () => configuration({ llmReady: true }),
    });
    const personal = createPersonalService({
      pool: db.pool,
      ownerId,
      scheduler: thread.boss,
      enqueueTurn: thread.enqueueTurn,
      refresh() {},
    });
    const calls: Array<{
      action: string;
      args: Record<string, unknown>;
      context: ApprovalExecutionContext;
    }> = [];
    let failExecution = false;
    let rejectPreflight = false;
    let executionGate: Promise<void> | undefined;
    const directories: string[] = [];
    let approvals: Awaited<ReturnType<typeof createApprovals>>;
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    const request = (
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url,
        headers,
        ...(payload === undefined
          ? {}
          : {
              payload: JSON.stringify(payload),
              headers: { ...headers, 'content-type': 'application/json' },
            }),
      });
    const newTurn = async (status = 'running', text = 'Synthetic boundary fixture') => {
      const submitted = await thread.submitUserMessage(text);
      await db.pool.query('UPDATE turns SET status=$2 WHERE id=$1', [submitted.turnId, status]);
      return submitted;
    };
    const turnStatus = async (turnId: string) =>
      (await db.pool.query('SELECT status FROM turns WHERE id=$1', [turnId])).rows[0].status;
    const stored = async (id: string) =>
      (await db.pool.query('SELECT * FROM approvals WHERE id=$1', [id])).rows[0];
    const resumeTurns = async (id: string) =>
      (
        await db.pool.query(
          "SELECT id,status,prompt,background FROM turns WHERE source='resume' AND source_id LIKE $1",
          [`confirmation:${id}:%`],
        )
      ).rows;
    async function propose(
      turn: { threadId: string; turnId: string },
      action: string,
      args: Record<string, unknown>,
    ) {
      const result = await approvals.request(turn, action, args);
      assert.ok(result && typeof result === 'object' && 'requiresConfirmation' in result);
      assert.equal(result.requiresConfirmation, true);
      assert.equal('url' in result, false);
      const record = (
        await db.pool.query(
          'SELECT * FROM approvals WHERE turn_id=$1 AND action=$2 AND args=$3::jsonb',
          [turn.turnId, action, JSON.parse(JSON.stringify(args))],
        )
      ).rows[0];
      assert.ok(record.confirmation_message_id);
      return record.id as string;
    }
    async function confirm(id: string, approved: boolean, extra: Record<string, unknown> = {}) {
      const record = await stored(id);
      return db.transaction((client) =>
        approvals.acceptChat(client, {
          text: approved ? 'Yes' : 'No',
          channel: 'web',
          threadId: record.thread_id,
          replyToMessageId: record.confirmation_message_id,
          clientMessageId: randomUUID(),
          ...extra,
        }),
      );
    }
    async function execute(id: string, signal = new AbortController().signal) {
      const record = await stored(id);
      await db.pool.query("UPDATE turns SET status='running' WHERE id=$1 AND status='queued'", [
        record.execution_turn_id,
      ]);
      return approvals.executeConfirmed(record.execution_turn_id, signal);
    }
    try {
      await db.initializeDatabase();
      await thread.initializeThreads();
      await personal.initialize({ workers: false });
      await db.pool.query(`CREATE TABLE channel_inbox (
        source_id text PRIMARY KEY,owner_id text NOT NULL,provider text NOT NULL,
        channel text,message_id uuid,received_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE channel_outbox (
        message_id uuid PRIMARY KEY,source_id text NOT NULL REFERENCES channel_inbox(source_id)
      )`);
      approvals = await createApprovals(
        async (action, args, context) => {
          calls.push({ action, args, context });
          if (executionGate) await executionGate;
          if (failExecution) throw new Error('Fixture provider detail must not be exposed.');
          return { successful: true, id: 'fixture-provider-result' };
        },
        async () => {
          if (rejectPreflight)
            throw Object.assign(new Error('This approval needs a new account selection.'), {
              statusCode: 409,
            });
        },
      );
      userMessages = thread.createUserMessageService({ confirmAction: approvals.acceptChat });
      personal.registerRoutes(app);
      app.get('/api/fixture-error', async () => {
        throw new Error('fixture-private-key');
      });

      await t.test(
        'artifacts are owned, path bounded, and active documents download with sandbox headers',
        async () => {
          const { threadId: id } = await newTurn('succeeded');
          const workspace = join(dataRoot, 'workspaces', id);
          const privateDir = await mkdtemp(join(tmpdir(), 'otto-artifact-test-'));
          directories.push(workspace, privateDir);
          await mkdir(workspace, { recursive: true });
          await writeFile(join(privateDir, 'private.txt'), 'private fixture');
          await symlink(join(privateDir, 'private.txt'), join(workspace, 'escape.txt'));
          const read = async (threadId: string, path: string, maxBytes: number) => {
            assert.equal(threadId, id);
            const handle = await open(
              join(workspace, path),
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
              const stat = await handle.stat();
              assert.ok(stat.isFile() && stat.size <= maxBytes);
              return await handle.readFile();
            } finally {
              await handle.close();
            }
          };
          await assert.rejects(
            artifacts.publishArtifact(id, join(privateDir, 'private.txt'), undefined, read),
          );
          await assert.rejects(artifacts.publishArtifact(id, 'escape.txt', undefined, read));
          await writeFile(join(workspace, 'report.html'), '<script>window.fixture=true</script>');
          const published = await artifacts.publishArtifact(
            id,
            'report.html',
            '../../report\r\n.html',
            read,
          );
          assert.equal(published.name, 'report.html');
          const response = await request('GET', published.url);
          assert.equal(response.statusCode, 200);
          assert.match(String(response.headers['content-disposition']), /^attachment;/);
          assert.equal(response.headers['content-type'], 'text/html');
          assert.equal(response.headers['content-security-policy'], "default-src 'none'; sandbox");
          assert.equal(response.headers['x-content-type-options'], 'nosniff');
          assert.match(response.body, /window.fixture/);
          for (const [name, mime] of [
            ['preview.pdf', 'application/pdf'],
            ['preview.mp4', 'video/mp4'],
            ['preview.m4a', 'audio/mp4'],
            ['preview.svg', 'image/svg+xml'],
          ]) {
            await writeFile(join(workspace, name), '0123456789');
            const media = await artifacts.publishArtifact(id, name, undefined, read);
            assert.equal(media.mimeType, mime);
            const full = await request('GET', media.url);
            assert.match(String(full.headers['content-disposition']), /^inline;/);
            assert.equal(full.headers['cache-control'], 'private, no-store');
            assert.equal(full.headers['content-security-policy'], "default-src 'none'; sandbox");
            assert.equal(full.headers['x-content-type-options'], 'nosniff');
            const partial = await app.inject({
              method: 'GET',
              url: media.url,
              headers: { ...headers, range: 'bytes=2-5' },
            });
            assert.equal(partial.statusCode, 206);
            assert.equal(partial.body, '2345');
            assert.equal(partial.headers['content-range'], 'bytes 2-5/10');
            const suffix = await app.inject({
              method: 'GET',
              url: media.url,
              headers: { ...headers, range: 'bytes=-3' },
            });
            assert.equal(suffix.body, '789');
            for (const range of [
              'bytes=30-',
              'bytes=5-2',
              'bytes=-0',
              'bytes=0-1,4-5',
              'bytes=-',
            ]) {
              const invalid = await app.inject({
                method: 'GET',
                url: media.url,
                headers: { ...headers, range },
              });
              assert.equal(invalid.statusCode, 416);
              assert.equal(invalid.headers['content-range'], 'bytes */10');
            }
            await db.pool.query('UPDATE artifacts SET owner_id=$2 WHERE id=$1', [
              media.id,
              'another-owner',
            ]);
            assert.equal(
              (
                await app.inject({
                  method: 'GET',
                  url: media.url,
                  headers: { ...headers, range: 'bytes=0-1' },
                })
              ).statusCode,
              404,
            );
          }
          await db.pool.query('UPDATE artifacts SET owner_id=$2 WHERE id=$1', [
            published.id,
            'another-owner',
          ]);
          assert.equal((await request('GET', published.url)).statusCode, 404);
          assert.equal((await request('GET', '/api/artifacts/not-a-uuid')).statusCode, 400);
          await assert.rejects(artifacts.storeArtifact(Buffer.alloc(0), 'empty', 'text/plain'));
          await assert.rejects(
            artifacts.storeArtifact(Buffer.alloc(artifacts.maxFileSize + 1), 'large', 'text/plain'),
          );
          const artifactDirectory = join(dataRoot, 'artifacts');
          const beforeFailedInsert = await readdir(artifactDirectory);
          await assert.rejects(
            artifacts.storeArtifact(
              Buffer.from('Orphan fixture'),
              'orphan.txt',
              'text/plain',
              randomUUID(),
            ),
          );
          assert.deepEqual(await readdir(artifactDirectory), beforeFailedInsert);
          const error = await request('GET', '/api/fixture-error');
          assert.equal(error.statusCode, 500);
          assert.equal(error.body.includes('fixture-private-key'), false);
        },
      );

      await t.test('removed approval HTTP routes cannot read or authorize an action', async () => {
        const id = await propose(await newTurn(), 'GMAIL_SEND_EMAIL', {});
        assert.equal((await request('GET', `/api/approvals/${id}`)).statusCode, 404);
        assert.equal(
          (await request('POST', `/api/approvals/${id}`, { approved: true })).statusCode,
          404,
        );
        assert.equal((await stored(id)).status, 'pending');
      });

      await t.test(
        'chat confirmation executes the stored snapshot once and queues only one continuation',
        async () => {
          const turn = await newTurn();
          const original = {
            recipient: 'fixture@example.test',
            subject: 'Confirmed snapshot',
            nested: { text: 'original' },
          };
          const id = await propose(turn, 'GMAIL_SEND_EMAIL', original);
          original.nested.text = 'changed after request';
          assert.equal((await stored(id)).args.nested.text, 'original');
          assert.equal(
            (
              await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: (await stored(id)).confirmation_message_id,
                args: { recipient: 'attacker@example.test' },
              })
            ).statusCode,
            400,
          );
          const before = calls.length;
          const decisions = await Promise.allSettled(
            Array.from({ length: 4 }, () => confirm(id, true)),
          );
          assert.equal(decisions.filter((result) => result.status === 'fulfilled').length, 1);
          for (const result of decisions)
            if (result.status === 'rejected') assert.equal(result.reason.statusCode, 409);
          assert.equal(calls.length, before);
          const resumed = await resumeTurns(id);
          assert.equal(resumed.length, 1);
          assert.equal(resumed[0].background, false);
          assert.equal((await stored(id)).execution_turn_id, resumed[0].id);
          const results = await Promise.all(Array.from({ length: 4 }, () => execute(id)));
          assert.equal(calls.length, before + 1);
          assert.deepEqual(calls.at(-1), {
            action: 'GMAIL_SEND_EMAIL',
            args: {
              recipient: 'fixture@example.test',
              subject: 'Confirmed snapshot',
              nested: { text: 'original' },
            },
            context: {
              threadId: turn.threadId,
              turnId: resumed[0].id,
              sourceMessageId: turn.messageId,
            },
          });
          const continued = results.filter(Boolean);
          assert.equal(continued.length, 1);
          assert.match(continued[0]!.prompt, /Do not repeat it/);
          assert.equal((await stored(id)).status, 'completed');
          assert.equal((await resumeTurns(id)).length, 1);
        },
      );

      await t.test(
        'confirmation provenance stays with its own user message and rejects turns without one',
        async () => {
          const first = await newTurn('running', 'Provenance fixture');
          const second = await newTurn('running', 'Provenance fixture');
          const [firstId, secondId] = await Promise.all([
            propose(first, 'OTTO_memory_propose', {
              text: 'First turn fact',
              sourceMessageId: second.messageId,
            }),
            propose(second, 'OTTO_memory_propose', { text: 'Second turn fact' }),
          ]);
          const eventTurn = await thread.enqueueTurn('Provenance fixture', { source: 'event' });
          await db.pool.query("UPDATE turns SET status='running' WHERE id=$1", [eventTurn]);
          await assert.rejects(
            approvals.request(
              { threadId: first.threadId, turnId: eventTurn },
              'OTTO_memory_propose',
              { text: 'No owned source' },
            ),
            /direct request/,
          );
          const foreignThread = await thread.activeThread(db.pool, 'another-owner');
          const foreignTurn = randomUUID();
          await db.pool.query(
            "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status) VALUES($1,'another-owner',$2,'user','Provenance fixture','running')",
            [foreignTurn, foreignThread.id],
          );
          await assert.rejects(
            approvals.request(
              { threadId: foreignThread.id, turnId: foreignTurn },
              'OTTO_memory_propose',
              { text: 'Foreign fact' },
            ),
            { statusCode: 409 },
          );
          await Promise.all([confirm(firstId, true), confirm(secondId, true)]);
          await Promise.all([execute(firstId), execute(secondId)]);
          const executionTurn = async (id: string) => (await stored(id)).execution_turn_id;
          const firstExecution = await executionTurn(firstId);
          const secondExecution = await executionTurn(secondId);
          assert.equal(
            calls.find((call) => call.context.turnId === firstExecution)?.context.sourceMessageId,
            first.messageId,
          );
          assert.equal(
            calls.find((call) => call.context.turnId === secondExecution)?.context.sourceMessageId,
            second.messageId,
          );
          assert.equal((await stored(firstId)).source_message_id, first.messageId);
          assert.equal(
            calls.some((call) => call.context.turnId === eventTurn),
            false,
          );
        },
      );

      await t.test(
        'a confirmation preserves its original source while a later message stays queued',
        async () => {
          const turn = await newTurn('running', 'Review the original synthetic fact');
          const later = await thread.submitUserMessage(
            'This later instruction must not become the earlier confirmation source',
            [],
            { replyToMessageId: turn.messageId },
          );
          assert.equal(await turnStatus(later.turnId), 'queued');
          const id = await propose(turn, 'OTTO_memory_propose', {
            text: 'The original synthetic fact',
          });
          await confirm(id, true);
          await execute(id);
          const executionTurn = (await stored(id)).execution_turn_id;
          assert.equal(
            calls.find((call) => call.context.turnId === executionTurn)?.context.sourceMessageId,
            turn.messageId,
          );
          assert.equal((await stored(id)).source_message_id, turn.messageId);
          assert.equal(await turnStatus(later.turnId), 'queued');
          await assert.rejects(
            approvals.request(
              { threadId: turn.threadId, turnId: executionTurn },
              'FIXTURE_SECOND_ACTION',
              {},
            ),
            /direct request/,
          );
          await thread.stopThread();
        },
      );

      await t.test(
        'preflight rejects invalid proposals and confirmed obsolete actions before any uncertain execution',
        async () => {
          const turn = await newTurn();
          const before = calls.length;
          rejectPreflight = true;
          try {
            await assert.rejects(approvals.request(turn, 'GMAIL_SEND_EMAIL', {}), {
              statusCode: 409,
            });
            assert.equal(
              (await db.pool.query('SELECT id FROM approvals WHERE turn_id=$1', [turn.turnId]))
                .rowCount,
              0,
            );
          } finally {
            rejectPreflight = false;
          }
          const id = await propose(turn, 'GMAIL_SEND_EMAIL', {});
          rejectPreflight = true;
          try {
            await assert.rejects(confirm(id, true), { statusCode: 409 });
            assert.equal((await stored(id)).status, 'pending');
          } finally {
            rejectPreflight = false;
          }
          await confirm(id, true);
          rejectPreflight = true;
          try {
            await assert.rejects(execute(id), { statusCode: 409 });
            assert.equal((await stored(id)).status, 'confirmed');
            assert.equal(calls.length, before);
          } finally {
            rejectPreflight = false;
          }
          await thread.stopThread();
        },
      );

      await t.test(
        'cancelled, expired, wrong-channel and foreign confirmations cannot execute',
        async () => {
          const before = calls.length;
          const cancelled = await propose(await newTurn(), 'GMAIL_SEND_EMAIL', {});
          await thread.stopThread();
          await assert.rejects(confirm(cancelled, true), { statusCode: 409 });
          const expired = await propose(await newTurn(), 'GMAIL_SEND_EMAIL', {});
          await db.pool.query(
            "UPDATE approvals SET expires_at=now()-interval '1 minute' WHERE id=$1",
            [expired],
          );
          await assert.rejects(confirm(expired, true), { statusCode: 409 });
          const foreign = await propose(await newTurn(), 'GMAIL_SEND_EMAIL', {});
          await db.pool.query('UPDATE approvals SET owner_id=$2 WHERE id=$1', [
            foreign,
            'another-owner',
          ]);
          assert.equal(await confirm(foreign, true), undefined);
          const otherChannel = await propose(await newTurn(), 'GMAIL_SEND_EMAIL', {});
          assert.equal(await confirm(otherChannel, true, { channel: 'telegram' }), undefined);
          assert.equal((await stored(otherChannel)).status, 'pending');
          assert.equal(calls.length, before);
          await thread.stopThread();
        },
      );

      await t.test(
        'a finished turn, changed consent and a stale thread cannot authorize a snapshot',
        async () => {
          const turn = await newTurn();
          const id = await propose(turn, 'GMAIL_SEND_EMAIL', { subject: 'obsolete' });
          assert.equal(
            await confirm(id, true, { text: 'Yes, but send it to somebody else' }),
            undefined,
          );
          assert.equal(await confirm(id, true, { threadId: randomUUID() }), undefined);
          assert.equal(
            (
              await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: (await stored(id)).confirmation_message_id,
                threadId: randomUUID(),
              })
            ).statusCode,
            409,
          );
          assert.equal((await stored(id)).status, 'pending');
          await db.pool.query("UPDATE turns SET status='failed' WHERE id=$1", [turn.turnId]);
          const before = calls.length;
          await assert.rejects(confirm(id, true), { statusCode: 409 });
          assert.equal(calls.length, before);
          await assert.rejects(approvals.request(turn, 'GMAIL_SEND_EMAIL', {}), {
            statusCode: 409,
          });
        },
      );

      await t.test(
        'an unbound yes cannot consume an older question after another assistant message',
        async () => {
          const turn = await newTurn();
          const id = await propose(turn, 'GMAIL_SEND_EMAIL', {});
          const other = await newTurn('succeeded');
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text,created_at) VALUES($1,$2,$3,$4,'assistant','An unrelated question',now()+interval '1 second')",
            [randomUUID(), ownerId, other.threadId, other.turnId],
          );
          assert.equal(await confirm(id, true, { replyToMessageId: undefined }), undefined);
          assert.equal((await stored(id)).status, 'pending');
          assert.ok(await confirm(id, false));
          await thread.stopThread();
        },
      );

      await t.test('a connection callback queues one resume turn for a known turn', async () => {
        const turn = await newTurn('waiting');
        await db.pool.query("UPDATE turns SET waiting_reason='question' WHERE id=$1", [
          turn.turnId,
        ]);
        assert.equal(await thread.resumeAfterConnection(randomUUID(), 'linear'), false);
        assert.equal(await thread.resumeAfterConnection(turn.turnId, 'linear'), true);
        assert.equal(await thread.resumeAfterConnection(turn.turnId, 'linear'), true);
        const resumed = (
          await db.pool.query('SELECT * FROM turns WHERE source_id=$1', [
            `connection:${turn.turnId}`,
          ])
        ).rows;
        assert.equal(resumed.length, 1);
        assert.equal(resumed[0].source, 'resume');
        assert.equal(resumed[0].status, 'queued');
        assert.equal(resumed[0].background, false);
        assert.equal(resumed[0].thread_id, turn.threadId);
        assert.match(resumed[0].prompt, /linear connection completed/);
        assert.equal(await turnStatus(turn.turnId), 'succeeded');
        assert.equal(
          (await db.pool.query('SELECT waiting_reason FROM turns WHERE id=$1', [turn.turnId]))
            .rows[0].waiting_reason,
          null,
        );
        await thread.stopThread();
      });

      await t.test('a secure-entry callback and a fresh-link retry each resume once', async () => {
        const turn = await newTurn('waiting');
        await assert.rejects(thread.resumeAfterCredentials(turn.turnId), { statusCode: 409 });
        await db.pool.query("UPDATE turns SET waiting_reason='credentials' WHERE id=$1", [
          turn.turnId,
        ]);
        await thread.resumeAfterCredentials(turn.turnId);
        await thread.resumeAfterCredentials(turn.turnId);
        const resumed = await db.pool.query('SELECT * FROM turns WHERE source_id=$1', [
          `credentials:${turn.turnId}`,
        ]);
        assert.equal(resumed.rowCount, 1);
        assert.equal(resumed.rows[0].status, 'queued');
        assert.equal(resumed.rows[0].background, false);
        assert.equal(await turnStatus(turn.turnId), 'succeeded');
        await assert.rejects(thread.retryCredentials(turn.turnId), { statusCode: 409 });
        const retryParent = resumed.rows[0].id;
        await db.pool.query(
          "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1",
          [retryParent],
        );
        await thread.retryCredentials(retryParent);
        await thread.retryCredentials(retryParent);
        assert.equal(
          (
            await db.pool.query('SELECT id FROM turns WHERE source_id=$1', [
              `credentials-retry:${retryParent}`,
            ])
          ).rowCount,
          1,
        );
        assert.equal(await turnStatus(retryParent), 'succeeded');
        await thread.stopThread();
      });

      await t.test(
        'declining resumes once without executing and uncertain actions cannot replay',
        async () => {
          const id = await propose(await newTurn(), 'GMAIL_SEND_EMAIL', {});
          const before = calls.length;
          assert.ok(await confirm(id, false));
          assert.equal(calls.length, before);
          const resumed = await resumeTurns(id);
          assert.equal(resumed.length, 1);
          assert.equal(resumed[0].status, 'queued');
          assert.match(resumed[0].prompt, /user declined/);
          assert.equal((await stored(id)).status, 'declined');
          await assert.rejects(confirm(id, true), { statusCode: 409 });
          assert.equal(await execute(id), undefined);
          const failed = await propose(await newTurn(), 'GMAIL_SEND_EMAIL', {});
          await confirm(failed, true);
          failExecution = true;
          try {
            await assert.rejects(execute(failed), (error: unknown) => {
              assert.ok(error instanceof Error);
              assert.doesNotMatch(error.message, /Fixture provider detail/);
              return (error as Error & { statusCode: number }).statusCode === 502;
            });
          } finally {
            failExecution = false;
          }
          assert.equal((await stored(failed)).status, 'uncertain');
          assert.equal(await execute(failed), undefined);
          await assert.rejects(confirm(failed, true), { statusCode: 409 });
          assert.equal(calls.length, before + 1);
          await thread.stopThread();
        },
      );

      await t.test('a failed decline enqueue rolls back both the decision and reply', async () => {
        const turn = await newTurn();
        const id = await propose(turn, 'GMAIL_SEND_EMAIL', {});
        const countMessages = async () =>
          (await db.pool.query('SELECT id FROM messages WHERE thread_id=$1', [turn.threadId]))
            .rowCount;
        const initialMessages = await countMessages();
        const send = t.mock.method(thread.boss, 'send', async () => {
          throw new Error('Injected queue failure');
        });
        try {
          await assert.rejects(confirm(id, false), /Injected queue failure/);
        } finally {
          send.mock.restore();
        }
        assert.equal((await stored(id)).status, 'pending');
        assert.equal(await countMessages(), initialMessages);
        assert.equal((await resumeTurns(id)).length, 0);
        assert.ok(await confirm(id, false));
        assert.equal((await resumeTurns(id)).length, 1);
        await thread.stopThread();
      });

      await t.test(
        'stopping after chat acceptance prevents the worker from executing',
        async () => {
          const id = await propose(await newTurn(), 'GMAIL_SEND_EMAIL', {});
          await confirm(id, true);
          const before = calls.length;
          await thread.stopThread();
          assert.equal(await turnStatus((await stored(id)).execution_turn_id), 'cancelled');
          await assert.rejects(execute(id), { statusCode: 409 });
          assert.equal(calls.length, before);
          assert.equal((await stored(id)).status, 'confirmed');
        },
      );

      await t.test(
        'stopping during confirmed execution records its result without queuing more work',
        async () => {
          const turn = await newTurn();
          const id = await propose(turn, 'GMAIL_SEND_EMAIL', {});
          await confirm(id, true);
          let release = () => {};
          executionGate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const controller = new AbortController();
          const pending = execute(id, controller.signal);
          const completed = assert.rejects(pending);
          try {
            for (let attempt = 0; attempt < 100; attempt++) {
              if ((await stored(id)).status === 'executing') break;
              await delay(5);
            }
            assert.equal((await stored(id)).status, 'executing');
            await thread.stopThread();
            controller.abort();
            release();
            await completed;
            assert.equal((await stored(id)).status, 'completed');
            assert.equal(await turnStatus((await stored(id)).execution_turn_id), 'cancelled');
            assert.equal(
              (
                await db.pool.query(
                  "SELECT id FROM turns WHERE thread_id=$1 AND status IN ('queued','running')",
                  [turn.threadId],
                )
              ).rowCount,
              0,
            );
          } finally {
            release();
            executionGate = undefined;
            await completed;
          }
          const interrupted = await propose(await newTurn(), 'GMAIL_SEND_EMAIL', {});
          await db.pool.query("UPDATE approvals SET status='executing' WHERE id=$1", [interrupted]);
          await createApprovals(async () => {
            throw new Error('Must not automatically retry');
          });
          assert.equal((await stored(interrupted)).status, 'uncertain');
          await assert.rejects(confirm(interrupted, true), { statusCode: 409 });
          await thread.stopThread();
        },
      );

      await t.test(
        'profile, memory, history and goals retain explicit data and ownership',
        async () => {
          const profile = {
            name: 'Fixture User',
            location: 'Lisbon',
            phone: '+351000000000',
            preferences: 'Concise answers',
          };
          assert.equal((await request('PUT', '/api/profile', profile)).statusCode, 200);
          assert.deepEqual((await request('GET', '/api/profile')).json(), profile);
          assert.equal(
            (await request('PUT', '/api/profile', { ...profile, inferredHealth: 'not accepted' }))
              .statusCode,
            400,
          );
          await personal.manage('memory_propose', {
            text: 'Fixture explicitly prefers concise answers',
          });
          await personal.manage('memory_propose', {
            text: 'Fixture explicitly prefers concise answers',
          });
          const memory = await request('GET', '/api/memory');
          assert.equal(memory.json().length, 1);
          const foreign = randomUUID();
          await db.pool.query('INSERT INTO memory_facts(id,owner_id,text) VALUES($1,$2,$3)', [
            foreign,
            'another-owner',
            'Foreign private fixture',
          ]);
          await request('DELETE', `/api/memory/${foreign}`);
          assert.equal(
            (await db.pool.query('SELECT id FROM memory_facts WHERE id=$1', [foreign])).rowCount,
            1,
          );
          const goal = await request('POST', '/api/goals', {
            title: 'Fixture milestone',
            description: 'An explicit objective',
          });
          assert.equal(goal.statusCode, 200);
          const id = goal.json().id;
          assert.equal(
            (await request('PATCH', `/api/goals/${id}`, { progress: 101 })).statusCode,
            400,
          );
          assert.equal(
            (
              await request('PATCH', `/api/goals/${id}`, {
                progress: 50,
                nextAction: 'Review result',
                status: 'active',
              })
            ).statusCode,
            200,
          );
          assert.equal((await request('GET', '/api/goals')).json()[0].progress, 50);
          await db.pool.query('UPDATE goals SET owner_id=$2 WHERE id=$1', [id, 'another-owner']);
          assert.equal(
            (await request('PATCH', `/api/goals/${id}`, { progress: 100 })).statusCode,
            404,
          );
          const foreignThread = await thread.activeThread(db.pool, 'another-owner');
          await db.pool.query(
            'INSERT INTO messages(id,owner_id,role,text,thread_id) VALUES($1,$2,$3,$4,$5)',
            [randomUUID(), 'another-owner', 'user', 'BoundarySecretKeyword', foreignThread.id],
          );
          assert.deepEqual(
            await personal.manage('history_search', { query: 'BoundarySecretKeyword' }),
            { turns: [], messages: [] },
          );
        },
      );

      await t.test(
        'schedules persist exact timezone-aware delayed jobs and deletion cancels only owned work',
        async () => {
          const result = await request('POST', '/api/schedules', {
            title: 'Future fixture',
            prompt: 'No external activity',
            cron: '0 9 1 1 *',
            timeZone: 'Europe/Lisbon',
          });
          assert.equal(result.statusCode, 200);
          const schedule = result.json();
          assert.equal(
            (await request('GET', '/api/schedules')).json()[0].timeZone,
            'Europe/Lisbon',
          );
          const queued = (
            await db.pool.query(
              `SELECT j.id,j.state,j.data,j.start_after FROM schedules s JOIN ${bossSchema}.job j ON j.id=s.job_id WHERE s.id=$1`,
              [schedule.id],
            )
          ).rows[0];
          assert.equal(queued.state, 'created');
          assert.equal(queued.data.scheduleId, schedule.id);
          assert.equal(queued.data.revision, schedule.revision);
          assert.equal(queued.start_after.toISOString(), schedule.nextRun);
          assert.equal((await request('DELETE', `/api/schedules/${schedule.id}`)).statusCode, 200);
          assert.equal((await request('GET', '/api/schedules')).json().length, 0);
          assert.equal(
            (await db.pool.query(`SELECT state FROM ${bossSchema}.job WHERE id=$1`, [queued.id]))
              .rows[0].state,
            'cancelled',
          );
          assert.equal(
            (
              await request('POST', '/api/schedules', {
                title: 'Invalid',
                prompt: 'Fixture',
                cron: '* * * * * *',
                timeZone: 'Europe/Lisbon',
              })
            ).statusCode,
            400,
          );
          const foreign = (
            await request('POST', '/api/schedules', {
              title: 'Foreign fixture',
              prompt: 'No external activity',
              cron: '0 9 1 1 *',
              timeZone: 'Europe/Lisbon',
            })
          ).json();
          await db.pool.query('UPDATE schedules SET owner_id=$2 WHERE id=$1', [
            foreign.id,
            'another-owner',
          ]);
          assert.equal((await request('DELETE', `/api/schedules/${foreign.id}`)).statusCode, 404);
          assert.equal(
            (
              await db.pool.query(
                `SELECT j.id FROM schedules s JOIN ${bossSchema}.job j ON j.id=s.job_id WHERE s.id=$1 AND j.state='created'`,
                [foreign.id],
              )
            ).rowCount,
            1,
          );
        },
      );
    } finally {
      await app.close();
      await thread.stopThreadWorkers();
      const files = (await db.pool.query('SELECT storage_path FROM artifacts')).rows.map((row) =>
        String(row.storage_path),
      );
      await db.pool.end();
      for (const path of files) await rm(path, { force: true });
      for (const path of directories) await rm(path, { recursive: true, force: true });
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
