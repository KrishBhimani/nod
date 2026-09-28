import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { createChannels } from '../src/server/channels.ts';
import { createChatSdkTransport } from '../src/providers/chat-sdk/index.ts';

const environment = {
  TELEGRAM_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: '987:fixture-not-live',
  TELEGRAM_WEBHOOK_SECRET_TOKEN: 'fixture-webhook-secret-32-characters',
  TELEGRAM_ALLOWED_USER_ID: '123456',
};

test(
  'Telegram sends owned artifact bytes through Chat SDK and does not replay partial delivery or read foreign paths',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_channel_media_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const { initializeDatabase, pool } = await import('../src/server/db.ts');
    const { storeArtifact, readTaskArtifacts, maxFileSize } =
      await import('../src/server/artifacts.ts');
    const { ownerId, dataRoot } = await import('../src/server/config.ts');
    await initializeDatabase();
    await pool.query('ALTER TABLE tasks ADD COLUMN source_id text UNIQUE');
    const sent: Array<{
      method: string;
      file: Uint8Array;
      name: string;
      caption: string;
      chat: string;
    }> = [];
    let failDocument = false;
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const target = input instanceof Request ? input.url : String(input);
        if (target.endsWith('/getMe'))
          return Response.json({
            ok: true,
            result: { id: 987, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' },
          });
        assert.match(
          target,
          /^https:\/\/api\.telegram\.org\/bot987:fixture-not-live\/send(?:Photo|Document)$/,
        );
        assert.ok(init?.body instanceof FormData);
        const body = init.body;
        const media = body.get('photo') ?? body.get('document');
        assert.ok(media instanceof File);
        const method = target.split('/').at(-1)!;
        sent.push({
          method,
          file: new Uint8Array(await media.arrayBuffer()),
          name: media.name,
          caption: String(body.get('caption') ?? ''),
          chat: String(body.get('chat_id')),
        });
        if (method === 'sendDocument' && failDocument)
          throw new Error('Possibly accepted by provider');
        return Response.json({
          ok: true,
          result: {
            message_id: sent.length + 100,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 123456, type: 'private' },
            text: 'Fixture accepted',
          },
        });
      },
    );
    let holdResolve = false;
    let markResolveStarted = () => {};
    let releaseResolve = () => {};
    const resolveStarted = new Promise<void>((resolve) => {
      markResolveStarted = resolve;
    });
    const resolveReleased = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId,
      transport: createChatSdkTransport(pool, environment),
      resolveAttachments: async (taskId, ids) => {
        if (holdResolve) {
          markResolveStarted();
          await resolveReleased;
        }
        return readTaskArtifacts(taskId, ids);
      },
      subscribe: () => () => {},
      intervalMs: 600_000,
      submit: async (text, sourceId, client) =>
        (
          await client.query(
            "INSERT INTO tasks(id,owner_id,title,prompt,status,source_id) VALUES($1,$2,'Fixture',$3,'succeeded',$4) RETURNING id",
            [randomUUID(), ownerId, text, sourceId],
          )
        ).rows[0].id,
    });
    channels.registerRoutes(app);
    const filePaths: string[] = [];
    const addReply = async (taskId: string, attachments: unknown[], text = 'Here is the file.') => {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,task_id,attachments) VALUES($1,$2,'assistant',$3,$4,$5)",
        [id, ownerId, text, taskId, JSON.stringify(attachments)],
      );
      return id;
    };
    const state = async (id: string) =>
      (await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [id]))
        .rows[0];
    try {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/webhooks/telegram',
            headers: {
              'content-type': 'application/json',
              'x-telegram-bot-api-secret-token': environment.TELEGRAM_WEBHOOK_SECRET_TOKEN,
            },
            payload: {
              update_id: 1,
              message: {
                message_id: 1,
                date: Math.floor(Date.now() / 1000),
                text: 'Send a screenshot and file',
                from: { id: 123456, is_bot: false, first_name: 'Fixture' },
                chat: { id: 123456, type: 'private' },
              },
            },
          })
        ).statusCode,
        200,
      );
      await channels.drain();
      const taskId = (await pool.query('SELECT task_id FROM channel_inbox')).rows[0]
        .task_id as string;
      const imageBytes = Buffer.from('masked image fixture');
      const fileBytes = Buffer.from('completed document fixture');
      const image = await storeArtifact(imageBytes, 'screenshot.png', 'image/png', taskId);
      const document = await storeArtifact(fileBytes, 'result.txt', 'text/plain', taskId);
      filePaths.push(
        join(dataRoot, 'artifacts', image.id),
        join(dataRoot, 'artifacts', document.id),
      );
      const reply = await addReply(
        taskId,
        [{ ...image, url: 'https://attacker.invalid/ignored', name: 'spoof.png' }, document],
        `[Screenshot](${image.url})`,
      );
      await channels.drain();
      assert.deepEqual(
        sent.map(({ method }) => method),
        ['sendPhoto', 'sendDocument'],
      );
      assert.deepEqual(Buffer.from(sent[0].file), imageBytes);
      assert.deepEqual(Buffer.from(sent[1].file), fileBytes);
      assert.equal(sent[0].name, 'screenshot.png');
      assert.equal(sent[1].name, 'result.txt');
      assert.ok(
        sent.every(
          ({ chat, caption }) =>
            chat === '123456' &&
            !caption.includes('/api/artifacts') &&
            !caption.includes('localhost'),
        ),
      );
      assert.equal((await state(reply)).state, 'sent');
      await channels.drain();
      assert.equal(sent.length, 2);

      failDocument = true;
      const uncertain = await addReply(taskId, [image, document]);
      await channels.drain();
      assert.equal((await state(uncertain)).state, 'uncertain');
      const partialCount = sent.length;
      await channels.drain();
      assert.equal(sent.length, partialCount);
      failDocument = false;

      const anotherTask = randomUUID();
      await pool.query(
        "INSERT INTO tasks(id,owner_id,title,prompt,status) VALUES($1,$2,'Other','Other','succeeded')",
        [anotherTask, ownerId],
      );
      await assert.rejects(readTaskArtifacts(anotherTask, [image.id]), /unavailable/);
      await pool.query("UPDATE artifacts SET owner_id='foreign-owner' WHERE id=$1", [image.id]);
      const foreign = await addReply(taskId, [image]);
      await channels.drain();
      assert.deepEqual(await state(foreign), {
        state: 'blocked',
        reason: 'attachment_unavailable',
      });
      assert.equal(sent.length, partialCount);
      await pool.query('UPDATE artifacts SET owner_id=$2 WHERE id=$1', [image.id, ownerId]);

      const outside = join(dataRoot, `media-fixture-${randomUUID()}`);
      filePaths.push(outside);
      await writeFile(outside, 'private host data');
      await pool.query('UPDATE artifacts SET storage_path=$2 WHERE id=$1', [image.id, outside]);
      await assert.rejects(readTaskArtifacts(taskId, [image.id]), /unavailable/);
      const imagePath = join(dataRoot, 'artifacts', image.id);
      await pool.query('UPDATE artifacts SET storage_path=$2 WHERE id=$1', [image.id, imagePath]);
      await rm(imagePath);
      await symlink(outside, imagePath);
      await assert.rejects(readTaskArtifacts(taskId, [image.id]));
      await rm(imagePath);
      await writeFile(imagePath, imageBytes);
      await pool.query('UPDATE artifacts SET size=$2 WHERE id=$1', [image.id, maxFileSize + 1]);
      await assert.rejects(readTaskArtifacts(taskId, [image.id]), /limit/);
      await pool.query('UPDATE artifacts SET size=$2 WHERE id=$1', [image.id, imageBytes.length]);
      await assert.rejects(readTaskArtifacts(taskId, ['https://attacker.invalid/file']));
      await assert.rejects(readTaskArtifacts(taskId, Array(11).fill(image.id)));
      const forged = await addReply(taskId, [{ url: 'http://localhost:4310/private' }]);
      await channels.drain();
      assert.equal((await state(forged)).state, 'blocked');
      assert.equal(sent.length, partialCount);
      holdResolve = true;
      const changedAccount = await addReply(taskId, [image]);
      const pending = channels.drain();
      await resolveStarted;
      const fallback: string[] = [];
      const replacement = channels.replaceTransport({
        channels: [
          {
            id: 'telegram',
            status: 'configured',
            missing: [],
            accountId: '987',
            allowedSenderIds: ['123456'],
          },
        ],
        receive: async () => ({ status: 200, body: 'Accepted' }),
        post: async (input) => {
          assert.equal(input.attachments, undefined);
          fallback.push(input.text);
          return { id: 'fallback-fixture' };
        },
        close: async () => {},
      });
      releaseResolve();
      await Promise.all([pending, replacement]);
      assert.deepEqual(await state(changedAccount), {
        state: 'blocked',
        reason: 'channel_access_changed',
      });
      assert.equal(sent.length, partialCount);
      const localOnly = await addReply(taskId, [image]);
      await channels.drain();
      assert.equal((await state(localOnly)).state, 'sent');
      assert.match(fallback[0], /Attachments are available in Otto/);
    } finally {
      releaseResolve();
      await app.close();
      await Promise.all(filePaths.map((path) => rm(path, { force: true })));
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
