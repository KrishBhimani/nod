import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import type { Agent, RuntimeContext, RuntimeObservation } from '../src/ports/agent.ts';
import { BrowserActionError } from '../src/ports/computer.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { browserErrorMessage } from '../src/shared/browser-errors.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

const diagnostic = browserErrorMessage('browser_navigation_failed')!;
const privateError = 'Private browser output https://private.example/session?token=fixture-secret';

async function runtimeFailure(error: Error, name: string, cancelled = false) {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-browser-errors-'));
  const observations: RuntimeObservation[] = [];
  const controller = new AbortController();
  let received: unknown;
  const fail = async () => {
    if (cancelled) controller.abort();
    throw error;
  };
  const agent: Agent = {
    open: async (options) => ({
      resumed: false,
      prompt: async () => {
        try {
          await options.tools
            .find((tool) => tool.name === name)!
            .execute(name === 'browser' ? { action: 'open', url: 'https://example.com' } : {});
        } catch (failure) {
          received = failure;
        }
      },
      abort() {},
      dispose() {},
    }),
    dispose() {},
  };
  const runtime = createAgentRuntime({
    agent,
    computer: fakeComputer({ act: fail, screenshot: fail, inspectLogin: fail }),
    workspace: fakeWorkspace(),
  });
  const context: RuntimeContext = {
    taskId: randomUUID(),
    ownerId: 'fixture-owner',
    prompt: 'Read the example page.',
    workspacePath: directory,
    signal: controller.signal,
    history: [],
    memories: [],
    attachments: [],
    emit: async () => {},
    reply: async () => {},
    delta() {},
    observe: async (event) => {
      observations.push(event);
    },
    remember: async () => {},
    publish: async () => {
      throw new Error('Not used');
    },
    publishScreenshot: async () => {
      throw new Error('No screenshot may be published after capture fails.');
    },
    requestCredential: async () => ({ url: '/vault/fixture' }),
    integration: async () => ({}),
    manage: async () => ({}),
  };
  try {
    if (cancelled) await assert.rejects(runtime.runTask(context), { name: 'AbortError' });
    else await runtime.runTask(context);
    return { received, observations };
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const name of ['browser', 'browser_screenshot', 'send_screenshot', 'inspect_login'])
  test(`${name} exposes only the fixed navigation category to the model and private observation`, async () => {
    const error = new BrowserActionError('browser_navigation_failed');
    error.message = privateError;
    const result = await runtimeFailure(error, name);
    assert.ok(result.received instanceof Error);
    assert.equal(result.received.message, diagnostic);
    const end = result.observations.find((event) => event.type === 'tool_end');
    assert.equal(end?.status, 'failed');
    assert.equal(end?.error, diagnostic);
    assert.doesNotMatch(JSON.stringify(result.observations), /private\.example|fixture-secret/);
  });

test('unknown and forged browser errors remain masked', async () => {
  const result = await runtimeFailure(
    Object.assign(new Error(privateError), { code: 'browser_navigation_failed' }),
    'browser',
  );
  assert.ok(result.received instanceof Error);
  assert.match(result.received.message, /The action could not be completed/);
  assert.doesNotMatch(JSON.stringify(result.observations), /private\.example|fixture-secret/);
  assert.equal(browserErrorMessage('__proto__'), undefined);
  assert.equal(browserErrorMessage('constructor'), undefined);
});

test('cancellation takes precedence over a typed browser failure', async () => {
  const result = await runtimeFailure(
    new BrowserActionError('browser_navigation_failed'),
    'browser',
    true,
  );
  assert.ok(result.received instanceof Error);
  assert.equal(result.received.message, 'The action was cancelled.');
  const end = result.observations.find((event) => event.type === 'tool_end');
  assert.equal(end?.status, 'cancelled');
  assert.equal(end?.error, 'The action was cancelled.');
});

test(
  'screen HTTP errors preserve ownership and expose only a recognized fixed browser category',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 20_000 },
  async () => {
    const schema = `test_browser_errors_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const { pool, initializeDatabase } = await import('../src/server/db.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { configuration, ownerId, port } = await import('../src/server/config.ts');
    const taskId = randomUUID();
    const foreignId = randomUUID();
    let enabled = true;
    let captures = 0;
    let failure: Error = new BrowserActionError('browser_navigation_failed');
    failure.message = privateError;
    const app = await createApp({
      configuration: () => configuration({ inspectorEnabled: enabled }),
      computer: fakeComputer({
        screenshot: async () => {
          captures++;
          throw failure;
        },
      }),
    });
    const request = (id = taskId) =>
      app.inject({
        url: `/api/inspector/screen?taskId=${id}`,
        headers: { host: `localhost:${port}` },
      });
    try {
      await initializeDatabase();
      await pool.query(
        "INSERT INTO tasks(id,owner_id,title,prompt,status) VALUES($1,$2,'fixture','fixture','running'),($3,'foreign','fixture','fixture','running')",
        [taskId, ownerId, foreignId],
      );
      const result = await request();
      assert.equal(result.statusCode, 409);
      assert.deepEqual(result.json(), { code: 'browser_navigation_failed', error: diagnostic });
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal((await request(foreignId)).statusCode, 404);
      assert.equal(captures, 1);
      enabled = false;
      assert.equal((await request()).statusCode, 404);
      assert.equal(captures, 1);
      enabled = true;
      failure = Object.assign(new Error(privateError), { code: 'browser_navigation_failed' });
      const unknown = await request();
      assert.equal(unknown.statusCode, 500);
      assert.doesNotMatch(
        unknown.body,
        /private\.example|fixture-secret|browser_navigation_failed/,
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
