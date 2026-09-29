import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createPiCheckpoint } from '../src/providers/pi/checkpoint.ts';
import { createFilesystemObjectStore } from '../src/providers/object-storage/filesystem.ts';
import { createDiscoveredConnections } from '../src/server/discovered-connections.ts';
import { createAppGrantVault } from '../src/server/vault-app-grants.ts';

test(
  'legacy history and the latest task namespace survive the thread upgrade without replay',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async () => {
    const schema = `thread_migration_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const previous = {
      DATABASE_URL: process.env.DATABASE_URL,
      OTTO_DATA_ROOT: process.env.OTTO_DATA_ROOT,
    };
    const root = await mkdtemp(join(tmpdir(), 'otto-thread-migration-'));
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.OTTO_DATA_ROOT = root;
    const db = await import('../src/server/db.ts');
    const { initializeThreadSchema, activeThreadSql } = await import('../src/server/thread.ts');
    const { createSchedules } = await import('../src/server/schedules.ts');
    const { createPromptInspector } = await import('../src/server/inspector-prompts.ts');
    const owner = 'local-development';
    const latest = randomUUID();
    const succeeded = randomUUID();
    const running = randomUUID();
    const archived = randomUUID();
    const foreign = randomUUID();
    const waitingProposal = randomUUID();
    const staleProposal = randomUUID();
    const foreignProposal = randomUUID();
    const taskless = randomUUID();
    const archivedTaskless = randomUUID();
    const userMessage = randomUUID();
    const assistantMessage = randomUUID();
    const artifact = randomUUID();
    const unattachedArtifact = randomUUID();
    const wrongOwnerMessage = randomUUID();
    const snapshot = randomUUID();
    let inspector: ReturnType<typeof createPromptInspector> | undefined;
    try {
      await db.pool.query(`
      CREATE TABLE tasks(id uuid PRIMARY KEY,owner_id text NOT NULL,title text NOT NULL,prompt text NOT NULL,status text NOT NULL,
        revision integer NOT NULL DEFAULT 0,conversation_revision integer NOT NULL DEFAULT 0,source text NOT NULL DEFAULT 'user',
        source_id text,channel text NOT NULL DEFAULT 'web',waiting_reason text,created_at timestamptz NOT NULL DEFAULT now()-interval '1 hour',
        updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE conversations(owner_id text,channel text,revision integer,PRIMARY KEY(owner_id,channel));
      CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text NOT NULL,task_id uuid REFERENCES tasks(id),role text NOT NULL,text text NOT NULL,
        attachments jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE artifacts(id uuid PRIMARY KEY,owner_id text NOT NULL,task_id uuid REFERENCES tasks(id),name text NOT NULL,
        mime_type text NOT NULL,size integer NOT NULL,storage_path text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE task_events(id uuid PRIMARY KEY,task_id uuid NOT NULL,type text NOT NULL,summary text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE schedule_runs(id uuid PRIMARY KEY,owner_id text NOT NULL,schedule_id uuid NOT NULL,schedule_revision integer NOT NULL,
        job_id uuid UNIQUE NOT NULL,title text NOT NULL,task_id uuid NOT NULL,scheduled_for timestamptz NOT NULL,time_zone text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(schedule_id,schedule_revision,scheduled_for));
      CREATE TABLE inspector_prompts(id uuid PRIMARY KEY,owner_id text NOT NULL,task_id uuid NOT NULL,revision integer NOT NULL,payload jsonb NOT NULL,
        provider text NOT NULL,model text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE discovered_connection_proposals(id uuid PRIMARY KEY,owner_id text NOT NULL,task_id uuid,task_revision integer,
        service text NOT NULL DEFAULT 'fixture',name text NOT NULL DEFAULT 'Fixture',paths jsonb NOT NULL DEFAULT '[]',connection_id uuid,
        setup_url text,setup_text text,account_name text,oauth_state_hash text,oauth_ciphertext text,
        expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes');
      CREATE TABLE app_connections(id uuid PRIMARY KEY,owner_id text NOT NULL,task_id uuid,task_revision integer,
        callback_expires timestamptz NOT NULL DEFAULT now()+interval '15 minutes');
      CREATE TABLE approvals(id uuid PRIMARY KEY,owner_id text NOT NULL,task_id uuid NOT NULL,execution_revision integer,status text NOT NULL);
      CREATE TABLE provider_usage(id uuid PRIMARY KEY,owner_id text NOT NULL,task_id uuid);
      CREATE TABLE channel_inbox(source_id text PRIMARY KEY,owner_id text NOT NULL,task_id uuid,state text NOT NULL);
      CREATE TABLE channel_task_routes(task_id uuid PRIMARY KEY,owner_id text NOT NULL,source_id text NOT NULL);
      CREATE TABLE channel_outbox(message_id uuid PRIMARY KEY,source_id text NOT NULL,state text NOT NULL DEFAULT 'pending',reason text);
    `);
      await db.pool.query(
        `INSERT INTO tasks(id,owner_id,title,prompt,status,waiting_reason,updated_at,source) VALUES
      ($1,$6,'Connect fixture','Connect fixture','waiting_user','question',now(),'user'),
      ($2,$6,'Saved schedule','Saved schedule','succeeded',NULL,now()-interval '10 minutes','schedule'),
      ($3,$6,'Interrupted fixture','Interrupted fixture','running',NULL,now()-interval '5 minutes','user'),
      ($4,'reset-owner','Archived fixture','Archived fixture','succeeded',NULL,now(),'user'),
      ($5,'foreign-owner','Foreign fixture','Foreign fixture','waiting_user','question',now(),'user')`,
        [latest, succeeded, running, archived, foreign, owner],
      );
      await db.pool.query("INSERT INTO conversations VALUES('reset-owner','web',1)");
      await db.pool.query(
        `INSERT INTO messages(id,owner_id,task_id,role,text) VALUES
      ($1,$6,NULL,'user','Taskless revision zero context'),($2,'reset-owner',NULL,'user','Old reset context'),
      ($3,$6,$7,'user','Connect fixture'),($4,$6,$8,'assistant','Saved schedule result'),
      ($5,$6,$9,'assistant','Invalid foreign task link')`,
        [
          taskless,
          archivedTaskless,
          userMessage,
          assistantMessage,
          wrongOwnerMessage,
          owner,
          latest,
          succeeded,
          foreign,
        ],
      );
      await db.pool.query(
        `INSERT INTO artifacts(id,owner_id,task_id,name,mime_type,size,storage_path) VALUES
      ($1,$3,$4,'saved.txt','text/plain',4,'fixture'),($2,$3,$5,'unattached.txt','text/plain',4,'fixture')`,
        [artifact, unattachedArtifact, owner, latest, succeeded],
      );
      await db.pool.query('UPDATE messages SET attachments=$2 WHERE id=$1', [
        assistantMessage,
        JSON.stringify([{ id: artifact }]),
      ]);
      await db.pool.query(
        `INSERT INTO schedule_runs VALUES($1,$2,$3,0,$4,'Saved schedule',$5,now(),'UTC',now())`,
        [randomUUID(), owner, randomUUID(), randomUUID(), succeeded],
      );
      await db.pool.query(
        `INSERT INTO inspector_prompts VALUES($1,$2,$3,0,$4,'fixture','fixture',now())`,
        [
          snapshot,
          owner,
          succeeded,
          JSON.stringify({
            id: snapshot,
            system: 'Legacy system',
            instruction: 'Legacy instruction',
            resumed: false,
            imageCount: 0,
            reason: 'user',
            createdAt: new Date().toISOString(),
          }),
        ],
      );
      await db.pool.query(
        `INSERT INTO discovered_connection_proposals(id,owner_id,task_id,task_revision) VALUES
      ($1,$4,$5,0),($2,$4,$5,1),($3,$4,$6,0)`,
        [waitingProposal, staleProposal, foreignProposal, owner, latest, foreign],
      );
      const oauthState = Buffer.alloc(32, 8).toString('base64url');
      await db.pool.query(
        'UPDATE discovered_connection_proposals SET paths=$2,oauth_state_hash=$3 WHERE id=$1',
        [
          waitingProposal,
          JSON.stringify([
            { id: randomUUID(), kind: 'mcp', auth: 'oauth', endpoint: 'https://fixture.test/mcp' },
          ]),
          createHash('sha256').update(oauthState).digest('hex'),
        ],
      );
      const keyStore = { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32, 7) };
      const grantVault = await createAppGrantVault(db.pool, { ownerId: owner, keyStore });
      await grantVault.put(
        waitingProposal,
        JSON.stringify({ redirectUri: 'http://127.0.0.1/api/apps/callback' }),
      );
      await db.pool.query(
        `INSERT INTO app_connections(id,owner_id,task_id,task_revision) VALUES($1,$2,$3,0)`,
        [randomUUID(), owner, latest],
      );
      await db.pool.query(
        `INSERT INTO approvals VALUES($1,$4,$5,0,'completed'),($2,$4,$5,0,'executing'),($3,$4,$5,NULL,'pending')`,
        [randomUUID(), randomUUID(), randomUUID(), owner, latest],
      );
      await db.pool.query('INSERT INTO provider_usage VALUES($1,$2,$3)', [
        randomUUID(),
        owner,
        succeeded,
      ]);
      await db.pool.query('INSERT INTO task_events VALUES($1,$2,$3,$4,now())', [
        randomUUID(),
        succeeded,
        'succeeded',
        'Retained event',
      ]);
      await db.pool.query("INSERT INTO channel_inbox VALUES('fixture-route',$1,$2,'submitted')", [
        owner,
        latest,
      ]);
      await db.pool.query("INSERT INTO channel_task_routes VALUES($1,$2,'fixture-route')", [
        succeeded,
        owner,
      ]);
      const store = createFilesystemObjectStore(join(root, 'objects'));
      const checkpoint = await createPiCheckpoint({
        store,
        threadId: latest,
        directory: join(root, 'old-session'),
      });
      checkpoint.manager.appendMessage({
        role: 'user',
        content: 'Legacy Pi context',
        timestamp: Date.now(),
      });
      let executions = 0;
      await checkpoint.execute('legacy-call', 'fixture_action', async () => {
        executions++;
        return { content: [{ type: 'text', text: 'Legacy action receipt' }] };
      });
      const interrupted = await createPiCheckpoint({
        store,
        threadId: foreign,
        directory: join(root, 'foreign-session'),
      });
      await assert.rejects(
        interrupted.execute('interrupted-call', 'fixture_action', async () => {
          throw new Error('unknown outcome');
        }),
      );
      await mkdir(join(root, 'workspaces', latest), { recursive: true });
      await writeFile(join(root, 'workspaces', latest, 'kept.txt'), 'Saved workspace');
      await db.initializeDatabase();
      await db.pool
        .query(`CREATE FUNCTION reject_legacy_migration() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Fixture migration failure'; END $$;
        CREATE TRIGGER reject_legacy_migration BEFORE UPDATE ON schedule_runs FOR EACH ROW EXECUTE FUNCTION reject_legacy_migration()`);
      await assert.rejects(initializeThreadSchema(), /Fixture migration failure/);
      assert.equal(
        (await db.pool.query('SELECT count(*)::int AS count FROM threads')).rows[0].count,
        0,
      );
      assert.equal(
        (await db.pool.query('SELECT count(*)::int AS count FROM turns')).rows[0].count,
        0,
      );
      await db.pool.query(
        'DROP TRIGGER reject_legacy_migration ON schedule_runs; DROP FUNCTION reject_legacy_migration()',
      );
      await initializeThreadSchema();
      const active = (
        await db.pool.query('SELECT id FROM threads WHERE owner_id=$1 AND archived_at IS NULL', [
          owner,
        ])
      ).rows[0].id;
      assert.equal(active, latest);
      const restored = await createPiCheckpoint({
        store,
        threadId: active,
        directory: join(root, 'new-session'),
      });
      assert.match(
        JSON.stringify(restored.manager.buildSessionContext().messages),
        /Legacy Pi context/,
      );
      assert.match(
        JSON.stringify(restored.manager.buildSessionContext().messages),
        /Legacy action receipt/,
      );
      assert.equal(executions, 1);
      assert.equal(
        await readFile(join(root, 'workspaces', active, 'kept.txt'), 'utf8'),
        'Saved workspace',
      );
      await assert.rejects(
        createPiCheckpoint({ store, threadId: foreign, directory: join(root, 'foreign-new') }),
        /interrupted before its result/,
      );
      assert.deepEqual(
        (
          await db.pool.query('SELECT status,waiting_reason,message_id FROM turns WHERE id=$1', [
            latest,
          ])
        ).rows[0],
        { status: 'waiting', waiting_reason: 'question', message_id: userMessage },
      );
      assert.equal(
        (
          await db.pool.query(
            "SELECT count(*)::int AS count FROM turns WHERE status IN ('queued','running')",
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (await db.pool.query('SELECT status FROM turns WHERE id=$1', [running])).rows[0].status,
        'failed',
      );
      const current = (
        await db.pool.query(
          `SELECT m.id FROM messages m WHERE m.owner_id=$1 AND ${activeThreadSql('m')}`,
          [owner],
        )
      ).rows.map((row) => row.id);
      assert.ok(current.includes(taskless));
      assert.ok(current.includes(assistantMessage));
      assert.ok(!current.includes(wrongOwnerMessage));
      assert.equal(
        (
          await db.pool.query(
            `SELECT count(*)::int AS count FROM messages m WHERE m.owner_id='reset-owner' AND ${activeThreadSql('m')}`,
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (await db.pool.query('SELECT thread_id FROM artifacts WHERE id=$1', [unattachedArtifact]))
          .rows[0].thread_id,
        latest,
      );
      assert.equal(
        (await db.pool.query('SELECT thread_id FROM artifacts WHERE id=$1', [artifact])).rows[0]
          .thread_id,
        latest,
      );
      assert.equal(
        (await db.pool.query('SELECT turn_id FROM provider_usage')).rows[0].turn_id,
        succeeded,
      );
      assert.equal(
        (await db.pool.query('SELECT turn_id FROM turn_events')).rows[0].turn_id,
        succeeded,
      );
      assert.equal(
        (await db.pool.query('SELECT turn_id FROM channel_inbox')).rows[0].turn_id,
        latest,
      );
      assert.deepEqual(
        (await db.pool.query('SELECT message_id,source_id,state,reason FROM channel_outbox')).rows,
        [
          {
            message_id: assistantMessage,
            source_id: 'fixture-route',
            state: 'blocked',
            reason: 'legacy_delivery_not_confirmed',
          },
        ],
      );
      assert.deepEqual(
        (
          await db.pool.query(
            'SELECT thread_id,turn_id,expires_at>now() AS valid FROM discovered_connection_proposals WHERE id=$1',
            [waitingProposal],
          )
        ).rows[0],
        { thread_id: latest, turn_id: latest, valid: true },
      );
      assert.ok(
        (
          await db.pool.query(
            'SELECT expires_at<=now() AS expired FROM discovered_connection_proposals WHERE id=ANY($1)',
            [[staleProposal, foreignProposal]],
          )
        ).rows.every((row) => row.expired),
      );
      assert.equal(
        (await db.pool.query('SELECT turn_id FROM app_connections')).rows[0].turn_id,
        latest,
      );
      assert.deepEqual(
        (await db.pool.query('SELECT status FROM approvals ORDER BY status')).rows.map(
          (row) => row.status,
        ),
        ['completed', 'expired', 'uncertain'],
      );
      assert.ok(
        (await db.pool.query('SELECT thread_id,turn_id FROM approvals')).rows.every(
          (row) => row.thread_id === latest && row.turn_id === latest,
        ),
      );
      const schedules = createSchedules({
        pool: db.pool,
        ownerId: owner,
        refresh() {},
        enqueueTurn: async () => {
          throw new Error('Migration must not dispatch');
        },
        scheduler: {
          createQueue: async () => {},
          work: async () => '',
          send: async () => {
            throw new Error('Migration must not schedule');
          },
          cancel: async () => ({ requested: 0, affected: 0 }),
          getJobById: async () => null,
          unschedule: async () => {},
          previewSchedule: () => [],
        },
      });
      await schedules.initialize({ workers: false });
      const history = await schedules.history();
      assert.equal(history.runs.length, 1);
      assert.equal(history.runs[0].turnId, succeeded);
      assert.equal(history.runs[0].status, 'succeeded');
      assert.equal(history.runs[0].messageId, assistantMessage);
      inspector = createPromptInspector(db.pool, {
        ownerId: owner,
        enabled: () => true,
        provider: 'fixture',
        model: 'fixture',
      });
      await inspector.initialize();
      const prompts = await inspector.read({});
      assert.equal(prompts?.prompts[0].id, snapshot);
      assert.equal(prompts?.prompts[0].turnId, succeeded);
      assert.equal(prompts?.prompts[0].instruction, 'Legacy instruction');
      const resumed: string[] = [];
      const discovered = await createDiscoveredConnections(db.pool, {
        ownerId: owner,
        baseUrl: 'http://127.0.0.1',
        keyStore,
        grantVault,
        transport: {
          validateEndpoint: async (endpoint) => endpoint,
          http: async () => ({ status: 200, body: {} }),
          listTools: async () => [{ name: 'fixture_read', inputSchema: {} }],
          callTool: async () => ({}),
        },
        oauth: {
          begin: async () => {
            throw new Error('Unexpected authorization restart');
          },
          refresh: async () => {
            throw new Error('Unexpected token refresh');
          },
          finish: async (_endpoint, saved, code) => {
            assert.equal(code, 'fixture-code');
            return {
              ...saved,
              tokens: { access_token: 'fixture-private-token', token_type: 'Bearer' },
            };
          },
        },
        resumeConnection: async (turnId) => {
          resumed.push(turnId);
          return true;
        },
      });
      assert.deepEqual(
        await discovered.completeOAuth({ state: oauthState, code: 'fixture-code' }),
        {
          outcome: 'continued',
          service: 'fixture',
          returnTo: 'chat',
        },
      );
      assert.deepEqual(resumed, [latest]);
      const migratedCounts = async () =>
        (
          await db.pool.query(`SELECT (SELECT count(*)::int FROM threads) AS threads,
          (SELECT count(*)::int FROM turns) AS turns,(SELECT count(*)::int FROM turn_events) AS events,
          (SELECT count(*)::int FROM channel_outbox) AS outbox`)
        ).rows[0];
      const firstCounts = await migratedCounts();
      await initializeThreadSchema();
      await initializeThreadSchema();
      assert.deepEqual(await migratedCounts(), firstCounts);
      assert.equal(
        (
          await db.pool.query('SELECT id FROM discovered_connection_proposals WHERE id=$1', [
            waitingProposal,
          ])
        ).rowCount,
        0,
      );
      assert.deepEqual(
        (await db.pool.query('SELECT status FROM approvals ORDER BY status')).rows.map(
          (row) => row.status,
        ),
        ['completed', 'expired', 'uncertain'],
      );
      const before = (await db.pool.query('SELECT count(*)::int AS count FROM turns')).rows[0]
        .count;
      await db.pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [latest]);
      const resetThread = randomUUID();
      await db.pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [resetThread, owner]);
      await initializeThreadSchema();
      assert.equal(
        (await db.pool.query('SELECT count(*)::int AS count FROM turns')).rows[0].count,
        before,
      );
      assert.equal(
        (await db.pool.query('SELECT thread_id FROM messages WHERE id=$1', [taskless])).rows[0]
          .thread_id,
        latest,
      );
      assert.equal(
        (
          await db.pool.query('SELECT count(*)::int AS count FROM messages WHERE thread_id=$1', [
            resetThread,
          ])
        ).rows[0].count,
        0,
      );
    } finally {
      await inspector?.close();
      await db.pool.end();
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
