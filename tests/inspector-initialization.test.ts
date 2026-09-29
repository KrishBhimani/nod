import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connect, createServer, type Socket } from 'node:net';
import test from 'node:test';
import pg from 'pg';
import { createPromptInspector } from '../src/server/inspector-prompts.ts';
import { createProviderUsageStore } from '../src/server/provider-usage.ts';

test(
  'inspector startup uses the migration pool while slow connection setup keeps short recording query limits',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const connection = new URL(process.env.TEST_DATABASE_URL!);
    const schema = `test_inspector_start_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: connection.href });
    const migrations = new pg.Pool({
      connectionString: connection.href,
      options: `-c search_path=${schema}`,
    });
    const sockets = new Set<Socket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const proxy = createServer((socket) => {
      sockets.add(socket);
      socket.pause();
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (socket.destroyed) return;
        const upstream = connect(Number(connection.port || 5432), connection.hostname);
        sockets.add(upstream);
        upstream.on('error', () => socket.destroy());
        upstream.on('close', () => {
          sockets.delete(upstream);
          socket.destroy();
        });
        socket.on('close', () => upstream.destroy());
        socket.pipe(upstream);
        upstream.pipe(socket);
      }, 650);
      timers.add(timer);
    });
    let observations: pg.Pool | undefined;
    let main: pg.Pool | undefined;
    let runtimeQueries = 0;
    const recording = {
      query(...args: Parameters<pg.Pool['query']>) {
        runtimeQueries++;
        if (!observations) throw new Error('Recording must not initialize the schema.');
        return Reflect.apply(observations.query, observations, args);
      },
    } as unknown as pg.Pool;
    let enabled = false;
    const prompts = createPromptInspector(recording, {
      ownerId: 'owner',
      enabled: () => enabled,
      provider: 'fixture',
      model: 'fixture',
    });
    const usage = createProviderUsageStore(recording, {
      ownerId: 'owner',
      enabled: () => enabled,
      coverage: [],
    });
    const turnId = randomUUID();
    const threadId = randomUUID();
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrations.query('CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text)');
      await migrations.query(
        'CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text,thread_id uuid REFERENCES threads(id),prompt text,message_id uuid,status text)',
      );
      await migrations.query("INSERT INTO threads VALUES($1,'owner')", [threadId]);
      await migrations.query("INSERT INTO turns VALUES($1,'owner',$2,'Synthetic',NULL,'running')", [
        turnId,
        threadId,
      ]);
      await t.test(
        'migration and disabled startup retention do not use the recording pool',
        async () => {
          await prompts.initialize(migrations);
          await usage.initialize(migrations);
          assert.equal(runtimeQueries, 0);
          for (const owner of ['owner', 'other']) {
            await migrations.query(
              `INSERT INTO inspector_prompts(id,owner_id,thread_id,turn_id,payload,provider,model,created_at)
            VALUES($1,$2,$3,$4,'{}','fixture','fixture',now()-interval '8 days')`,
              [randomUUID(), owner, threadId, turnId],
            );
            await migrations.query(
              `INSERT INTO provider_usage(id,owner_id,provider,category,operation,status,duration_ms,metrics,pricing,recorded_at)
            VALUES($1,$2,'fixture','browser','snapshot','succeeded',1,'{}','unavailable',now()-interval '8 days')`,
              [randomUUID(), owner],
            );
          }
          await prompts.initialize(migrations);
          await usage.initialize(migrations);
          assert.equal(runtimeQueries, 0);
          for (const table of ['inspector_prompts', 'provider_usage'])
            assert.deepEqual((await migrations.query(`SELECT owner_id FROM ${table}`)).rows, [
              { owner_id: 'other' },
            ]);
        },
      );
      await new Promise<void>((resolve, reject) => {
        proxy.once('error', reject);
        proxy.listen(0, '127.0.0.1', () => resolve());
      });
      const address = proxy.address();
      assert.ok(address && typeof address !== 'string');
      const proxied = new URL(connection);
      proxied.hostname = '127.0.0.1';
      proxied.port = String(address.port);
      proxied.searchParams.set('options', `-c search_path=${schema}`);
      process.env.DATABASE_URL = proxied.href;
      process.env.DOTENV_CONFIG_PATH = '/tmp/otto-synthetic-missing-env';
      const database = await import('../src/server/db.ts');
      main = database.pool;
      observations = database.createInspectorPool();
      await t.test(
        'a delayed PostgreSQL handshake succeeds while slow statements still stop',
        async () => {
          const started = performance.now();
          const connected = await observations!.query('SELECT 1 AS ready');
          assert.equal(connected.rows[0].ready, 1);
          assert.ok(performance.now() - started >= 600);
          assert.equal(observations!.options.query_timeout, 750);
          const limits = await observations!.query('SHOW statement_timeout');
          assert.equal(limits.rows[0].statement_timeout, '500ms');
          await assert.rejects(observations!.query('SELECT pg_sleep(5)'), { code: '57014' });
          assert.equal((await migrations.query('SELECT 1 AS ready')).rows[0].ready, 1);
        },
      );
      await t.test(
        'runtime prompt and usage writes continue on the bounded recording pool',
        async () => {
          enabled = true;
          await prompts.record(turnId, {
            id: randomUUID(),
            system: 'Synthetic system',
            instruction: 'Synthetic instruction',
            resumed: false,
            imageCount: 0,
            reason: 'user',
            createdAt: new Date().toISOString(),
          });
          usage.record({
            provider: 'fixture',
            category: 'browser',
            operation: 'snapshot',
            status: 'succeeded',
            durationMs: 1,
          });
          await usage.flush();
          assert.equal(runtimeQueries, 2);
          for (const table of ['inspector_prompts', 'provider_usage'])
            assert.equal(
              (
                await migrations.query(
                  `SELECT count(*)::int AS count FROM ${table} WHERE owner_id=$1`,
                  ['owner'],
                )
              ).rows[0].count,
              1,
            );
        },
      );
    } finally {
      await prompts.close();
      await usage.close();
      await observations?.end();
      await main?.end();
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await migrations.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
