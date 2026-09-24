import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import pg from 'pg';
import { registerLocalAccess } from '../src/server/access.ts';

test('localhost access rejects foreign Host, Origin and browser cross-site requests', async () => {
  const app = Fastify();
  registerLocalAccess(app, 4310);
  app.get('/api/fixture', async () => ({ ok: true }));
  app.post('/api/fixture', async () => ({ ok: true }));
  app.get('/api/connections/callback', async () => ({ ok: true }));
  try {
    for (const headers of [
      { host: 'attacker.example:4310' }, { host: 'localhost:4311' },
      { host: 'localhost:4310', origin: 'https://attacker.example' },
      { host: 'localhost:4310', origin: 'null' },
      { host: 'localhost:4310', origin: 'https://localhost:4310' },
      { host: 'localhost:4310', 'sec-fetch-site': 'cross-site' },
    ]) assert.equal((await app.inject({ method: 'POST', url: '/api/fixture', headers })).statusCode, 403);
    for (const host of ['localhost:4310', '127.0.0.1:4310', '[::1]:4310']) {
      const response = await app.inject({ method: 'POST', url: '/api/fixture', headers: { host, origin: `http://${host}` } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
    }
    assert.equal((await app.inject({ url: '/api/connections/callback?fixture=yes', headers: { host: 'localhost:4310', 'sec-fetch-site': 'cross-site' } })).statusCode, 200);
  } finally { await app.close(); }
});

test('server artifacts, approvals and personal data preserve PostgreSQL ownership and review boundaries', { skip: !process.env.TEST_DATABASE_URL, timeout: 45_000 }, async t => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const schema = `test_server_${suffix}`;
  const bossSchema = `test_server_boss_${suffix}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = databaseUrl.href;
  process.env.PGBOSS_SCHEMA = bossSchema;
  const db = await import('../src/server/db.ts');
  const tasks = await import('../src/server/tasks.ts');
  const personal = await import('../src/server/personal.ts');
  const artifacts = await import('../src/server/artifacts.ts');
  const { createApp } = await import('../src/server/app.ts');
  const { createApprovals } = await import('../src/server/approvals.ts');
  const { dataRoot, ownerId, port } = await import('../src/server/config.ts');
  const app = await createApp();
  const calls: Array<{ action: string; args: Record<string, unknown> }> = [];
  let failExecution = false;
  let executionGate: Promise<void> | undefined;
  const directories: string[] = [];
  let approvals: Awaited<ReturnType<typeof createApprovals>>;
  const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
  const request = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { ...headers, 'content-type': 'application/json' } }) });
  const newTask = async (status = 'running', owner = ownerId) => {
    const id = randomUUID();
    await db.pool.query('INSERT INTO tasks(id,owner_id,title,prompt,status) VALUES($1,$2,$3,$3,$4)', [id, owner, 'Synthetic boundary fixture', status]);
    return id;
  };
  const approvalId = (url: string) => url.split('/').at(-1)!;
  try {
    await db.initializeDatabase();
    await tasks.initializeTasks({ workers: false });
    await personal.initializePersonal();
    approvals = await createApprovals(async (action, args) => {
      calls.push({ action, args });
      if (executionGate) await executionGate;
      if (failExecution) throw new Error('Fixture provider detail must not be exposed.');
      return { successful: true, id: 'fixture-provider-result' };
    });
    approvals.registerRoutes(app);
    personal.registerPersonalRoutes(app);
    app.get('/api/fixture-error', async () => { throw new Error('fixture-private-key'); });

    await t.test('artifacts are owned, path bounded, and active documents download with sandbox headers', async () => {
      const id = await newTask('succeeded');
      const workspace = join(dataRoot, 'workspaces', id);
      const privateDir = await mkdtemp(join(tmpdir(), 'sidekick-artifact-test-'));
      directories.push(workspace, privateDir);
      await mkdir(workspace, { recursive: true });
      await writeFile(join(privateDir, 'private.txt'), 'private fixture');
      await symlink(join(privateDir, 'private.txt'), join(workspace, 'escape.txt'));
      await assert.rejects(artifacts.publishArtifact(id, join(privateDir, 'private.txt')));
      await assert.rejects(artifacts.publishArtifact(id, 'escape.txt'));
      await writeFile(join(workspace, 'report.html'), '<script>window.fixture=true</script>');
      const published = await artifacts.publishArtifact(id, 'report.html', '../../report\r\n.html');
      assert.equal(published.name, 'report.html');
      const response = await request('GET', published.url);
      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers['content-disposition']), /^attachment;/);
      assert.equal(response.headers['content-type'], 'text/html');
      assert.equal(response.headers['content-security-policy'], "default-src 'none'; sandbox");
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.match(response.body, /window.fixture/);
      await db.pool.query('UPDATE artifacts SET owner_id=$2 WHERE id=$1', [published.id, 'another-owner']);
      assert.equal((await request('GET', published.url)).statusCode, 404);
      assert.equal((await request('GET', '/api/artifacts/not-a-uuid')).statusCode, 400);
      await assert.rejects(artifacts.storeArtifact(Buffer.alloc(0), 'empty', 'text/plain'));
      await assert.rejects(artifacts.storeArtifact(Buffer.alloc(artifacts.maxFileSize + 1), 'large', 'text/plain'));
      const error = await request('GET', '/api/fixture-error');
      assert.equal(error.statusCode, 500);
      assert.equal(error.body.includes('fixture-private-key'), false);
    });

    await t.test('approval executes the stored snapshot only once and resumes once', async () => {
      const taskId = await newTask();
      const original = { recipient: 'fixture@example.test', subject: 'Approved snapshot', nested: { text: 'original' } };
      const result = await approvals.request(taskId, 'GMAIL_SEND_EMAIL', original);
      const id = approvalId(result.url);
      original.nested.text = 'changed after request';
      assert.equal((await request('GET', `/api/approvals/${id}`)).json().args.nested.text, 'original');
      assert.equal((await request('POST', `/api/approvals/${id}`, { approved: true, args: { recipient: 'attacker@example.test' } })).statusCode, 400);
      const before = calls.length;
      const responses = await Promise.all(Array.from({ length: 4 }, () => request('POST', `/api/approvals/${id}`, { approved: true })));
      assert.equal(responses.filter(response => response.statusCode === 200).length, 1);
      assert.equal(responses.filter(response => response.statusCode === 409).length, 3);
      assert.equal(calls.length, before + 1);
      assert.deepEqual(calls.at(-1), { action: 'GMAIL_SEND_EMAIL', args: { recipient: 'fixture@example.test', subject: 'Approved snapshot', nested: { text: 'original' } } });
      const task = (await db.pool.query('SELECT status,revision,prompt FROM tasks WHERE id=$1', [taskId])).rows[0];
      assert.equal(task.status, 'queued');
      assert.equal(task.revision, 1);
      assert.match(task.prompt, /Do not repeat it/);
      assert.equal((await db.pool.query(`SELECT id FROM ${bossSchema}.job WHERE data->>'taskId'=$1`, [taskId])).rowCount, 1);
    });

    await t.test('cancelled, expired and other-owner approvals cannot execute', async () => {
      const before = calls.length;
      const cancelledTask = await newTask();
      const cancelled = approvalId((await approvals.request(cancelledTask, 'GMAIL_SEND_EMAIL', {})).url);
      await tasks.cancelTask(cancelledTask);
      assert.equal((await request('POST', `/api/approvals/${cancelled}`, { approved: true })).statusCode, 409);
      const expired = approvalId((await approvals.request(await newTask(), 'GMAIL_SEND_EMAIL', {})).url);
      await db.pool.query("UPDATE approvals SET expires_at=now()-interval '1 minute' WHERE id=$1", [expired]);
      assert.equal((await request('GET', `/api/approvals/${expired}`)).json().status, 'expired');
      assert.equal((await request('POST', `/api/approvals/${expired}`, { approved: true })).statusCode, 409);
      const foreign = approvalId((await approvals.request(await newTask(), 'GMAIL_SEND_EMAIL', {})).url);
      await db.pool.query('UPDATE approvals SET owner_id=$2 WHERE id=$1', [foreign, 'another-owner']);
      assert.equal((await request('GET', `/api/approvals/${foreign}`)).statusCode, 404);
      assert.equal((await request('POST', `/api/approvals/${foreign}`, { approved: true })).statusCode, 409);
      assert.equal(calls.length, before);
    });

    await t.test('approval from an old task revision cannot execute in a later waiting segment', async () => {
      const taskId = await newTask();
      const id = approvalId((await approvals.request(taskId, 'GMAIL_SEND_EMAIL', { subject: 'obsolete' })).url);
      await db.pool.query("UPDATE tasks SET revision=revision+1,status='waiting_user' WHERE id=$1", [taskId]);
      const before = calls.length;
      assert.equal((await request('POST', `/api/approvals/${id}`, { approved: true })).statusCode, 409);
      assert.equal(calls.length, before);
    });

    await t.test('declining resumes without executing and ambiguous failures cannot retry', async () => {
      const taskId = await newTask();
      const id = approvalId((await approvals.request(taskId, 'GMAIL_SEND_EMAIL', {})).url);
      const before = calls.length;
      assert.equal((await request('POST', `/api/approvals/${id}`, { approved: false })).statusCode, 200);
      assert.equal(calls.length, before);
      const task = (await db.pool.query('SELECT status,prompt FROM tasks WHERE id=$1', [taskId])).rows[0];
      assert.equal(task.status, 'queued');
      assert.match(task.prompt, /user declined/);
      assert.equal((await request('POST', `/api/approvals/${id}`, { approved: true })).statusCode, 409);
      const failed = approvalId((await approvals.request(await newTask(), 'GMAIL_SEND_EMAIL', {})).url);
      failExecution = true;
      const response = await request('POST', `/api/approvals/${failed}`, { approved: true });
      failExecution = false;
      assert.equal(response.statusCode, 502);
      assert.equal(response.body.includes('Fixture provider detail'), false);
      assert.equal((await request('GET', `/api/approvals/${failed}`)).json().status, 'uncertain');
      assert.equal((await request('POST', `/api/approvals/${failed}`, { approved: true })).statusCode, 409);
      assert.equal(calls.length, before + 1);
    });

    await t.test('a failed decline enqueue rolls back the decision and can be retried', async () => {
      const taskId = await newTask();
      const id = approvalId((await approvals.request(taskId, 'GMAIL_SEND_EMAIL', {})).url);
      const send = t.mock.method(tasks.boss, 'send', async () => { throw new Error('Injected queue failure'); });
      try { assert.equal((await request('POST', `/api/approvals/${id}`, { approved: false })).statusCode, 500); }
      finally { send.mock.restore(); }
      assert.equal((await request('GET', `/api/approvals/${id}`)).json().status, 'pending');
      assert.equal((await db.pool.query('SELECT id FROM messages WHERE task_id=$1', [taskId])).rowCount, 0);
      assert.equal((await request('POST', `/api/approvals/${id}`, { approved: false })).statusCode, 200);
      assert.equal((await db.pool.query(`SELECT id FROM ${bossSchema}.job WHERE data->>'taskId'=$1`, [taskId])).rowCount, 1);
    });

    await t.test('cancellation during approved execution records its outcome without waking the cancelled task', async () => {
      const taskId = await newTask();
      const id = approvalId((await approvals.request(taskId, 'GMAIL_SEND_EMAIL', {})).url);
      let release = () => {};
      executionGate = new Promise<void>(resolve => { release = resolve; });
      const response = request('POST', `/api/approvals/${id}`, { approved: true }).then(value => value);
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((await db.pool.query('SELECT status FROM approvals WHERE id=$1', [id])).rows[0].status === 'executing') break;
          await delay(5);
        }
        assert.equal((await db.pool.query('SELECT status FROM approvals WHERE id=$1', [id])).rows[0].status, 'executing');
        await tasks.cancelTask(taskId);
        release();
        assert.equal((await response).statusCode, 200);
        assert.equal((await db.pool.query('SELECT status FROM approvals WHERE id=$1', [id])).rows[0].status, 'completed');
        assert.equal((await db.pool.query('SELECT status FROM tasks WHERE id=$1', [taskId])).rows[0].status, 'cancelled');
        assert.equal((await db.pool.query(`SELECT id FROM ${bossSchema}.job WHERE data->>'taskId'=$1`, [taskId])).rowCount, 0);
      } finally { release(); executionGate = undefined; await response; }
      const interrupted = approvalId((await approvals.request(await newTask(), 'GMAIL_SEND_EMAIL', {})).url);
      await db.pool.query("UPDATE approvals SET status='executing' WHERE id=$1", [interrupted]);
      await createApprovals(async () => { throw new Error('Must not automatically retry'); });
      assert.equal((await request('GET', `/api/approvals/${interrupted}`)).json().status, 'uncertain');
      assert.equal((await request('POST', `/api/approvals/${interrupted}`, { approved: true })).statusCode, 409);
    });

    await t.test('profile, memory, history and goals retain explicit data and ownership', async () => {
      const profile = { name: 'Fixture User', location: 'Lisbon', phone: '+351000000000', preferences: 'Concise answers' };
      assert.equal((await request('PUT', '/api/profile', profile)).statusCode, 200);
      assert.deepEqual((await request('GET', '/api/profile')).json(), profile);
      assert.equal((await request('PUT', '/api/profile', { ...profile, inferredHealth: 'not accepted' })).statusCode, 400);
      await personal.managePersonal('memory_propose', { text: 'Fixture explicitly prefers concise answers' });
      await personal.managePersonal('memory_propose', { text: 'Fixture explicitly prefers concise answers' });
      const memory = await request('GET', '/api/memory');
      assert.equal(memory.json().length, 1);
      const foreign = randomUUID();
      await db.pool.query('INSERT INTO memory_facts(id,owner_id,text) VALUES($1,$2,$3)', [foreign, 'another-owner', 'Foreign private fixture']);
      await request('DELETE', `/api/memory/${foreign}`);
      assert.equal((await db.pool.query('SELECT id FROM memory_facts WHERE id=$1', [foreign])).rowCount, 1);
      const goal = await request('POST', '/api/goals', { title: 'Fixture milestone', description: 'An explicit objective' });
      assert.equal(goal.statusCode, 200);
      const id = goal.json().id;
      assert.equal((await request('PATCH', `/api/goals/${id}`, { progress: 101 })).statusCode, 400);
      assert.equal((await request('PATCH', `/api/goals/${id}`, { progress: 50, nextAction: 'Review result', status: 'active' })).statusCode, 200);
      assert.equal((await request('GET', '/api/goals')).json()[0].progress, 50);
      await db.pool.query('UPDATE goals SET owner_id=$2 WHERE id=$1', [id, 'another-owner']);
      assert.equal((await request('PATCH', `/api/goals/${id}`, { progress: 100 })).statusCode, 404);
      const foreignTask = await newTask('succeeded', 'another-owner');
      await db.pool.query('INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,$2,$3,$4,$5)', [randomUUID(), 'another-owner', 'user', 'BoundarySecretKeyword', foreignTask]);
      assert.deepEqual(await personal.managePersonal('history_search', { query: 'BoundarySecretKeyword' }), { tasks: [], messages: [] });
    });

    await t.test('schedules persist their timezone and cancellation removes the recurring job', async () => {
      const result = await request('POST', '/api/schedules', { title: 'Future fixture', prompt: 'No external activity', cron: '0 9 1 1 *', timeZone: 'Europe/Lisbon' });
      assert.equal(result.statusCode, 200);
      const schedule = result.json();
      assert.equal((await request('GET', '/api/schedules')).json()[0].timeZone, 'Europe/Lisbon');
      assert.equal((await db.pool.query(`SELECT key FROM ${bossSchema}.schedule WHERE key=$1`, [schedule.id])).rowCount, 1);
      assert.equal((await request('DELETE', `/api/schedules/${schedule.id}`)).statusCode, 200);
      assert.equal((await request('GET', '/api/schedules')).json()[0].enabled, false);
      assert.equal((await db.pool.query(`SELECT key FROM ${bossSchema}.schedule WHERE key=$1`, [schedule.id])).rowCount, 0);
      assert.equal((await request('POST', '/api/schedules', { title: 'Invalid', prompt: 'Fixture', cron: '* * * * * *', timeZone: 'Europe/Lisbon' })).statusCode, 400);
      const foreign = (await request('POST', '/api/schedules', { title: 'Foreign fixture', prompt: 'No external activity', cron: '0 9 1 1 *', timeZone: 'Europe/Lisbon' })).json();
      await db.pool.query('UPDATE schedules SET owner_id=$2 WHERE id=$1', [foreign.id, 'another-owner']);
      assert.equal((await request('DELETE', `/api/schedules/${foreign.id}`)).statusCode, 404);
      assert.equal((await db.pool.query(`SELECT key FROM ${bossSchema}.schedule WHERE key=$1`, [foreign.id])).rowCount, 1);

    });
  } finally {
    await app.close();
    await tasks.stopTasks();
    const files = (await db.pool.query('SELECT storage_path FROM artifacts')).rows.map(row => String(row.storage_path));
    await db.pool.end();
    for (const path of files) await rm(path, { force: true });
    for (const path of directories) await rm(path, { recursive: true, force: true });
    await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
