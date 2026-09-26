import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { MessagingAttachment } from '../src/ports/messaging.ts';
import type { ApplicationAdapters } from '../src/server/composition.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

test(
  'verified Telegram shares owned web context and saved facts while reset, provenance and channel routing remain fenced',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 45_000 },
  async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_channel_context_${suffix}`;
    const bossSchema = `test_channel_context_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const { createApplication } = await import('../src/server/composition.ts');
    const { pool } = await import('../src/server/db.ts');
    const { ownerId, port, dataRoot } = await import('../src/server/config.ts');
    const key = randomBytes(32);
    const seen: Array<{ taskId: string; system: string; prompt: string }> = [];
    const sent: string[] = [];
    const sentAttachments: MessagingAttachment[][] = [];
    const screenshotBytes = Buffer.from('masked screenshot delivery fixture');
    let webMessageId = '';
    const adapters: ApplicationAdapters = {
      agent: {
        open: async (options) => ({
          resumed: false,
          abort() {},
          dispose() {},
          prompt: async (prompt) => {
            seen.push({ taskId: options.taskId, system: options.systemPrompt, prompt });
            const marker = 'Request data (JSON):\n';
            const markerIndex = prompt.indexOf(marker);
            assert.notEqual(markerIndex, -1);
            const { currentInstruction } = JSON.parse(prompt.slice(markerIndex + marker.length));
            assert.equal(typeof currentInstruction, 'string');
            const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
            const call = (name: string, args: Record<string, unknown>) =>
              tools.get(name)!.execute(args);
            if (currentInstruction === 'I prefer brief replies.')
              await call('remember', { quote: 'I prefer brief replies.' });
            if (currentInstruction === 'I live in Porto.')
              await call('manage_personal_context', {
                action: 'profile_learn',
                args: { field: 'location', value: 'Porto', quote: 'I live in Porto.' },
              });
            if (currentInstruction === 'Check our shared context.') {
              const search = await call('manage_personal_context', {
                action: 'history_search',
                args: { query: 'Morgan' },
              });
              assert.equal(search.content[0].type, 'text');
              if (search.content[0].type === 'text') {
                const history = JSON.parse(search.content[0].text);
                assert.ok(
                  history.messages.some(
                    (message: { text: string; channel: string }) =>
                      message.text === 'My name is Morgan.' && message.channel === 'web',
                  ),
                );
                assert.ok(
                  history.messages.every(
                    (message: { channel: string }) => !message.channel.includes(':'),
                  ),
                );
              }

              const reaction = await call('react_to_message', {
                messageId: webMessageId,
                reaction: '👍',
              });
              assert.equal(reaction.content[0].type, 'text');
              if (reaction.content[0].type === 'text') {
                const result = JSON.parse(reaction.content[0].text);
                assert.equal(result.status, 'skipped');
                assert.equal(result.reason, 'unavailable');
              }
              await assert.rejects(
                call('send_message', {
                  text: 'Wrong channel reply',
                  replyToMessageId: webMessageId,
                }),
                /could not be completed/,
              );
              await assert.rejects(
                call('remember', { quote: 'My name is Morgan.' }),
                /could not be completed/,
              );
            }
            if (currentInstruction === 'Check context after reset.') {
              const search = await call('manage_personal_context', {
                action: 'history_search',
                args: { query: 'Morgan' },
              });
              assert.equal(search.content[0].type, 'text');
              if (search.content[0].type === 'text')
                assert.deepEqual(JSON.parse(search.content[0].text), { tasks: [], messages: [] });
            }
            if (currentInstruction === 'Send the screenshot.') {
              await call('send_screenshot', {});
              return;
            }
            options.onEvent({ type: 'final', text: 'Shared context checked.' });
          },
        }),
        dispose() {},
      },
      computer: fakeComputer({ screenshot: async () => screenshotBytes }),
      workspace: fakeWorkspace(),
      speech: {
        id: 'fixture',
        configured: false,
        transcribe: async () => '',
        synthesize: async () => ({
          bytes: Buffer.alloc(0),
          mimeType: 'audio/mpeg',
          fileName: 'fixture.mp3',
        }),
      },
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      relevance: { id: 'fixture', configured: false, classify: async () => 'ignore' },
      model: { provider: 'fixture', name: 'fixture', configured: true },
      integrations: {
        id: 'fixture',
        configured: false,
        webhooksConfigured: false,
        supportsSubscriptions: [],
        createSession: async () => {
          throw new Error('No integration');
        },
        restoreSession: async () => {
          throw new Error('No integration');
        },
        deleteSession: async () => {},
        inspectAccount: async () => ({ active: false, service: 'gmail' }),
        deleteAccount: async () => {},
        parseCallback: () => {
          throw new Error('No integration');
        },
        subscribe: async () => ({ id: 'unused' }),
        unsubscribe: async () => {},
        verifyWebhook: async () => {
          throw new Error('No integration');
        },
        matchesSubscription: () => false,
      },
      messaging: {
        channels: [
          {
            id: 'telegram',
            status: 'configured',
            missing: [],
            supportsAttachments: true,
            accountId: 'fixture-bot-account',
            allowedSenderIds: ['fixture-approved-owner'],
          },
        ],
        receive: async (request) => {
          if (request.headers['x-fixture-secret'] !== 'verified')
            return { status: 401, body: 'Unauthorized' };
          const body = JSON.parse(Buffer.from(request.body).toString());
          return {
            status: 200,
            body: 'Accepted',
            messages: [
              {
                channelId: 'telegram',
                accountId: body.accountId ?? 'fixture-bot-account',
                senderId: body.senderId ?? 'fixture-approved-owner',
                messageId: String(body.id),
                threadId: 'fixture-thread',
                text: body.text,
                sentAt: new Date(),
              },
            ],
          };
        },
        post: async (message) => {
          sent.push(message.text);
          sentAttachments.push(message.attachments ?? []);
          return { id: `fixture-${sent.length}` };
        },
        close: async () => {},
      },
    };
    const application = await createApplication(adapters);
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    const request = (
      method: 'GET' | 'POST' | 'PUT',
      path: string,
      payload?: Record<string, unknown>,
    ) => application.app.inject({ method, url: path, headers, payload });
    const waitFor = async (predicate: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await predicate()) return;
        await delay(25);
      }
      throw new Error('Channel context fixture did not complete.');
    };
    const finished = async (id: string) =>
      waitFor(async () => {
        const row = (await pool.query('SELECT status,error FROM tasks WHERE id=$1', [id])).rows[0];
        assert.notEqual(row?.status, 'failed', row?.error);
        return row?.status === 'succeeded';
      });
    const sendWeb = async (text: string) => {
      const response = await request('POST', '/api/messages', { text });
      assert.equal(response.statusCode, 200);
      const id = response.json().taskId as string;
      await finished(id);
      return id;
    };
    const sendTelegram = async (id: number, extra: Record<string, unknown> = {}) =>
      application.app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: { 'content-type': 'application/json', 'x-fixture-secret': 'verified' },
        payload: { id, text: 'Check our shared context.', ...extra },
      });
    try {
      const nameTask = await sendWeb('My name is Morgan.');
      webMessageId = (
        await pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='user'", [nameTask])
      ).rows[0].id;
      assert.equal((await pool.query('SELECT * FROM profiles')).rowCount, 0);
      await sendWeb('I prefer brief replies.');
      await sendWeb('I live in Porto.');
      assert.equal(
        (await request('POST', '/api/goals', { title: 'Finish the fixture workbook' })).statusCode,
        200,
      );
      await pool.query('UPDATE profiles SET data=data || $2::jsonb WHERE owner_id=$1', [
        ownerId,
        { phone: '+351912345678' },
      ]);
      await pool.query(
        "INSERT INTO memory_facts(id,owner_id,text) SELECT gen_random_uuid(),$1,'Saved fixture fact ' || index FROM generate_series(1,28) index",
        [ownerId],
      );
      await pool.query(
        'INSERT INTO preferences(owner_id,time_zone) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET time_zone=excluded.time_zone',
        [ownerId, 'America/New_York'],
      );
      const foreignTask = randomUUID();
      await pool.query(
        "INSERT INTO tasks(id,owner_id,title,prompt,status,channel) VALUES($1,'foreign-owner','Foreign','Foreign','succeeded','web')",
        [foreignTask],
      );
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,'foreign-owner','user','Foreign private identity',$2),($3,$4,'user','Foreign task private identity',$2)",
        [randomUUID(), foreignTask, randomUUID(), ownerId],
      );
      assert.equal((await sendTelegram(1, { senderId: 'unapproved-sender' })).statusCode, 200);
      assert.equal((await sendTelegram(2, { accountId: 'wrong-bot' })).statusCode, 200);
      await application.channels!.drain();
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);
      assert.equal((await sendTelegram(3)).statusCode, 200);
      await application.channels!.drain();
      const channelTask = (await pool.query('SELECT task_id FROM channel_inbox')).rows[0]
        .task_id as string;
      await finished(channelTask);
      const observed = seen.find((item) => item.taskId === channelTask)!;
      assert.match(observed.system, /My name is Morgan/);
      assert.match(observed.system, /I prefer brief replies/);
      assert.match(observed.system, /Porto/);
      assert.ok(observed.system.includes('+351912345678'));
      assert.match(observed.system, /Finish the fixture workbook/);
      assert.match(observed.system, /Saved fixture fact 28/);
      assert.match(observed.system, /User time zone: America\/New_York\./);
      assert.match(observed.system, /same verified owner/);
      assert.match(observed.system, /This conversation is on telegram\./);
      for (const privateValue of [
        webMessageId,
        'Foreign private identity',
        'Foreign task private identity',
        'fixture-approved-owner',
        'fixture-bot-account',
      ])
        assert.equal(observed.system.includes(privateValue), false, privateValue);
      assert.equal(observed.prompt.includes('My name is Morgan'), false);
      assert.equal(
        (await pool.query("SELECT * FROM memory_facts WHERE text='My name is Morgan.'")).rowCount,
        0,
      );
      assert.equal(
        (await pool.query('SELECT assistant_reaction FROM messages WHERE id=$1', [webMessageId]))
          .rows[0].assistant_reaction,
        null,
      );
      const memories = (
        await pool.query(
          'SELECT m.source_message_id,s.role,s.owner_id FROM memory_facts m JOIN messages s ON s.id=m.source_message_id',
        )
      ).rows;
      assert.equal(memories.length, 2);
      assert.ok(memories.every((row) => row.role === 'user' && row.owner_id === ownerId));
      assert.equal((await request('POST', '/api/conversation/reset', {})).statusCode, 200);
      assert.equal((await sendTelegram(4, { text: 'Check context after reset.' })).statusCode, 200);
      await application.channels!.drain();
      const afterTask = (
        await pool.query("SELECT task_id FROM channel_inbox WHERE source_id LIKE '%:4'")
      ).rows[0].task_id as string;
      await finished(afterTask);
      const after = seen.find((item) => item.taskId === afterTask)!;
      assert.equal(after.system.includes('My name is Morgan.'), false);
      assert.match(after.system, /I prefer brief replies/);
      assert.match(after.system, /Porto/);
      assert.match(after.system, /Finish the fixture workbook/);
      assert.equal(
        (await request('GET', '/api/state'))
          .json()
          .messages.some((message: { text: string }) => message.text === 'My name is Morgan.'),
        false,
      );
      assert.equal((await sendTelegram(5, { text: 'Send the screenshot.' })).statusCode, 200);
      await application.channels!.drain();
      const screenshotTask = (
        await pool.query("SELECT task_id FROM channel_inbox WHERE source_id LIKE '%:5'")
      ).rows[0].task_id as string;
      await finished(screenshotTask);
      await application.channels!.drain();
      const delivered = sentAttachments.flat();
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].name, 'screenshot.png');
      assert.equal(delivered[0].mimeType, 'image/png');
      assert.deepEqual(Buffer.from(delivered[0].bytes), screenshotBytes);
      assert.equal(
        (
          await pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='assistant'", [
            screenshotTask,
          ])
        ).rowCount,
        1,
      );
    } finally {
      await application.app.close();
      const files = (await pool.query('SELECT storage_path FROM artifacts')).rows;
      await Promise.all(files.map(({ storage_path }) => rm(storage_path, { force: true })));
      const ownedTasks = (await pool.query('SELECT id FROM tasks WHERE owner_id=$1', [ownerId]))
        .rows;
      await Promise.all(
        ownedTasks.map(({ id }) =>
          rm(join(dataRoot, 'workspaces', id), { recursive: true, force: true }),
        ),
      );
      await pool.end();
      await admin.query(`DROP SCHEMA ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
