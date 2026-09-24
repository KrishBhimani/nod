import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { Agent } from '../src/ports/agent.ts';
import type { IntegrationProvider, IntegrationSession } from '../src/ports/integrations.ts';
import { fakeComputer } from './runtime-fixtures.ts';

test(
  'replacement adapters preserve artifacts, streaming, write approvals and memory provenance through the full application',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 45_000 },
  async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_adapters_${suffix}`;
    const bossSchema = `test_adapters_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = databaseUrl.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    process.env.DEV_INSPECTOR = 'true';
    const { createApplication } = await import('../src/server/composition.ts');
    const { pool } = await import('../src/server/db.ts');
    const { dataRoot, ownerId, port } = await import('../src/server/config.ts');
    const { events } = await import('../src/server/events.ts');
    const integrationCalls: Array<{ action: string; args: Record<string, unknown> }> = [];
    const spoken: string[] = [];
    const browserTasks: string[] = [];
    const phases = new Map<string, number>();
    const taskIds: string[] = [];
    const streams: Array<{ taskId: string; streamId?: string; done?: boolean; text: string }> = [];
    const screen = Buffer.from('fixture-screen');
    let callback = '';
    let disposed = false;
    const session: IntegrationSession = {
      id: 'replacement-session',
      authorize: async (_service, url) => {
        callback = url;
        return { accountId: 'replacement-account', url: 'https://fixture.example/connect' };
      },
      search: async () => ({
        tools: { GMAIL_FETCH_EMAILS: {}, GMAIL_SEND_EMAIL: {} },
        suggestions: [],
      }),
      execute: async (action, args) => {
        integrationCalls.push({ action, args });
        return { successful: true, data: { messages: [] } };
      },
    };
    const integrations: IntegrationProvider = {
      id: 'replacement',
      configured: true,
      webhooksConfigured: false,
      supportsSubscriptions: [],
      createSession: async () => session,
      restoreSession: async () => session,
      deleteSession: async () => {},
      inspectAccount: async () => ({ active: true, service: 'gmail' }),
      deleteAccount: async () => {},
      parseCallback: (raw) => {
        const query = raw as Record<string, string>;
        return {
          state: query.state,
          accountId: query.account_ref,
          success: query.outcome === 'ok',
        };
      },
      subscribe: async () => {
        throw new Error('No subscriptions in this fixture.');
      },
      unsubscribe: async () => {},
      verifyWebhook: async () => {
        throw new Error('No webhooks in this fixture.');
      },
      matchesSubscription: () => false,
    };
    const agent: Agent = {
      open: async (input) => {
        const phase = phases.get(input.taskId) ?? 0;
        phases.set(input.taskId, phase + 1);
        return {
          resumed: phase > 0,
          abort: () => {},
          dispose: () => {},
          prompt: async (text) => {
            const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
            const call = (name: string, args: Record<string, unknown>) =>
              tools.get(name)!.execute(args);
            if (phase > 0) {
              assert.match(text, /Do not repeat/);
              input.onEvent({ type: 'message_start' });
              input.onEvent({ type: 'final', text: 'Approved action completed.' });
              input.onEvent({ type: 'message_end' });
              return;
            }
            if (text.endsWith('Fixture memory task: Remember that I prefer concise replies.')) {
              await call('remember', { text: 'I prefer concise replies.' });
              assert.equal(input.shouldStop(), true);
              return;
            }
            if (text.endsWith('Fixture unrelated message')) {
              input.onEvent({ type: 'message_start' });
              input.onEvent({ type: 'final', text: 'Unrelated request completed.' });
              input.onEvent({ type: 'message_end' });
              return;
            }
            if (text.endsWith('Fixture write task')) {
              await call('google', {
                action: 'GMAIL_SEND_EMAIL',
                args: { recipient_email: 'fixture@example.test', subject: 'Approved fixture' },
              });
              assert.equal(input.shouldStop(), true);
              return;
            }
            await call('browser', { action: 'open', url: 'https://example.com' });
            await call('browser_screenshot', {});
            const command = await call('shell', { command: 'fixture calculation' });
            assert.equal(command.content[0].type === 'text' && command.content[0].text, '42');
            await call('write_file', {
              path: 'result.txt',
              content: 'Replacement workspace output.',
            });
            await call('publish_artifact', { path: 'result.txt' });
            await call('google', { action: 'GMAIL_FETCH_EMAILS', args: { max_results: 1 } });
            await call('create_audio', { text: 'Replacement speech output.' });
            input.onEvent({ type: 'message_start' });
            input.onEvent({ type: 'text_delta', text: 'Replacement providers ' });
            input.onEvent({ type: 'text_delta', text: 'completed the request.' });
            input.onEvent({ type: 'final', text: 'Replacement providers completed the request.' });
            input.onEvent({ type: 'message_end' });
          },
        };
      },
      dispose: () => {
        disposed = true;
      },
    };
    const application = await createApplication(
      {
        agent,
        integrations,
        computer: fakeComputer({
          act: async (id) => {
            browserTasks.push(id);
            return { text: 'Replacement page body', url: 'https://example.com', candidates: [] };
          },
          screenshot: async (id) => (browserTasks.includes(id) ? screen : null),
        }),
        workspace: {
          status: () => 'replacement workspace',
          dispose: () => {},
          open: (input) => ({
            path: `/replacement/${input.taskId}`,
            instructions: 'Synthetic replacement workspace.',
            execute: async () => '42',
            readFile: (path) => readFile(join(input.workspacePath, path), 'utf8'),
            writeFile: async (path, text) => {
              await writeFile(join(input.workspacePath, path), text);
              return 'Saved.';
            },
            resolveArtifact: async (path) => join(input.workspacePath, path),
          }),
        },
        speech: {
          id: 'replacement',
          configured: true,
          transcribe: async () => 'Replacement transcription.',
          synthesize: async (text) => {
            spoken.push(text);
            return {
              bytes: Buffer.from('fixture-audio'),
              mimeType: 'audio/mpeg',
              fileName: 'reply.mp3',
            };
          },
        },
        keyStore: { id: 'replacement', configured: true, getKey: async () => Buffer.alloc(32, 7) },
        relevance: { id: 'replacement', configured: true, classify: async () => 'ignore' },
        model: { provider: 'replacement', name: 'Synthetic fixture agent', configured: true },
      },
      { channels: false },
    );
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    const request = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
      application.app.inject({ method, url, headers, payload });
    const onEvent = (
      event: { type: 'refresh' } | ({ type: 'delta' } & (typeof streams)[number]),
    ) => {
      if (event.type === 'delta') streams.push(event);
    };
    const waitFor = async (id: string, status: string) => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const row = (await pool.query('SELECT status,error FROM tasks WHERE id=$1', [id])).rows[0];
        if (row?.status === status) return;
        assert.notEqual(row?.status, 'failed', row?.error);
        await delay(20);
      }
      assert.fail(`Task did not reach ${status}.`);
    };
    events.on('event', onEvent);
    try {
      assert.equal((await request('POST', '/api/connections/gmail/connect')).statusCode, 200);
      const connected = new URL(callback);
      connected.searchParams.set('account_ref', 'replacement-account');
      connected.searchParams.set('outcome', 'ok');
      assert.equal((await request('GET', connected.pathname + connected.search)).statusCode, 302);
      const submitted = await request('POST', '/api/messages', { text: 'Fixture read task' });
      assert.equal(submitted.statusCode, 200);
      const id = submitted.json().taskId as string;
      taskIds.push(id);
      await waitFor(id, 'succeeded');
      assert.deepEqual(integrationCalls, [
        { action: 'GMAIL_FETCH_EMAILS', args: { max_results: 1 } },
      ]);
      assert.deepEqual(spoken, ['Replacement speech output.']);
      assert.deepEqual(browserTasks, [id]);
      const screenResponse = await request('GET', `/api/inspector/screen?taskId=${id}`);
      assert.equal(screenResponse.statusCode, 200);
      assert.deepEqual(screenResponse.rawPayload, screen);
      const state = (await request('GET', '/api/state')).json();
      assert.equal(state.configuration.provider, 'replacement');
      const final = state.messages.find(
        (message: { text: string }) =>
          message.text === 'Replacement providers completed the request.',
      );
      assert.ok(final.streamId);
      assert.equal(streams.filter((event) => !event.done).length, 2);
      assert.ok(streams.every((event) => event.streamId === final.streamId));
      assert.equal(streams.at(-1)?.done, true);
      const artifacts = (
        await pool.query(
          'SELECT id,name FROM artifacts WHERE owner_id=$1 AND task_id=$2 ORDER BY name',
          [ownerId, id],
        )
      ).rows;
      assert.deepEqual(
        artifacts.map((row) => row.name),
        ['reply.mp3', 'result.txt'],
      );
      const artifact = artifacts.find((row) => row.name === 'result.txt');
      assert.equal(
        (await request('GET', `/api/artifacts/${artifact.id}`)).body,
        'Replacement workspace output.',
      );
      const next = await request('POST', '/api/messages', { text: 'Fixture write task' });
      assert.equal(next.statusCode, 200);
      const nextId = next.json().taskId as string;
      taskIds.push(nextId);
      await waitFor(nextId, 'waiting_user');
      assert.equal(integrationCalls.length, 1);
      const approval = (await pool.query('SELECT id FROM approvals WHERE task_id=$1', [nextId]))
        .rows[0];
      assert.equal(
        (await request('POST', `/api/approvals/${approval.id}`, { approved: true })).statusCode,
        200,
      );
      await waitFor(nextId, 'succeeded');
      assert.deepEqual(integrationCalls.at(-1), {
        action: 'GMAIL_SEND_EMAIL',
        args: { recipient_email: 'fixture@example.test', subject: 'Approved fixture' },
      });
      assert.equal(integrationCalls.length, 2);
      assert.equal(
        (await request('POST', `/api/approvals/${approval.id}`, { approved: true })).statusCode,
        409,
      );
      assert.equal(phases.get(nextId), 2);
      const memoryRequest = await request('POST', '/api/messages', {
        text: 'Fixture memory task: Remember that I prefer concise replies.',
      });
      assert.equal(memoryRequest.statusCode, 200);
      const memoryTaskId = memoryRequest.json().taskId as string;
      taskIds.push(memoryTaskId);
      await waitFor(memoryTaskId, 'waiting_user');
      const source = (
        await pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='user'", [memoryTaskId])
      ).rows[0];
      const memoryApproval = (
        await pool.query(
          'SELECT id,action,args,source_message_id FROM approvals WHERE task_id=$1',
          [memoryTaskId],
        )
      ).rows[0];
      assert.equal(memoryApproval.action, 'SIDEKICK_memory_propose');
      assert.deepEqual(memoryApproval.args, { text: 'I prefer concise replies.' });
      assert.equal(memoryApproval.source_message_id, source.id);
      assert.equal((await pool.query('SELECT id FROM memory_facts')).rowCount, 0);
      const unrelated = await request('POST', '/api/messages', {
        text: 'Fixture unrelated message',
      });
      assert.equal(unrelated.statusCode, 200);
      const unrelatedTaskId = unrelated.json().taskId as string;
      taskIds.push(unrelatedTaskId);
      await waitFor(unrelatedTaskId, 'succeeded');
      const latestUser = (
        await pool.query(
          "SELECT id FROM messages WHERE role='user' ORDER BY created_at DESC LIMIT 1",
        )
      ).rows[0];
      assert.notEqual(latestUser.id, source.id);
      assert.equal(
        (await request('POST', `/api/approvals/${memoryApproval.id}`, { approved: true }))
          .statusCode,
        200,
      );
      await waitFor(memoryTaskId, 'succeeded');
      const memories = (await pool.query('SELECT text,source_message_id FROM memory_facts')).rows;
      assert.deepEqual(memories, [
        { text: 'I prefer concise replies.', source_message_id: source.id },
      ]);
      const savedMemory = (await request('GET', '/api/memory')).json();
      assert.equal(savedMemory[0].sourceMessageId, source.id);
      assert.equal(phases.get(memoryTaskId), 2);
    } finally {
      events.off('event', onEvent);
      await application.app.close();
      assert.equal(disposed, true);
      const files = (await pool.query('SELECT storage_path FROM artifacts')).rows;
      await Promise.all(files.map((file) => rm(String(file.storage_path), { force: true })));
      await Promise.all(
        taskIds.map((id) => rm(join(dataRoot, 'workspaces', id), { recursive: true, force: true })),
      );
      await pool.end();
      await admin.query(`DROP SCHEMA ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
