import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createChatEvidence } from '../scripts/e2e-evidence.ts';

test(
  'acceptance evidence follows thread requests, streams and durable turns without recording content',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `test_evidence_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const previousDatabase = process.env.DATABASE_URL;
    const database = new URL(process.env.TEST_DATABASE_URL!);
    database.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = database.href;
    const { initializeDatabase, pool } = await import('../src/server/db.ts');
    const timeline: Array<{ kind: string } & Record<string, unknown>> = [];
    const evidence = createChatEvidence(pool, (kind, fields) => timeline.push({ kind, ...fields }));
    const threadId = randomUUID();
    const turnId = randomUUID();
    const messageId = randomUUID();
    const eventId = randomUUID();
    try {
      await initializeDatabase();
      await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [
        threadId,
        'fixture-owner',
      ]);
      await pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,source,prompt) VALUES($1,'fixture-owner',$2,'user','Private prompt fixture')",
        [turnId, threadId],
      );
      evidence.accepted('request-1', JSON.stringify({ threadId, turnId, messageId }));
      evidence.accepted('request-2', JSON.stringify({ error: 'Private error fixture' }));
      evidence.accepted('request-3', 'invalid');
      const delta = {
        type: 'delta',
        threadId,
        turnId,
        streamId: 'stream-1',
        text: 'Private delta fixture',
      };
      evidence.delta({ ...delta, text: '' });
      evidence.delta(delta);
      evidence.delta(delta);
      await evidence.sample();
      await evidence.sample();
      await pool.query(
        "UPDATE turns SET status='succeeded',started_at=now(),finished_at=now() WHERE id=$1",
        [turnId],
      );
      await pool.query(
        "INSERT INTO turn_events(id,turn_id,type,summary) VALUES($1,$2,'completed','Private event fixture')",
        [eventId, turnId],
      );
      await pool.query(
        "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,'fixture-owner',$2,$3,'assistant','Private reply fixture')",
        [messageId, threadId, turnId],
      );
      await evidence.sample();
      await evidence.sample();
      assert.deepEqual(
        timeline.map(({ kind }) => kind),
        [
          'chat_request_accepted',
          'first_visible_delta',
          'turn_state',
          'turn_state',
          'turn_event',
          'assistant_message_saved',
        ],
      );
      assert.ok(timeline.every((event) => event.threadId === threadId && event.turnId === turnId));
      assert.deepEqual(
        timeline.filter(({ kind }) => kind === 'turn_state').map(({ status }) => status),
        ['queued', 'succeeded'],
      );
      assert.equal(timeline.at(-2)?.eventId, eventId);
      assert.equal(timeline.at(-1)?.messageId, messageId);
      assert.doesNotMatch(JSON.stringify(timeline), /Private|taskId|revision/);
    } finally {
      if (previousDatabase === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabase;
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
