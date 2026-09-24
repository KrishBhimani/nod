import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { RuntimeContext } from '../src/ports/agent.ts';

test(
  'short answers continue only an unambiguous question in the same channel',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_continue_${suffix}`;
    const bossSchema = `test_continue_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const personal = createPersonalService({
      pool: db.pool,
      ownerId: 'local-development',
      scheduler: tasks.boss,
      submitTask: tasks.submitTask,
      refresh() {},
    });
    try {
      await db.initializeDatabase();
      await tasks.initializeTasks();
      await personal.initialize({ workers: false });
      await db.pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS reaction text');
      const waitFor = async (check: () => Promise<boolean>) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await check()) return;
          await delay(50);
        }
        throw new Error('Fixture condition did not complete');
      };
      const waitingTask = async (title: string, reason = 'question', channel = 'web') => {
        const id = await tasks.submitTask(title, [], undefined, false, { channel });
        await db.pool.query(
          "UPDATE tasks SET status=$2,waiting_reason=$3,waiting_question='Which city?' WHERE id=$1",
          [id, reason === 'credentials' ? 'waiting_credentials' : 'waiting_user', reason],
        );
        return id;
      };
      const clearWaits = () =>
        db.pool.query(
          "UPDATE tasks SET status='cancelled' WHERE status IN ('waiting_user','waiting_credentials')",
        );
      await t.test(
        'a short reply retains the original task identity and is idempotent',
        async () => {
          const id = await waitingTask('Find a suitable restaurant');
          const first = await tasks.submitUserMessage('Lisbon', [], { sourceId: 'answer-fixture' });
          const duplicate = await tasks.submitUserMessage('Lisbon', [], {
            sourceId: 'answer-fixture',
          });
          assert.deepEqual(first, { taskId: id, continued: true });
          assert.deepEqual(duplicate, first);
          const current = (
            await db.pool.query('SELECT revision,waiting_reason FROM tasks WHERE id=$1', [id])
          ).rows[0];
          assert.equal(current.revision, 1);
          assert.equal(current.waiting_reason, null);
          assert.equal(
            (
              await db.pool.query("SELECT id FROM messages WHERE task_id=$1 AND text='Lisbon'", [
                id,
              ])
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        'standalone commands with conversational introductions never resume a waiting question',
        async () => {
          const id = await waitingTask('Waiting sign-in clarification');
          const request =
            'For this development check, open https://example.com on your computer and reply with its title in bold. Keep the browser open.';
          assert.equal((await tasks.submitUserMessage(request)).continued, false);
          assert.equal(
            (await tasks.submitUserMessage('For this check, open example.com')).continued,
            false,
          );
          assert.equal(
            (await tasks.submitUserMessage('On your computer install the tool')).continued,
            false,
          );
          assert.equal((await tasks.submitUserMessage('Calculate 12 + 3')).continued, false);
          assert.equal(
            (await tasks.submitUserMessage('A quick calculation: 12 + 3')).continued,
            false,
          );
          assert.equal((await tasks.submitUserMessage('Describe this image')).continued, false);
          assert.equal(
            (await tasks.submitUserMessage('I am asking you to open example.com')).continued,
            false,
          );
          assert.equal((await tasks.submitUserMessage('I live in Lisbon')).taskId, id);
          await clearWaits();
        },
      );
      await t.test(
        'multiple questions require selection, while explicit selection and new requests remain possible',
        async () => {
          const a = await waitingTask('Plan lunch');
          const b = await waitingTask('Plan dinner');
          await assert.rejects(tasks.submitUserMessage('Lisbon'), (error: unknown) => {
            const value = error as {
              statusCode: number;
              code: string;
              choices: Array<{ id: string; question: string }>;
            };
            assert.equal(value.statusCode, 409);
            assert.equal(value.code, 'task_selection_required');
            assert.deepEqual(new Set(value.choices.map((item) => item.id)), new Set([a, b]));
            assert.equal(
              value.choices.every((item) => item.question === 'Which city?'),
              true,
            );
            return true;
          });
          const fresh = await tasks.submitUserMessage('Find a train to Porto');
          assert.equal(fresh.continued, false);
          const forced = await tasks.submitUserMessage('Lisbon', [], { forceNew: true });
          assert.equal(forced.continued, false);
          assert.equal((await tasks.submitUserMessage('Lisbon', [], { taskId: b })).taskId, b);
          await clearWaits();
        },
      );
      await t.test(
        'credential, approval, interrupted and other-channel tasks cannot absorb a chat answer',
        async () => {
          await waitingTask('Sign in', 'credentials');
          const approval = await waitingTask('Send a reviewed email', 'approval');
          await waitingTask('Check interrupted action', 'recovery');
          const telegram = await waitingTask('Telegram lunch', 'question', 'telegram');
          await waitingTask('Foreign owner lunch');
          await db.pool.query(
            "UPDATE tasks SET owner_id='someone-else' WHERE title='Foreign owner lunch'",
          );
          assert.equal((await tasks.submitUserMessage('Lisbon')).continued, false);
          await assert.rejects(tasks.submitUserMessage('yes', [], { taskId: approval }), /Review/);
          await assert.rejects(
            tasks.submitUserMessage('Lisbon', [], { taskId: telegram }),
            /not found/,
          );
          assert.equal(
            (await tasks.submitUserMessage('Lisbon', [], { channel: 'telegram' })).taskId,
            telegram,
          );
          await clearWaits();
        },
      );
      await t.test(
        'legacy questions are recovered only from an observed ask_user tool boundary',
        async () => {
          const id = await waitingTask('Legacy restaurant question', 'recovery');
          await db.pool.query('UPDATE tasks SET waiting_reason=NULL WHERE id=$1', [id]);
          await db.pool.query(
            "INSERT INTO task_events(id,task_id,type,summary) VALUES($1,$2,'tool_start','ask user')",
            [randomUUID(), id],
          );
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,'local-development','assistant','Which city?',$2)",
            [randomUUID(), id],
          );
          await tasks.initializeTaskSchema();
          assert.equal((await tasks.submitUserMessage('Lisbon')).taskId, id);
          await clearWaits();
        },
      );
      await t.test(
        'restarting onboarding supersedes only prior onboarding work and keeps personal context',
        async () => {
          const unrelated = await waitingTask('Unrelated ongoing question');
          await db.pool.query(
            "INSERT INTO memory_facts(id,owner_id,text) VALUES($1,'local-development','Preserved fixture fact')",
            [randomUUID()],
          );
          const first = await tasks.restartOnboarding();
          await db.pool.query(
            "UPDATE tasks SET status='waiting_user',waiting_reason='question',waiting_question='What should I call you?' WHERE id=$1",
            [first.taskId],
          );
          const second = await tasks.restartOnboarding();
          assert.notEqual(first.taskId, second.taskId);
          const old = (
            await db.pool.query('SELECT status,revision FROM tasks WHERE id=$1', [first.taskId])
          ).rows[0];
          assert.deepEqual(old, { status: 'cancelled', revision: 1 });
          assert.equal(
            (await db.pool.query('SELECT status FROM tasks WHERE id=$1', [unrelated])).rows[0]
              .status,
            'waiting_user',
          );
          assert.equal(
            (
              await db.pool.query(
                "SELECT id FROM tasks WHERE source_id LIKE 'onboarding:%' AND status <> 'cancelled'",
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (await db.pool.query('SELECT id FROM messages WHERE task_id=$1', [first.taskId]))
              .rowCount,
            1,
          );
          assert.equal(
            (await db.pool.query("SELECT id FROM memory_facts WHERE text='Preserved fixture fact'"))
              .rowCount,
            1,
          );
          await clearWaits();
        },
      );
      await t.test(
        'an immediate answer waits for the old segment to exit and keeps context timestamps and reactions',
        async () => {
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let held: RuntimeContext | undefined;
          let resumed: RuntimeContext | undefined;
          const oldPrompt = 'Ask the race fixture question';
          const newPrompt = 'Porto';
          await db.pool.query(
            "INSERT INTO preferences(owner_id,time_zone) VALUES('local-development','Europe/Lisbon') ON CONFLICT(owner_id) DO UPDATE SET time_zone='Europe/Lisbon'",
          );
          await db.pool.query("UPDATE tasks SET status='cancelled' WHERE status='queued'");
          await tasks.boss.deleteAllJobs('assistant-task');
          await tasks.startTaskWorkers({
            runTask: async (context) => {
              if (context.prompt === oldPrompt) {
                held = context;
                await context.waitForUser!('Which city for the race fixture?');
                await gate;
                return {
                  status: 'waiting_user',
                  waitingFor: 'question',
                  question: 'Which city for the race fixture?',
                };
              }
              if (context.prompt === newPrompt) resumed = context;
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
          try {
            const id = await tasks.submitTask(oldPrompt);
            await waitFor(async () =>
              Boolean(
                (
                  await db.pool.query(
                    "SELECT id FROM tasks WHERE id=$1 AND waiting_reason='question'",
                    [id],
                  )
                ).rowCount,
              ),
            );
            await db.pool.query(
              "UPDATE messages SET reaction='like' WHERE task_id=$1 AND role='assistant'",
              [id],
            );
            const continued = await tasks.submitUserMessage(newPrompt);
            assert.equal(continued.taskId, id);
            await delay(1100);
            assert.equal(resumed, undefined);
            await assert.rejects(held!.reply('Stale segment must not publish'), /no longer active/);
            release();
            await waitFor(
              async () =>
                (await db.pool.query('SELECT status FROM tasks WHERE id=$1', [id])).rows[0]
                  .status === 'succeeded',
            );
            assert.equal(resumed!.channel, 'web');
            assert.equal(resumed!.timeZone, 'Europe/Lisbon');
            assert.equal(
              resumed!.history.some(
                (message) => message.reaction === 'like' && Boolean(message.createdAt),
              ),
              true,
            );
            assert.equal(
              (
                await db.pool.query(
                  "SELECT id FROM messages WHERE text='Stale segment must not publish'",
                )
              ).rowCount,
              0,
            );
          } finally {
            release();
          }
        },
      );
    } finally {
      await tasks.stopTasks();
      const ids = (await db.pool.query('SELECT id FROM tasks')).rows.map((row) => row.id as string);
      const { dataRoot } = await import('../src/server/config.ts');
      await db.pool.end();
      for (const id of ids)
        await rm(join(dataRoot, 'workspaces', id), { recursive: true, force: true });
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
