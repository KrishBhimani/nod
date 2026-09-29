import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { Computer } from '../src/ports/computer.ts';
import { createBrowserConnections } from '../src/server/browser-connections.ts';

test(
  'Pi saves and reuses a verified browser profile for one owner',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `browser_connections_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    try {
      await pool.query(
        'CREATE TABLE threads (id uuid PRIMARY KEY,owner_id text,status text,archived_at timestamptz)',
      );
      await pool.query(
        'CREATE TABLE turns (id uuid PRIMARY KEY,owner_id text,thread_id uuid,status text)',
      );
      const first = { threadId: randomUUID(), turnId: randomUUID() };
      const second = { threadId: randomUUID(), turnId: randomUUID() };
      for (const turn of [first, second]) {
        await pool.query("INSERT INTO threads(id,owner_id,status) VALUES($1,'owner-a','running')", [
          turn.threadId,
        ]);
        await pool.query(
          "INSERT INTO turns(id,owner_id,thread_id,status) VALUES($1,'owner-a',$2,'running')",
          [turn.turnId, turn.threadId],
        );
      }
      let signedIn = false;
      const bindings: string[] = [];
      const removed: string[] = [];
      const computer = {
        async bindProfile(_threadId: string, profileId: string) {
          bindings.push(profileId);
        },
        async act(_threadId: string, input: { action: string; url?: string }) {
          return {
            url: signedIn ? 'https://example.test/account' : 'https://example.test/login',
            text: 'Synthetic page',
            candidates: [],
          };
        },
        async inspectLogin() {
          return {
            origin: 'https://example.test',
            url: signedIn ? 'https://example.test/account' : 'https://example.test/login',
            fields: signedIn
              ? []
              : [{ kind: 'password', selector: '#password', label: 'Password' }],
            methods: [],
          };
        },
        async hold() {},
        async close() {},
        async deleteProfile(profileId: string) {
          removed.push(profileId);
        },
      } as unknown as Computer;
      const service = await createBrowserConnections(pool, { ownerId: 'owner-a', computer });
      const opened = await service.request(
        { action: 'connect', url: 'https://example.test/login' },
        first,
      );
      assert.equal(opened.status, 'profile_opened');
      assert.ok('connectionId' in opened);
      const connectionId = opened.connectionId;
      const save = { action: 'save' as const, url: 'https://example.test/login', connectionId };
      assert.equal((await service.request(save, first)).status, 'needs_sign_in');
      signedIn = true;
      assert.equal((await service.request(save, first)).status, 'session_saved');
      assert.equal((await service.list())[0].browserState, 'saved');
      assert.equal(
        (
          await service.request(
            { action: 'use', url: 'https://example.test/account', connectionId },
            second,
          )
        ).status,
        'session_opened',
      );
      assert.deepEqual(bindings, [bindings[0], bindings[0]]);
      assert.equal(
        (await service.request({ action: 'use', url: 'https://other.test/', connectionId }, second))
          .status,
        'rejected',
      );
      const other = await createBrowserConnections(pool, { ownerId: 'owner-b', computer });
      const foreign = { threadId: randomUUID(), turnId: randomUUID() };
      await pool.query("INSERT INTO threads(id,owner_id,status) VALUES($1,'owner-b','running')", [
        foreign.threadId,
      ]);
      await pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,status) VALUES($1,'owner-b',$2,'running')",
        [foreign.turnId, foreign.threadId],
      );
      await assert.rejects(
        other.request({ action: 'use', url: 'https://example.test/', connectionId }, foreign),
        /unavailable/,
      );
      await pool.query("UPDATE turns SET status='completed' WHERE id=$1", [second.turnId]);
      await assert.rejects(
        service.request({ action: 'use', url: 'https://example.test/', connectionId }, second),
        /no longer active/,
      );
      await service.disconnect(connectionId);
      assert.deepEqual(removed, [bindings[0]]);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
