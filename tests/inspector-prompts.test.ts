import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import Fastify from 'fastify';
import { createPromptInspector } from '../src/server/inspector-prompts.ts';

test(
  'prompt inspection is private, redacted, bounded and revision fenced',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_prompts_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    let enabled = true;
    const store = createPromptInspector(pool, {
      ownerId: 'owner',
      enabled: () => enabled,
      secrets: ['provider-secret-fixture'],
      provider: 'fixture token=provider-label-secret',
      model: 'fixture password=model-label-secret',
    });
    const app = Fastify();
    store.registerRoutes(app);
    const taskId = randomUUID(),
      foreign = randomUUID();
    try {
      await pool.query(
        'CREATE TABLE tasks(id uuid PRIMARY KEY,owner_id text,title text,revision integer,status text)',
      );
      await pool.query(
        "INSERT INTO tasks VALUES($1,'owner','Fixture',3,'running'),($2,'foreign','Private',0,'running')",
        [taskId, foreign],
      );
      await store.initialize();
      await pool.query('UPDATE tasks SET title=$1 WHERE id=$2', [
        'Use provider-secret-fixture; password=title-secret',
        taskId,
      ]);
      const snapshot = {
        id: randomUUID(),
        system: 'Use provider-secret-fixture; password=do-not-store; /vault/private-token',
        instruction:
          'Respond to currentInstruction.\nRequest data (JSON):\n' +
          JSON.stringify({
            currentInstruction: JSON.stringify({
              password: 'synthetic-nested-prompt-secret',
              title: 'Keep this useful instruction',
            }),
            padding: 'x'.repeat(60_000),
          }),
        resumed: false,
        imageCount: 0,
        reason: 'user' as const,
        createdAt: new Date().toISOString(),
      };
      await store.record(taskId, 3, snapshot);
      await store.record(taskId, 2, { ...snapshot, id: randomUUID() });
      await store.record(foreign, 0, { ...snapshot, id: randomUUID() });
      const recorded = (await store.read({}))!;
      assert.equal(recorded.prompts.length, 1);
      assert.equal(recorded.prompts[0]!.taskId, taskId);
      assert.doesNotMatch(
        JSON.stringify(recorded),
        /provider-secret-fixture|do-not-store|private-token|title-secret|synthetic-nested-prompt-secret/,
      );
      assert.match(recorded.prompts[0]!.instruction, /Keep this useful instruction/);
      assert.doesNotMatch(
        JSON.stringify(
          (await pool.query('SELECT payload,provider,model FROM inspector_prompts')).rows,
        ),
        /synthetic-nested-prompt-secret|provider-label-secret|model-label-secret/,
      );
      assert.match(recorded.prompts[0]!.instruction, /\[truncated\]/);
      assert.ok(recorded.prompts[0]!.instruction.length < 49_000);
      assert.equal(await store.read({ taskId: foreign }), null);
      assert.equal((await app.inject('/api/inspector/prompts?taskId=' + foreign)).statusCode, 404);
      const response = await app.inject('/api/inspector/prompts');
      assert.equal(response.headers['cache-control'], 'no-store');
      await pool.query(
        "UPDATE inspector_prompts SET payload=jsonb_set(payload-'redactionVersion','{instruction}',$1::jsonb) WHERE id=$2",
        [
          JSON.stringify(
            'Legacy request data: ' +
              JSON.stringify({
                currentInstruction: JSON.stringify({
                  password: 'legacy-nested-prompt-secret',
                  title: 'Legacy useful context',
                }),
              }),
          ),
          snapshot.id,
        ],
      );
      const legacy = await app.inject('/api/inspector/prompts');
      assert.doesNotMatch(legacy.body, /legacy-nested-prompt-secret/);
      assert.match(legacy.body, /Legacy useful context/);
      enabled = false;
      await store.record(taskId, 3, { ...snapshot, id: randomUUID() });
      assert.equal((await app.inject('/api/inspector/prompts')).statusCode, 404);
      assert.equal(
        (await pool.query('SELECT count(*)::int AS count FROM inspector_prompts')).rows[0].count,
        1,
      );
      enabled = true;
      await pool.query("UPDATE inspector_prompts SET created_at=now()-interval '8 days'");
      assert.equal((await store.read({}))!.prompts.length, 0);
      await store.close();
      await store.record(taskId, 3, { ...snapshot, id: randomUUID() });
      assert.equal(
        (await pool.query('SELECT count(*)::int AS count FROM inspector_prompts')).rows[0].count,
        1,
      );
    } finally {
      await store.close();
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('prompt retention runs while capture is disabled, retries failed cleanup and stops on close', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2026-09-25T10:00:00Z') });
  const calls: unknown[][] = [];
  let fail = false;
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith('DELETE')) {
        calls.push(values);
        if (fail) throw new Error('Synthetic cleanup failure.');
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  const store = createPromptInspector(pool, {
    ownerId: 'owner',
    enabled: () => false,
    provider: 'fixture',
    model: 'fixture',
  });
  try {
    await store.initialize();
    assert.deepEqual(calls, [['owner']]);
    fail = true;
    t.mock.timers.tick(60 * 60_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2);
    fail = false;
    await store.read({});
    assert.equal(calls.length, 3);
    t.mock.timers.tick(60 * 60_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 4);
    await store.close();
    t.mock.timers.tick(2 * 60 * 60_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 4);
  } finally {
    await store.close();
    t.mock.timers.reset();
  }
});

test(
  'disabled startup deletes expired owned prompts while preserving current and foreign records',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_prompt_retention_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const options = {
      ownerId: 'owner',
      enabled: () => false,
      provider: 'fixture',
      model: 'fixture',
    };
    const previous = createPromptInspector(pool, options);
    const restarted = createPromptInspector(pool, options);
    const taskId = randomUUID();
    const expiredId = randomUUID();
    const currentId = randomUUID();
    const foreignId = randomUUID();
    try {
      await pool.query('CREATE TABLE tasks(id uuid PRIMARY KEY)');
      await pool.query('INSERT INTO tasks VALUES($1)', [taskId]);
      await previous.initialize();
      await pool.query(
        `INSERT INTO inspector_prompts(id,owner_id,task_id,revision,payload,provider,model,created_at) VALUES
        ($1,'owner',$4,0,'{}','fixture','fixture',now()-interval '8 days'),
        ($2,'owner',$4,0,'{}','fixture','fixture',now()),
        ($3,'other',$4,0,'{}','fixture','fixture',now()-interval '8 days')`,
        [expiredId, currentId, foreignId, taskId],
      );
      await previous.close();
      await restarted.initialize();
      assert.deepEqual(
        new Set((await pool.query('SELECT id FROM inspector_prompts')).rows.map(({ id }) => id)),
        new Set([currentId, foreignId]),
      );
    } finally {
      await previous.close();
      await restarted.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
