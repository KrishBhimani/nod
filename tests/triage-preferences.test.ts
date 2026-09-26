import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

test(
  'new notification preferences gate useful events while explicit silence and narrow feedback survive',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15_000 },
  async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_triage_${suffix}`;
    const bossSchema = `test_triage_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { createTriage, getPreferences, updatePreferences } =
      await import('../src/server/triage.ts');
    const personal = createPersonalService({
      pool: db.pool,
      ownerId: 'local-development',
      scheduler: tasks.boss,
      submitTask: tasks.submitTask,
      refresh() {},
    });
    const contexts: object[] = [];
    const triage = createTriage({
      getProfile: personal.getProfile,
      listGoals: personal.listGoals,
      classifier: {
        id: 'fixture',
        configured: true,
        classify: async (context, policy) => {
          contexts.push(context);
          assert.match(policy.instructions, /One dislike must not disable unrelated useful help/);
          return 'digest';
        },
      },
    });
    try {
      await db.initializeDatabase();
      await db.pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS reaction text');
      await tasks.initializeTasks();
      await personal.initialize({ workers: false });
      await triage.initializeHeartbeat();
      assert.match((await getPreferences()).notificationRule, /time-sensitive/);
      await db.pool.query(
        "INSERT INTO messages(id,owner_id,role,text,reaction) VALUES($1,'local-development','assistant','Synthetic reminder','dislike')",
        [randomUUID()],
      );
      await triage.triageEvent('A synthetic meeting time changed', 'default-preferences-fixture');
      assert.equal(contexts.length, 1);
      assert.match(JSON.stringify(contexts[0]), /"reaction":"dislike"/);
      assert.match(JSON.stringify(contexts[0]), /"createdAt"/);
      assert.equal(
        (
          await db.pool.query('SELECT decision FROM notifications WHERE event_id=$1', [
            'default-preferences-fixture',
          ])
        ).rows[0].decision,
        'digest',
      );
      await updatePreferences({ notificationRule: '' });
      await updatePreferences({ timeZone: 'UTC' });
      assert.equal((await getPreferences()).notificationRule, '');
      await triage.triageEvent(
        'Another synthetic meeting time changed',
        'explicit-silence-fixture',
      );
      assert.equal(contexts.length, 1);
      assert.equal(
        (
          await db.pool.query('SELECT decision FROM notifications WHERE event_id=$1', [
            'explicit-silence-fixture',
          ])
        ).rows[0].decision,
        'digest',
      );
      assert.equal((await db.pool.query('SELECT id FROM tasks')).rowCount, 0);
    } finally {
      await tasks.stopTasks();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
