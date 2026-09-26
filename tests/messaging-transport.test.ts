import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type { InboundMessage, MessagingTransport } from '../src/ports/messaging.ts';
import { createChannels } from '../src/server/channels.ts';

test(
  'a replacement messaging transport reuses durable delivery and owner boundaries without an SDK',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_transport_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(`CREATE TABLE tasks(id uuid PRIMARY KEY, source_id text UNIQUE);
    CREATE TABLE messages(id uuid PRIMARY KEY, owner_id text, role text, text text, task_id uuid, attachments jsonb DEFAULT '[]')`);
    t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('A replacement transport must not use an SDK or network here.');
    });
    const app = Fastify();
    const outbound: Array<{
      channelId: string;
      accountId: string;
      threadId: string;
      text: string;
    }> = [];
    const receivedBodies: string[] = [];
    const message: InboundMessage = {
      channelId: 'fixture',
      accountId: 'account-one',
      senderId: 'allowed-owner',
      threadId: 'private-thread',
      messageId: 'message-one',
      text: 'A synthetic request',
      sentAt: new Date(),
    };
    let inbound = [message];
    let onRefresh = () => {};
    let unsubscribed = false;
    let closed = false;
    let trusted = true;
    const transport: MessagingTransport = {
      channels: [
        {
          id: 'fixture',
          status: 'configured',
          missing: [],
          accountId: 'account-one',
          allowedSenderIds: ['allowed-owner'],
          replyWindowMs: 86400000,
        },
      ],
      async receive(request) {
        receivedBodies.push(Buffer.from(request.body).toString());
        return trusted
          ? { status: 200, body: { ok: true }, messages: inbound }
          : { status: 401, body: { error: 'Invalid webhook.' }, messages: inbound };
      },
      async post(input) {
        outbound.push(input);
        return { id: 'sent-fixture' };
      },
      async close() {
        closed = true;
      },
    };
    const channels = await createChannels(pool, {
      ownerId: 'fixture-owner',
      transport,
      intervalMs: 600000,
      subscribe(listener) {
        onRefresh = listener;
        return () => {
          unsubscribed = true;
        };
      },
      async submit(_text, sourceId, client) {
        const result = await client.query(
          'INSERT INTO tasks(id,source_id) VALUES($1,$2) RETURNING id',
          [randomUUID(), sourceId],
        );
        return result.rows[0].id;
      },
    });
    channels.registerRoutes(app);
    const receive = () =>
      app.inject({
        method: 'POST',
        url: '/api/webhooks/fixture',
        headers: { 'content-type': 'text/plain' },
        payload: '  exact raw fixture\n',
      });
    try {
      trusted = false;
      assert.equal((await receive()).statusCode, 401);
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);
      trusted = true;
      inbound = [
        { ...message, senderId: 'someone-else' },
        { ...message, accountId: 'another-account' },
        { ...message, channelId: 'wrong-channel' },
        { ...message, sentAt: new Date(Date.now() + 600000) },
      ];
      assert.equal((await receive()).statusCode, 200);
      await channels.drain();
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);
      inbound = [message];
      await Promise.all([receive(), receive()]);
      await channels.drain();
      const tasks = await pool.query('SELECT id FROM tasks');
      assert.equal(tasks.rowCount, 1);
      assert.ok(receivedBodies.every((body) => body === '  exact raw fixture\n'));
      await pool.query(
        'INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), 'fixture-owner', 'assistant', 'A completed reply', tasks.rows[0].id],
      );
      await pool.query(
        'INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), 'another-owner', 'assistant', 'Private other owner reply', tasks.rows[0].id],
      );
      onRefresh();
      await channels.drain();
      assert.deepEqual(outbound, [
        {
          channelId: 'fixture',
          accountId: 'account-one',
          threadId: 'private-thread',
          text: 'A completed reply',
        },
      ]);
      await channels.drain();
      assert.equal(outbound.length, 1);
      const status = (await app.inject('/api/channels')).json();
      assert.deepEqual(status.channels, [
        { provider: 'fixture', status: 'configured', missing: [] },
      ]);
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/webhooks/unknown', payload: {} }))
          .statusCode,
        404,
      );
      await app.close();
      assert.equal(closed, true);
      assert.equal(unsubscribed, true);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
