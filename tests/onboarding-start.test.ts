import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

test(
  'completing onboarding starts one assistant-initiated welcome without a user message or reset',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_welcome_${suffix}`;
    const bossSchema = `test_welcome_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { createAccountSession } = await import('../src/server/account.ts');
    const { createAccountStore } = await import('../src/server/account-store.ts');
    const { configuration, ownerId, port } = await import('../src/server/config.ts');
    await db.initializeDatabase();
    await tasks.initializeTasks();
    const accounts = createAccountStore(db.pool);
    await accounts.initialize();
    const app = await createApp({
      configuration: () => ({ ...configuration(), llmReady: true }),
      startOnboarding: tasks.startOnboarding,
    });
    createAccountSession({
      accounts,
      origin: `http://localhost:${port}`,
      localUser: { id: ownerId, name: 'You', email: null, avatarUrl: null },
      start: async (_owner, name) => {
        await tasks.startOnboarding(name);
      },
    }).register(app);
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    try {
      const earlier = await tasks.submitTask('Earlier synthetic request');
      const before = (await app.inject({ url: '/api/state', headers })).json();
      assert.equal(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/account',
            headers,
            payload: { name: 'Alex Example' },
          })
        ).statusCode,
        200,
      );
      const complete = () =>
        app.inject({
          method: 'PATCH',
          url: '/api/account',
          headers,
          payload: { onboardingCompleted: true },
        });
      const responses = await Promise.all([complete(), complete()]);
      responses.push(await complete());
      for (const response of responses) {
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().settings.onboardingCompleted, true);
      }
      assert.deepEqual(
        (
          await app.inject({ method: 'POST', url: '/api/onboarding/start', headers, payload: {} })
        ).json(),
        { ok: true },
      );
      const welcome = await db.pool.query(
        "SELECT id,source,source_id,source_message_id,channel,conversation_revision,prompt FROM tasks WHERE source_id LIKE 'onboarding:%'",
      );
      assert.equal(welcome.rowCount, 1);
      assert.equal(welcome.rows[0].source, 'event');
      assert.equal(welcome.rows[0].source_id, 'onboarding:welcome');
      const prompt = welcome.rows[0].prompt as string;
      assert.match(prompt, /"firstName":"Alex"/);
      assert.ok(prompt.indexOf('read-only tools only') < prompt.indexOf('send_message'));
      assert.match(prompt, /Before you write anything, look into each connected app/);
      assert.match(prompt, /Do not send, create, change or delete anything in any app/);
      assert.match(prompt, /normal approvals still apply/);
      assert.match(prompt, /hardest or most tedious one first/);
      assert.match(prompt, /connect one app/);
      assert.doesNotMatch(tasks.welcomePrompt(), /firstName/);
      assert.equal(
        tasks.welcomePrompt(' Sam   Rivera ').includes(JSON.stringify({ firstName: 'Sam' })),
        true,
      );
      assert.equal(welcome.rows[0].source_message_id, null);
      assert.equal(welcome.rows[0].channel, 'web');
      assert.equal(welcome.rows[0].conversation_revision, before.conversationRevision);
      assert.equal(
        (
          await db.pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='user'", [
            welcome.rows[0].id,
          ])
        ).rowCount,
        0,
      );
      const after = (await app.inject({ url: '/api/state', headers })).json();
      assert.equal(after.conversationRevision, before.conversationRevision);
      assert.deepEqual(
        after.messages.map((message: { text: string }) => message.text),
        ['Earlier synthetic request'],
      );
      const typing = Object.fromEntries(
        after.tasks.map((task: { id: string; showTyping: boolean }) => [task.id, task.showTyping]),
      );
      assert.deepEqual(typing, { [earlier]: true, [welcome.rows[0].id]: true });
      assert.equal(
        (await app.inject({ url: `/api/tasks/${welcome.rows[0].id}`, headers })).json().showTyping,
        true,
      );
      await tasks.submitTask('Synthetic background event', [], undefined, true, {
        source: 'event',
        sourceId: `event:${randomUUID()}`,
      });
      const background = (await app.inject({ url: '/api/state', headers }))
        .json()
        .tasks.filter((task: { showTyping: boolean }) => !task.showTyping);
      assert.equal(background.length, 1);
    } finally {
      await app.close();
      await tasks.stopTasks();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
