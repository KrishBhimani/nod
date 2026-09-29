import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

test(
  'history paging and message reactions preserve ownership, thread scope and stable order',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `test_chat_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const { pool, initializeDatabase } = await import('../src/server/db.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { activeThread, initializeThreadSchema } = await import('../src/server/thread.ts');
    const { ownerId, port } = await import('../src/server/config.ts');
    const app = await createApp();
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    try {
      await initializeDatabase();
      await initializeThreadSchema();
      const thread = (await activeThread(pool)).id;
      const otherThread = randomUUID(),
        archivedThread = randomUUID(),
        turn = randomUUID();
      await pool.query("INSERT INTO threads(id,owner_id) VALUES($1,'other-owner')", [otherThread]);
      await pool.query('INSERT INTO threads(id,owner_id,archived_at) VALUES($1,$2,now())', [
        archivedThread,
        ownerId,
      ]);
      await pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status) VALUES($1,$2,$3,'user','Fixture','succeeded')",
        [turn, ownerId, thread],
      );
      for (let i = 0; i < 135; i++)
        await pool.query(
          "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,created_at) VALUES($1,$2,'assistant',$3,$4,$5,'2026-09-20 12:00:00.123456+00'::timestamptz)",
          [randomUUID(), ownerId, `Fixture ${i}`, thread, turn],
        );
      const foreign = randomUUID(),
        archived = randomUUID();
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id) VALUES($1,'other-owner','assistant','private content',$2)",
        [foreign, otherThread],
      );
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id) VALUES($1,$2,'assistant','archived content',$3)",
        [archived, ownerId, archivedThread],
      );
      const seen = new Set<string>();
      let cursor = '';
      for (let i = 0; i < 3; i++) {
        const response = await app.inject({ url: `/api/messages${cursor}`, headers });
        assert.equal(response.statusCode, 200);
        const { messages: rows, hasMore } = response.json();
        assert.equal(rows.length, i === 2 ? 15 : 60);
        assert.equal(hasMore, i !== 2);
        for (const row of rows) {
          assert.ok(!seen.has(row.id));
          assert.notEqual(row.text, 'private content');
          assert.notEqual(row.text, 'archived content');
          assert.equal(row.turnId, turn);
          assert.equal(row.turn?.id, turn);
          assert.equal(row.turn?.costUsd, null);
          seen.add(row.id);
        }
        cursor = `?before=${encodeURIComponent(rows[0].createdAt)}&beforeId=${rows[0].id}&threadId=${thread}`;
      }
      assert.equal(seen.size, 135);
      assert.equal(
        (await app.inject({ url: `/api/messages?threadId=${archivedThread}`, headers })).statusCode,
        409,
      );
      await pool.query(
        "UPDATE turns SET source='event',source_id='onboarding:welcome',background=true,status='running',created_at=now()-interval '1 day' WHERE id=$1",
        [turn],
      );
      for (let index = 0; index < 51; index++)
        await pool.query(
          "INSERT INTO turns(id,owner_id,thread_id,source,prompt,background) VALUES($1,$2,$3,'schedule','Newer fixture',true)",
          [randomUUID(), ownerId, thread],
        );
      const state = (await app.inject({ url: '/api/state', headers })).json();
      assert.equal(state.threadId, thread);
      assert.equal(state.turns.length, 51);
      assert.equal(
        state.turns.find((candidate: { id: string }) => candidate.id === turn)?.showTyping,
        true,
      );
      const olderPage = (await app.inject({ url: '/api/messages', headers })).json();
      assert.ok(
        olderPage.messages.every((row: { turn: { showTyping: boolean } }) => row.turn.showTyping),
      );
      const message = [...seen][0];
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/messages/${message}/reaction`,
            headers,
            payload: { reaction: 'heart' },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (await pool.query('SELECT reaction FROM messages WHERE id=$1', [message])).rows[0].reaction,
        'heart',
      );
      for (const id of [foreign, archived])
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: `/api/messages/${id}/reaction`,
              headers,
              payload: { reaction: 'heart' },
            })
          ).statusCode,
          404,
        );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/messages/${message}/reaction`,
            headers,
            payload: { reaction: 'bogus' },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            url: '/api/messages',
            headers: { ...headers, 'sec-fetch-site': 'cross-site' },
          })
        ).statusCode,
        403,
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
