import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { synthesizeSpeech } from '../src/server/speech.ts';
import type { RuntimeContext } from '../src/shared/contracts.ts';

const audioFixture = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0, 102, 105, 120, 116, 117, 114, 101]);

test('speech uses a server key, returns bounded audio, and hides provider errors', async t => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'speech-fixture-secret';
  let requests = 0;
  const fetch = t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    requests++;
    assert.equal(input, 'https://api.openai.com/v1/audio/speech');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer speech-fixture-secret');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.input, 'Hello fixture.');
    assert.equal(body.response_format, 'mp3');
    assert.equal(JSON.stringify(body).includes('speech-fixture-secret'), false);
    return new Response(audioFixture, { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  try {
    assert.deepEqual(await synthesizeSpeech('Hello fixture.'), Buffer.from(audioFixture));
    await assert.rejects(synthesizeSpeech('x'.repeat(3001)));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(synthesizeSpeech('Hello fixture.', controller.signal));
    assert.equal(requests, 1);
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(synthesizeSpeech('Hello fixture.'), error => error instanceof Error && 'statusCode' in error && error.statusCode === 503);
    assert.equal(requests, 1);
    process.env.OPENAI_API_KEY = 'speech-fixture-secret';
    fetch.mock.mockImplementation(async () => new Response('speech-fixture-secret', { status: 401 }));
    await assert.rejects(synthesizeSpeech('Hello fixture.'), error => error instanceof Error && error.message === 'Speech generation failed.');
    fetch.mock.mockImplementation(async () => new Response(new Uint8Array(15 * 1024 * 1024 + 1)));
    await assert.rejects(synthesizeSpeech('Hello fixture.'), /too large/);
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});

test('speech route and task audio share generation; cancelled or stale tasks cannot publish', { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 }, async t => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const schema = `test_speech_${suffix}`;
  const bossSchema = `test_speech_boss_${suffix}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.href;
  process.env.PGBOSS_SCHEMA = bossSchema;
  process.env.OPENAI_API_KEY = 'speech-fixture-key-never-live';
  const db = await import('../src/server/db.ts');
  const tasks = await import('../src/server/tasks.ts');
  const personal = await import('../src/server/personal.ts');
  const { createApp } = await import('../src/server/app.ts');
  const { ownerId, dataRoot, port } = await import('../src/server/config.ts');
  const app = await createApp();
  let requests = 0;
  let release = () => {};
  let gate: Promise<void> | undefined;
  let waiting = false;
  let finished = false;
  let captured: RuntimeContext | undefined;
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    assert.equal(input, 'https://api.openai.com/v1/audio/speech');
    requests++;
    assert.equal(JSON.stringify(JSON.parse(String(init?.body))).includes('speech-fixture-key-never-live'), false);
    if (gate) { waiting = true; await gate; }
    return new Response(audioFixture, { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  tasks.configureTasks({
    runTask: async context => {
      captured = context;
      try { await context.createAudio!('Spoken fixture.'); return { status: 'succeeded' }; }
      finally { finished = true; }
    },
    requestCredential: async () => { throw new Error('Unused fixture'); },
    integration: async () => ({}), manage: async () => ({}),
  });
  async function waitFor(predicate: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 400; attempt++) { if (await predicate()) return; await delay(10); }
    assert.fail('Speech fixture did not reach its expected state.');
  }
  try {
    await db.initializeDatabase();
    await tasks.initializeTasks({ workers: false });
    await personal.initializePersonal();
    const response = await app.inject({ method: 'POST', url: '/api/speech/speak', headers: { host: `localhost:${port}`, origin: `http://localhost:${port}` }, payload: { text: 'Manual route fixture.' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().mimeType, 'audio/mpeg');
    assert.equal(response.json().name, 'reply.mp3');
    await tasks.startTaskWorkers();
    const success = await tasks.submitTask('Generate audio fixture');
    await waitFor(async () => (await db.pool.query('SELECT status FROM tasks WHERE id=$1', [success])).rows[0].status === 'succeeded');
    const messages = await db.pool.query("SELECT text,attachments FROM messages WHERE task_id=$1 AND role='assistant'", [success]);
    assert.equal(messages.rowCount, 1);
    assert.equal(messages.rows[0].text, 'Audio generated by AI.');
    assert.equal(messages.rows[0].attachments[0].mimeType, 'audio/mpeg');
    assert.equal((await db.pool.query('SELECT owner_id FROM artifacts WHERE task_id=$1', [success])).rows[0].owner_id, ownerId);
    assert.equal(requests, 2);

    for (const mode of ['cancelled', 'stale']) {
      waiting = false; finished = false;
      gate = new Promise<void>(resolve => { release = resolve; });
      const id = await tasks.submitTask(`Audio ${mode} fixture`);
      await waitFor(async () => waiting);
      if (mode === 'cancelled') await tasks.cancelTask(id);
      else await db.pool.query("UPDATE tasks SET revision=revision+1,status='waiting_user' WHERE id=$1", [id]);
      release();
      await waitFor(async () => finished);
      gate = undefined;
      assert.equal((await db.pool.query('SELECT id FROM artifacts WHERE task_id=$1', [id])).rowCount, 0);
      assert.equal((await db.pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='assistant'", [id])).rowCount, 0);
      const before: number = requests;
      await assert.rejects(captured!.createAudio!('Must not contact the provider.'));
      assert.equal(requests, before);
    }
  } finally {
    release();
    await tasks.stopTasks();
    await app.close();
    const files = (await db.pool.query('SELECT storage_path FROM artifacts')).rows.map(row => String(row.storage_path));
    const ids = (await db.pool.query('SELECT id FROM tasks')).rows.map(row => String(row.id));
    await db.pool.end();
    for (const path of files) await rm(path, { force: true });
    for (const id of ids) await rm(join(dataRoot, 'workspaces', id), { recursive: true, force: true });
    await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
