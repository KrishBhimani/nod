import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

test(
  'core browser metadata and frames work without Inspector and retain ownership and private-capture locks',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15_000 },
  async () => {
    const schema = `test_browser_api_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const db = await import('../src/server/db.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { ownerId, port, configuration } = await import('../src/server/config.ts');
    const taskId = randomUUID();
    const foreignId = randomUUID();
    const capturedAt = '2026-09-25T12:00:00.000Z';
    let currentId: string | undefined = taskId;
    let locked = false;
    let fail = false;
    const captures: string[] = [];
    const app = await createApp({
      configuration: () => configuration({ inspectorEnabled: false }),
      computer: {
        status: () => 'Ready',
        currentSession: () =>
          currentId ? { taskId: currentId, lastActivityAt: capturedAt } : undefined,
        screenStatus: () => ({ state: 'live', capturedAt }),
        screenshot: async (id) => {
          captures.push(id!);
          if (locked)
            throw Object.assign(new Error('Screen hidden during sign-in.'), { statusCode: 423 });
          if (fail) throw new Error('synthetic-private-provider-detail');
          return Buffer.from('synthetic-public-browser-frame');
        },
      },
    });
    const request = (path: string) =>
      app.inject({ url: path, headers: { host: `localhost:${port}` } });
    try {
      await db.initializeDatabase();
      for (const [id, owner] of [
        [taskId, ownerId],
        [foreignId, 'other'],
      ])
        await db.pool.query(
          "INSERT INTO tasks(id,owner_id,title,prompt,status) VALUES($1,$2,'Synthetic browser','Synthetic prompt','running')",
          [id, owner],
        );
      const metadata = await request('/api/browser');
      assert.equal(metadata.statusCode, 200);
      assert.equal(metadata.headers['cache-control'], 'no-store');
      assert.deepEqual(metadata.json(), {
        currentBrowser: {
          taskId,
          title: 'Synthetic browser',
          status: 'running',
          lastActivityAt: capturedAt,
        },
      });
      for (const path of ['/api/inspector', `/api/inspector/screen?taskId=${taskId}`])
        assert.equal((await request(path)).statusCode, 404);
      const frame = await request(`/api/browser/screen?taskId=${taskId}`);
      assert.equal(frame.statusCode, 200);
      assert.match(String(frame.headers['content-type']), /^image\/png/);
      assert.equal(frame.headers['cache-control'], 'no-store');
      assert.equal(frame.headers['referrer-policy'], 'no-referrer');
      assert.equal(frame.headers['x-screen-state'], 'live');
      assert.equal(frame.body, 'synthetic-public-browser-frame');
      for (const id of [foreignId, randomUUID()])
        assert.equal((await request(`/api/browser/screen?taskId=${id}`)).statusCode, 404);
      assert.deepEqual(captures, [taskId]);
      locked = true;
      const privateFrame = await request(`/api/browser/screen?taskId=${taskId}`);
      assert.equal(privateFrame.statusCode, 423);
      assert.equal(privateFrame.headers['cache-control'], 'no-store');
      assert.equal(privateFrame.body.includes('synthetic-public-browser-frame'), false);
      locked = false;
      fail = true;
      const failed = await request(`/api/browser/screen?taskId=${taskId}`);
      assert.equal(failed.statusCode, 500);
      assert.equal(failed.body.includes('synthetic-private-provider-detail'), false);
      currentId = foreignId;
      assert.deepEqual((await request('/api/browser')).json(), { currentBrowser: null });
      currentId = undefined;
      await db.pool.query(
        "INSERT INTO task_events(id,task_id,type,summary) VALUES($1,$2,'tool_complete','browser')",
        [randomUUID(), taskId],
      );
      await db.pool.query(
        "INSERT INTO task_events(id,task_id,type,summary) VALUES($1,$2,'tool_complete','browser')",
        [randomUUID(), foreignId],
      );
      const fallback = (await request('/api/browser')).json();
      assert.equal(fallback.currentBrowser.taskId, taskId);
      assert.deepEqual(Object.keys(fallback), ['currentBrowser']);
    } finally {
      await app.close();
      await db.pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
