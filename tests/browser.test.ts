import assert from 'node:assert/strict';
import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import pg from 'pg';
import type {
  Agent,
  AgentToolResult,
  RuntimeContext,
  RuntimeObservation,
} from '../src/ports/agent.ts';
import { BrowserActionError, type BrowserAction, type Computer } from '../src/ports/computer.ts';
import { createSignInDesktop } from '../src/providers/agent-browser/desktop.ts';
import {
  browserSessionId,
  createAgentBrowserComputer,
  redactBrowserText,
  redactBrowserUrl,
} from '../src/providers/agent-browser/index.ts';
import {
  credentialSubmitScript,
  loginInspectionSchema,
  loginInspectionScript,
} from '../src/providers/agent-browser/login.ts';
import { credentialFields, credentialScript } from '../src/providers/agent-browser/credentials.ts';
import { maskPageScript, protectFocusedField } from '../src/providers/agent-browser/manual.ts';
import { existingDaemonCommand } from '../src/providers/agent-browser/screens.ts';
import { runBrowserBridge } from '../src/providers/container-browser/bridge.ts';
import {
  browserNamespace,
  createContainerBrowserComputer,
  type BrowserBridgeLauncher,
} from '../src/providers/container-browser/index.ts';
import {
  browserResponse,
  type BrowserCall,
  type BrowserResponse,
} from '../src/providers/container-browser/protocol.ts';
import { startContainerBrowserWorker } from '../src/providers/container-browser/worker.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { createInspectorRedactor } from '../src/server/inspector-redaction.ts';
import type { CredentialInjection } from '../src/server/vault.ts';
import { createBrowserFixture } from './browser-fixture.ts';
import { LoginDom, LoginElement, stagedLoginBrowser } from './login-fixture.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

// Shared helpers

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Core browser API: ownership and private-capture locks

test(
  'core browser metadata and frames work without Inspector and retain ownership and private-capture locks',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15_000 },
  async () => {
    const schema = `test_browser_api_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const db = await import('../src/server/db.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { activeThread } = await import('../src/server/thread.ts');
    const { ownerId, port, configuration } = await import('../src/server/config.ts');
    const capturedAt = '2026-09-25T12:00:00.000Z';
    let currentId: string | undefined;
    let locked = false;
    let fail = false;
    let inspectorEnabled = false;
    let onCapture: (() => Promise<void>) | undefined;
    const captures: string[] = [];
    const app = await createApp({
      configuration: () => configuration({ inspectorEnabled }),
      computer: {
        status: () => 'Ready',
        currentSession: () =>
          currentId ? { threadId: currentId, lastActivityAt: capturedAt } : undefined,
        screenStatus: () => ({ state: 'live', capturedAt }),
        screenshot: async (id) => {
          captures.push(id!);
          if (locked)
            throw Object.assign(new Error('Screen hidden during sign-in.'), { statusCode: 423 });
          if (fail) throw new Error('synthetic-private-provider-detail');
          await onCapture?.();
          return Buffer.from('synthetic-public-browser-frame');
        },
      },
    });
    const request = (path: string) =>
      app.inject({ url: path, headers: { host: `localhost:${port}` } });
    const insertTurn = async (threadId: string, owner: string, prompt: string) => {
      const id = randomUUID();
      await db.pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status) VALUES($1,$2,$3,'event',$4,'running')",
        [id, owner, threadId, prompt],
      );
      return id;
    };
    try {
      await db.initializeDatabase();
      const thread = await activeThread(db.pool);
      const foreignThread = await activeThread(db.pool, 'other');
      const turnId = await insertTurn(thread.id, ownerId, 'Synthetic browser');
      const foreignTurnId = await insertTurn(foreignThread.id, 'other', 'Foreign browser');
      currentId = thread.id;
      const metadata = await request('/api/browser');
      assert.equal(metadata.statusCode, 200);
      assert.equal(metadata.headers['cache-control'], 'no-store');
      assert.deepEqual(metadata.json(), {
        currentBrowser: {
          threadId: thread.id,
          title: 'Synthetic browser',
          status: 'running',
          lastActivityAt: capturedAt,
        },
      });
      for (const path of ['/api/inspector', '/api/inspector/screen'])
        assert.equal((await request(path)).statusCode, 404);
      const frame = await request('/api/browser/screen');
      assert.equal(frame.statusCode, 200);
      assert.match(String(frame.headers['content-type']), /^image\/png/);
      assert.equal(frame.headers['cache-control'], 'no-store');
      assert.equal(frame.headers['referrer-policy'], 'no-referrer');
      assert.equal(frame.headers['x-screen-state'], 'live');
      assert.equal(frame.body, 'synthetic-public-browser-frame');
      assert.deepEqual(captures, [thread.id]);
      inspectorEnabled = true;
      await db.pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1",
        [turnId],
      );
      for (const path of ['/api/browser/screen', '/api/inspector/screen']) {
        const pending = await request(path);
        assert.equal(pending.statusCode, 423);
        assert.equal(pending.headers['cache-control'], 'no-store');
        assert.equal(pending.body.includes('synthetic-public-browser-frame'), false);
      }
      assert.deepEqual(captures, [thread.id]);
      await db.pool.query("UPDATE turns SET status='running',waiting_reason=NULL WHERE id=$1", [
        turnId,
      ]);
      onCapture = async () => {
        await db.pool.query(
          "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1",
          [turnId],
        );
      };
      const becamePrivate = await request('/api/browser/screen');
      assert.equal(becamePrivate.statusCode, 423);
      assert.equal(becamePrivate.body.includes('synthetic-public-browser-frame'), false);
      assert.deepEqual(captures, [thread.id, thread.id]);
      await db.pool.query("UPDATE turns SET status='running',waiting_reason=NULL WHERE id=$1", [
        turnId,
      ]);
      onCapture = async () => {
        await db.pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [thread.id]);
      };
      const obsolete = await request('/api/browser/screen');
      assert.equal(obsolete.statusCode, 409);
      assert.equal(obsolete.body.includes('synthetic-public-browser-frame'), false);
      onCapture = undefined;
      const next = await activeThread(db.pool);
      assert.notEqual(next.id, thread.id);
      const resumed = await request('/api/browser/screen');
      assert.equal(resumed.statusCode, 200);
      assert.equal(resumed.body, 'synthetic-public-browser-frame');
      assert.equal(captures.at(-1), next.id);
      locked = true;
      const privateFrame = await request('/api/browser/screen');
      assert.equal(privateFrame.statusCode, 423);
      assert.equal(privateFrame.headers['cache-control'], 'no-store');
      assert.equal(privateFrame.body.includes('synthetic-public-browser-frame'), false);
      locked = false;
      fail = true;
      const failed = await request('/api/browser/screen');
      assert.equal(failed.statusCode, 500);
      assert.equal(failed.body.includes('synthetic-private-provider-detail'), false);
      const nextTurnId = await insertTurn(next.id, ownerId, 'Next browser');
      currentId = undefined;
      assert.deepEqual((await request('/api/browser')).json(), { currentBrowser: null });
      await db.pool.query(
        "INSERT INTO turn_events(id,turn_id,type,summary) VALUES($1,$2,'tool_complete','browser')",
        [randomUUID(), turnId],
      );
      await db.pool.query(
        "INSERT INTO turn_events(id,turn_id,type,summary) VALUES($1,$2,'tool_complete','browser')",
        [randomUUID(), foreignTurnId],
      );
      assert.deepEqual((await request('/api/browser')).json(), { currentBrowser: null });
      await db.pool.query(
        "INSERT INTO turn_events(id,turn_id,type,summary) VALUES($1,$2,'tool_complete','browser')",
        [randomUUID(), nextTurnId],
      );
      const fallback = (await request('/api/browser')).json();
      assert.equal(fallback.currentBrowser.threadId, next.id);
      assert.equal(fallback.currentBrowser.title, 'Next browser');
      assert.deepEqual(Object.keys(fallback), ['currentBrowser']);
      currentId = thread.id;
      assert.deepEqual((await request('/api/browser')).json(), { currentBrowser: null });
    } finally {
      await app.close();
      await db.pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

// Checkpoint quiescence

function syntheticComputer(): Computer & { canCheckpoint?: () => boolean } {
  return {
    act: async () => ({ text: 'Synthetic page', url: 'https://example.test/', candidates: [] }),
    screenshot: async () => null,
    injectCredentials: async () => ({ status: 'submitted' }),
    inspectLogin: async () => ({
      origin: 'https://example.test',
      url: 'https://example.test/',
      fields: [],
      methods: [],
    }),
    selectLoginMethod: async () => {},
    hold: async () => {},
    close: async () => {},
    dispose: async () => {},
    status: () => 'Synthetic browser',
    canCheckpoint: () => true,
  };
}

async function workerFixture(createComputer: () => Computer | Promise<Computer>) {
  const directory = await mkdtemp('/tmp/sk-quiesce-');
  const socketPath = join(directory, 'control.sock');
  const worker = await startContainerBrowserWorker({
    socketPath,
    dataRoot: directory,
    createComputer,
  });
  const namespace = 'sk-' + 'a'.repeat(24);
  const request = (call: BrowserCall) =>
    new Promise<BrowserResponse>((resolve, reject) => {
      const socket = connect(socketPath);
      let output = '';
      socket.setEncoding('utf8');
      socket.setTimeout(5000, () => socket.destroy(new Error('Synthetic request timed out.')));
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(
          JSON.stringify({
            type: 'request',
            request: { ...call, id: randomUUID(), namespace },
          }) + '\n',
        );
      });
      socket.on('data', (chunk) => {
        output += chunk;
      });
      socket.once('end', () => {
        try {
          resolve(browserResponse.parse(JSON.parse(output)));
        } catch (error) {
          reject(error);
        }
      });
    });
  return {
    request,
    async close() {
      await worker.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function result(response: BrowserResponse) {
  assert.equal(response.ok, true);
  return response.ok ? response.result : undefined;
}

test('quiesce refuses a pending request without aborting or querying its browser', async () => {
  const entered = deferred();
  const release = deferred();
  const computer = syntheticComputer();
  let checks = 0;
  let disposals = 0;
  let aborted = false;
  computer.canCheckpoint = () => {
    checks++;
    return true;
  };
  computer.act = async (_id, _input, signal) => {
    signal?.addEventListener('abort', () => {
      aborted = true;
    });
    entered.resolve();
    await release.promise;
    return { text: 'Finished', url: 'https://example.test/', candidates: [] };
  };
  computer.dispose = async () => {
    disposals++;
  };
  const f = await workerFixture(() => computer);
  const active = f.request({ method: 'act', threadId: 'task', input: { action: 'snapshot' } });
  try {
    await entered.promise;
    assert.equal(result(await f.request({ method: 'quiesce' })), false);
    assert.equal(checks, 0);
    assert.equal(disposals, 0);
    assert.equal(aborted, false);
    release.resolve();
    result(await active);
    assert.equal(result(await f.request({ method: 'quiesce' })), true);
    assert.equal(disposals, 1);
  } finally {
    release.resolve();
    await active;
    await f.close();
  }
});

async function browserFixture() {
  const directory = await mkdtemp('/tmp/sk-checkpoint-browser-');
  const browser = stagedLoginBrowser();
  const commands: string[][] = [];
  let before = async (_command: string[]) => {};
  let starting = async () => {};
  let nativeClosed = true;
  const computer = createBrowserFixture({
    dataRoot: directory,
    manualTimeoutMs: 60_000,
    run: async (executable, args, options) => {
      const command = args.slice(args.indexOf('--idle-timeout') + 2);
      commands.push(command);
      await before(command);
      return browser.run(executable, args, options);
    },
    resolveSignInBrowser: async () => '/fixture/chromium',
    signInLauncher: {
      async start() {
        await starting();
        nativeClosed = false;
        const exited = deferred();
        return {
          get closed() {
            return nativeClosed;
          },
          exited: exited.promise,
          async close() {
            nativeClosed = true;
            exited.resolve();
          },
        };
      },
    },
  });
  return {
    computer,
    commands,
    directory,
    open: () => computer.act('task', { action: 'open', url: 'https://1.1.1.1/login' }),
    before(value: typeof before) {
      before = value;
    },
    starting(value: typeof starting) {
      starting = value;
    },
    async close() {
      before = async () => {};
      starting = async () => {};
      await computer.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('checkpoint status blocks credential injection until the private call finishes', async () => {
  const f = await browserFixture();
  const entered = deferred();
  const release = deferred();
  try {
    await f.open();
    f.before(async (command) => {
      if (command[0] === 'eval') {
        entered.resolve();
        await release.promise;
      }
    });
    const injecting = f.computer.injectCredentials({
      threadId: 'task',
      origin: 'https://1.1.1.1',
      kind: 'identifier',
      username: 'synthetic@example.test',
      usernameSelector: 'input',
    });
    assert.equal(f.computer.canCheckpoint(), false);
    await entered.promise;
    assert.equal(f.computer.canCheckpoint(), false);
    release.resolve();
    assert.deepEqual(await injecting, { status: 'submitted' });
    assert.equal(f.computer.canCheckpoint(), true);
  } finally {
    release.resolve();
    await f.close();
  }
});

// Daemon transport fences and credential feedback

type BrowserTab = { tabId: string; active: boolean; url: string };

async function transportFixture(respectTimeouts = false) {
  const directory = await mkdtemp('/tmp/sk-transport-');
  const pages = stagedLoginBrowser();
  const actions: string[] = [];
  const launches: string[] = [];
  const sockets = new Set<Socket>();
  let before = async (_action: string, _command: Record<string, unknown>) => {};
  let failedAction: string | undefined;
  let failedMessage = 'Navigation failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE PRIVATE-UPSTREAM';
  const switches: string[] = [];
  const timeouts: { action: unknown; timeoutMs: number | undefined }[] = [];
  let tabs = (url: string): BrowserTab[] => [{ tabId: 't1', active: true, url }];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let input = '';
    socket.on('data', async (chunk) => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      const command = JSON.parse(input);
      input = '';
      actions.push(command.action);
      await before(command.action, command);
      if (command.action === failedAction) {
        socket.end(
          JSON.stringify({
            success: false,
            error: failedMessage,
          }) + '\n',
        );
        return;
      }
      const page = pages.pages.get('fixture')!;
      let data: Record<string, unknown> = {};
      if (command.action === 'url') data = { url: page.location.href };
      if (command.action === 'tab_list') data = { tabs: tabs(page.location.href) };
      if (command.action === 'tab_switch') switches.push(command.tabId);
      if (command.action === 'evaluate') data = { result: await page.evaluate(command.script) };
      if (command.action === 'snapshot') data = { snapshot: page.text() };
      if (command.action === 'navigate') page.location.href = command.url;
      if (command.action === 'screenshot') await writeFile(command.path, page.screen());
      if (!socket.destroyed) socket.end(JSON.stringify({ success: true, data }) + '\n');
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(directory, `${browserSessionId('fixture')}.sock`), resolve),
  );
  const computer = createAgentBrowserComputer({
    dataRoot: directory,
    daemonCommand: (path, command, signal, timeoutMs) => {
      timeouts.push({ action: command.action, timeoutMs });
      return existingDaemonCommand(path, command, signal, respectTimeouts ? timeoutMs : 250);
    },
    run: async (executable, args, options) => {
      if (args.includes('info')) {
        launches.push('info');
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            success: true,
            data: {
              active: true,
              namespace: args[args.indexOf('--namespace') + 1],
              session: args[args.indexOf('--session') + 1],
              socketDir: directory,
            },
          }),
        };
      }
      const action = args[args.indexOf('--idle-timeout') + 2];
      launches.push(action);
      assert.equal(action, 'open', 'Warm actions must not invoke the retrying CLI');
      return pages.run(executable, args, options);
    },
  });
  return {
    computer,
    actions,
    launches,
    page: () => pages.pages.get('fixture')!,
    switches,
    timeouts,
    tabs(value: typeof tabs) {
      tabs = value;
    },
    fail(action?: string, message?: string) {
      failedAction = action;
      if (message !== undefined) failedMessage = message;
    },
    before(value: typeof before) {
      before = value;
    },
    async cleanup() {
      before = async () => {};
      await computer.dispose().catch(() => {});
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('a timed out snapshot is not resent and its queue remains fenced until close is acknowledged', async () => {
  const f = await transportFixture();
  const closeStarted = deferred();
  const releaseClose = deferred();
  const releaseSnapshot = deferred();
  let finished = false;
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const before = f.actions.length;
    f.before(async (action) => {
      if (action === 'snapshot') await releaseSnapshot.promise;
      if (action === 'close') {
        closeStarted.resolve();
        await releaseClose.promise;
      }
    });
    const failed = assert
      .rejects(f.computer.act('fixture', { action: 'snapshot' }), /unavailable/)
      .finally(() => {
        finished = true;
      });
    await closeStarted.promise;
    assert.equal(finished, false);
    const queued = assert.rejects(f.computer.act('fixture', { action: 'snapshot' }), /expired/);
    releaseSnapshot.resolve();
    releaseClose.resolve();
    await Promise.all([failed, queued]);
    assert.equal(f.actions.slice(before).filter((action) => action === 'snapshot').length, 1);
    assert.equal(f.actions.slice(before).filter((action) => action === 'close').length, 1);
    assert.deepEqual(f.launches, ['open', 'info']);
  } finally {
    releaseSnapshot.resolve();
    releaseClose.resolve();
    await f.cleanup();
  }
});

{
  const failedClose = true;
  test('interrupted credential feedback preserves an unconfirmed close fence without replay or cleanup commands', async () => {
    const f = await transportFixture();
    const releaseFeedback = deferred();
    try {
      await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
      const login = await f.computer.inspectLogin('fixture');
      let feedbackCalls = 0;
      f.before(async (action, command) => {
        if (
          action === 'evaluate' &&
          typeof command.script === 'string' &&
          command.script.includes('mark=false;')
        ) {
          feedbackCalls++;
          await releaseFeedback.promise;
        }
        if (action === 'close') {
          releaseFeedback.resolve();
          if (failedClose) f.fail('close');
        }
      });
      await assert.rejects(
        f.computer.injectCredentials({
          threadId: 'fixture',
          origin: login.origin,
          kind: 'identifier',
          username: 'private-credential-fixture@example.test',
          usernameSelector: login.fields[0].selector,
          submitSelector: login.submitSelector,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(
            error.message,
            'Secure entry could not be confirmed. Check the login page before continuing.',
          );
          return true;
        },
      );
      assert.equal(feedbackCalls, 1);
      const closed = f.actions.indexOf('close');
      assert.notEqual(closed, -1);
      assert.deepEqual(f.actions.slice(closed), ['close']);
      await assert.rejects(f.computer.act('fixture', { action: 'snapshot' }), /expired/);
      assert.deepEqual(f.actions.slice(closed), ['close']);
      assert.deepEqual(f.launches, ['open', 'info']);
    } finally {
      releaseFeedback.resolve();
      f.fail();
      await f.cleanup();
    }
  });
}

test('closing during successful credential feedback cannot report submission or clear credentials', async () => {
  const f = await transportFixture();
  const feedbackStarted = deferred();
  const releaseFeedback = deferred();
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const login = await f.computer.inspectLogin('fixture');
    let feedbackIndex = -1;
    let clearingCommands = 0;
    f.before(async (action, command) => {
      if (
        action === 'evaluate' &&
        typeof command.script === 'string' &&
        command.script.includes("e.value=''")
      )
        clearingCommands++;
      if (
        action === 'evaluate' &&
        typeof command.script === 'string' &&
        command.script.includes('mark=false;')
      ) {
        feedbackIndex = f.actions.length - 1;
        feedbackStarted.resolve();
        await releaseFeedback.promise;
      }
    });
    const rejected = assert.rejects(
      f.computer.injectCredentials({
        threadId: 'fixture',
        origin: login.origin,
        kind: 'identifier',
        username: 'private-credential-fixture@example.test',
        usernameSelector: login.fields[0].selector,
        submitSelector: login.submitSelector,
      }),
      /Secure entry could not be confirmed/,
    );
    await feedbackStarted.promise;
    const closed = f.computer.close('fixture');
    releaseFeedback.resolve();
    await Promise.all([rejected, closed]);
    assert.notEqual(feedbackIndex, -1);
    assert.equal(clearingCommands, 0);
    assert.equal(f.actions.filter((action) => action === 'close').length, 1);
    assert.equal(f.actions.at(-1), 'close');
    const completedActions = f.actions.length;
    await assert.rejects(f.computer.act('fixture', { action: 'snapshot' }), /Open a website first/);
    assert.equal(f.actions.length, completedActions);
  } finally {
    releaseFeedback.resolve();
    await f.cleanup();
  }
});

test('failed interruption cleanup blocks later actions until an explicit close succeeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-browser-drain-failure-'));
  const fixture = stagedLoginBrowser();
  const commands: string[] = [];
  let failClose = true;
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: async (executable, args, options) => {
      const action = args[args.indexOf('--idle-timeout') + 2];
      commands.push(action);
      if (action === 'open' && failClose)
        throw new Error('Runtime command exceeded its time limit.');
      if (action === 'close' && failClose) throw new Error('Synthetic close unavailable.');
      return fixture.run(executable, args, options);
    },
  });
  try {
    await assert.rejects(
      computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' }),
      /could not stop safely/,
    );
    const count = commands.length;
    await assert.rejects(computer.act('fixture', { action: 'snapshot' }), /expired/);
    await assert.rejects(
      computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' }),
      /expired/,
    );
    assert.equal(commands.length, count);
    failClose = false;
    await computer.close('fixture');
    const reopened = await computer.act('fixture', {
      action: 'open',
      url: 'https://1.1.1.1/login',
    });
    assert.equal(reopened.url, 'https://1.1.1.1/login');
  } finally {
    failClose = false;
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'native interrupted credential feedback refuses submission and a fresh browser remains usable',
  { skip: !process.env.OTTO_TEST_BROWSER_EXECUTABLE, timeout: 60_000 },
  async () => {
    let submissions = 0;
    const server = createHttpServer((request, response) => {
      if (request.url === '/submitted') {
        submissions++;
        response.writeHead(204).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<html><title>Synthetic login</title><body>
        <form onsubmit="event.preventDefault();fetch('/submitted',{method:'POST'});document.querySelector('#status').textContent='Entry received'">
          <label for="password">Password</label><input id="password" type="password">
          <button id="submit">Sign in</button>
        </form>
        <p id="status">Waiting</p>
        <button type="button" onclick="document.querySelector('#status').textContent='Fresh action completed'">Fresh action</button>
        </body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const root = await mkdtemp(join(tmpdir(), 'otto-credential-transition-'));
    let interrupted = 0;
    let feedbackCalls = 0;
    let closeCalls = 0;
    let clicks = 0;
    const computer = createAgentBrowserComputer({
      dataRoot: root,
      browserExecutable: process.env.OTTO_TEST_BROWSER_EXECUTABLE,
      headless: true,
      daemonCommand: async (path, command, signal, timeoutMs, maxBytes) => {
        if (command.action === 'close') closeCalls++;
        if (command.action === 'click') clicks++;
        if (
          command.action === 'evaluate' &&
          typeof command.script === 'string' &&
          command.script.includes('mark=false;') &&
          command.script.includes('data-otto-entry-attempt')
        ) {
          feedbackCalls++;
          try {
            return await existingDaemonCommand(
              path,
              {
                ...command,
                script: `new Promise(resolve => setTimeout(() => resolve(${command.script}), 3000))`,
              },
              signal,
              timeoutMs,
              maxBytes,
            );
          } catch (error) {
            if (signal?.aborted) interrupted++;
            throw error;
          }
        }
        return existingDaemonCommand(path, command, signal, timeoutMs, maxBytes);
      },
    });
    try {
      await computer.act('credential-transition', { action: 'open', url: origin });
      const submission = await computer
        .injectCredentials({
          threadId: 'credential-transition',
          origin,
          kind: 'password',
          password: 'synthetic-credential-must-stay-private',
          passwordSelector: '#password',
          submitSelector: '#submit',
        })
        .then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
      assert.equal(feedbackCalls, 1);
      assert.equal(interrupted, 1);
      assert.equal(closeCalls, 1);
      assert.equal(submissions, 1);
      await assert.rejects(
        computer.act('credential-transition', { action: 'snapshot' }),
        /The browser session has expired/,
      );
      assert.equal(clicks, 0);
      const fresh = await computer.act('credential-fresh-retry', {
        action: 'open',
        url: origin,
      });
      const button = fresh.candidates.find((candidate) => candidate.label.includes('Fresh action'));
      assert.ok(button);
      const clicked = await computer.act('credential-fresh-retry', {
        action: 'click',
        selector: button.id,
      });
      assert.match(clicked.text, /Fresh action completed/);
      assert.equal(clicks, 1);
      assert.equal(submissions, 1);
      assert.equal(clicked.text.includes('synthetic-credential-must-stay-private'), false);
      assert.equal(submission.value, undefined);
      assert.ok(submission.error instanceof Error);
      assert.equal(
        submission.error.message,
        'Secure entry could not be confirmed. Check the login page before continuing.',
      );
    } finally {
      try {
        await computer.dispose();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);

// Uncertain browser results stop the turn

type Execute = (id: string, input: BrowserAction) => Promise<AgentToolResult>;

async function runtimeFixture(
  computer: Computer,
  run: (execute: Execute) => Promise<void>,
  options: {
    controller?: AbortController;
    observe?: (event: RuntimeObservation) => Promise<void>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-click-recovery-'));
  const threadId = randomUUID();
  const observations: RuntimeObservation[] = [];
  const agent: Agent = {
    open: async ({ tools }) => ({
      resumed: false,
      prompt: async () => {
        const tool = tools.find((value) => value.name === 'browser')!;
        await run((_id, input) => tool.execute({ ...input }));
      },
      abort() {},
      dispose() {},
    }),
    dispose() {},
  };
  const runtime = createAgentRuntime({ agent, computer, workspace: fakeWorkspace() });
  const context: RuntimeContext = {
    threadId,
    turnId: randomUUID(),
    prompt: 'Open the synthetic destination after dismissing its covering dialog.',
    history: [],
    attachments: [],
    workspacePath: directory,
    signal: (options.controller ?? new AbortController()).signal,
    emit: async () => {},
    observe: async (event) => {
      observations.push(event);
      await options.observe?.(event);
    },
    reply: async () => {},
    delta() {},
    publish: async () => {
      throw new Error('unused');
    },
    requestCredential: async () => ({}),
    integration: async () => ({}),
    manage: async () => ({}),
  };
  return {
    observations,
    run: () => runtime.runTurn(context),
    async close() {
      try {
        await runtime.dispose();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

for (const failure of ['unknown', 'forged', 'navigation', 'wrong_action', 'cancelled_observation'])
  test(`${failure} browser failure stops the turn without a blocked result`, async () => {
    const controller = new AbortController();
    let calls = 0;
    const f = await runtimeFixture(
      fakeComputer({
        act: async () => {
          calls++;
          if (failure === 'unknown') throw new Error('Private unknown outcome');
          if (failure === 'forged')
            throw Object.assign(new Error('Private forged error'), {
              code: 'browser_click_intercepted',
            });
          throw new BrowserActionError(
            failure === 'navigation' ? 'browser_navigation_failed' : 'browser_click_intercepted',
          );
        },
      }),
      async (execute) => {
        await execute('uncertain', {
          action: failure === 'wrong_action' ? 'snapshot' : 'click',
          selector: '@e1',
        });
        assert.fail('An uncertain browser result must not continue.');
      },
      {
        controller,
        observe: async (event) => {
          if (failure === 'cancelled_observation' && event.type === 'tool_end') controller.abort();
        },
      },
    );
    try {
      await assert.rejects(f.run());
      assert.equal(calls, 1);
      assert.doesNotMatch(JSON.stringify(f.observations), /Private unknown|Private forged/);
    } finally {
      await f.close();
    }
  });

// Container browser worker namespaces

function workerComputer() {
  const calls: Array<{ method: string; input?: unknown }> = [];
  let session: ReturnType<NonNullable<Computer['currentSession']>>;
  let act: Computer['act'] = async (id, input) => {
    session = { threadId: id, lastActivityAt: new Date().toISOString() };
    return {
      text: input.text ?? 'Synthetic page',
      url: input.url ?? 'https://example.com/',
      candidates: [],
    };
  };
  const computer: Computer = {
    currentSession: () => session,
    status: () => 'Synthetic workspace browser',
    screenStatus: () => ({ state: 'live', capturedAt: '2026-09-25T12:00:00.000Z' }),
    act: (id, input, signal) => {
      calls.push({ method: 'act', input });
      return act(id, input, signal);
    },
    screenshot: async () => Buffer.from('masked synthetic image'),
    signInScreenshot: async () => Buffer.from('owner-only synthetic sign-in image'),
    takeControl: async () => {
      calls.push({ method: 'takeControl' });
    },
    openSignIn: async () => {
      calls.push({ method: 'openSignIn' });
    },
    finishSignIn: async () => {
      calls.push({ method: 'finishSignIn' });
    },
    control: async (_id, input) => {
      calls.push({ method: 'control', input });
    },
    signInControl: async (_id, input) => {
      calls.push({ method: 'signInControl', input });
    },
    releaseControl: async () => {},
    injectCredentials: async (input) => {
      calls.push({ method: 'injectCredentials', input });
      return { status: 'submitted' };
    },
    inspectLogin: async () => ({
      origin: 'https://example.com',
      url: 'https://example.com/login',
      fields: [],
      methods: [],
    }),
    selectLoginMethod: async () => {},
    hold: async () => {},
    close: async () => {
      calls.push({ method: 'close' });
    },
    dispose: async () => {
      calls.push({ method: 'dispose' });
    },
  };
  return {
    computer,
    calls,
    setAct(value: Computer['act']) {
      act = value;
    },
  };
}

async function harness(control: { beforeFirstBridge?: Promise<void> } = {}) {
  const root = await mkdtemp('/tmp/sk-browser-');
  const socketPath = join(root, 'control.sock');
  const instances = new Map<string, ReturnType<typeof workerComputer>>();
  const worker = await startContainerBrowserWorker({
    socketPath,
    dataRoot: root,
    createComputer: async (path) => {
      const value = workerComputer();
      instances.set(path, value);
      return value.computer;
    },
  });
  const launches: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> =
    [];
  const launch: BrowserBridgeLauncher = (command, args, options) => {
    launches.push({ command, args, env: options.env });
    const process = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        this.stdin.destroy();
        return true;
      },
    });
    void Promise.resolve(launches.length === 1 ? control.beforeFirstBridge : undefined)
      .then(() => runBrowserBridge({ input: process.stdin, output: process.stdout, socketPath }))
      .then((code) => {
        process.stdout.end();
        process.stderr.end();
        process.emit('close', code);
      });
    return process as unknown as ChildProcessWithoutNullStreams;
  };
  const clients: Computer[] = [];
  function client(
    dataRoot: string,
    options: { timeoutMs?: number; openTimeoutMs?: number; drainTimeoutMs?: number } = {},
  ) {
    const value = createContainerBrowserComputer({ dataRoot, spawn: launch, ...options });
    clients.push(value);
    return value;
  }
  return {
    root,
    socketPath,
    worker,
    launches,
    instances,
    client,
    instance(dataRoot: string) {
      const value = instances.get(join(root, browserNamespace(dataRoot)));
      assert.ok(value);
      return value;
    },
    async close() {
      await Promise.allSettled(clients.map((client) => client.dispose()));
      await worker.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Vault broker metadata stays local while identifier, password and OTP inputs reach the browser', async () => {
  const fixture = await harness();
  const dataRoot = '/synthetic/vault-broker';
  const inputs: CredentialInjection[] = [
    {
      threadId: 'task',
      origin: 'https://example.com',
      label: 'Synthetic saved account',
      kind: 'identifier',
      username: 'synthetic@example.test',
      usernameSelector: '#username',
      submitSelector: '#continue',
    },
    {
      threadId: 'task',
      origin: 'https://example.com',
      label: 'Synthetic saved account',
      kind: 'password',
      username: 'synthetic@example.test',
      password: 'Synthetic-only-value',
      usernameSelector: '#username',
      passwordSelector: '#password',
      submitSelector: '#continue',
    },
    {
      threadId: 'task',
      origin: 'https://example.com',
      label: 'Synthetic verification step',
      kind: 'otp',
      code: '123456',
      passwordSelector: '#code',
      submitSelector: '#verify',
    },
  ];
  try {
    const computer = fixture.client(dataRoot);
    for (const input of inputs)
      assert.deepEqual(await computer.injectCredentials(input), { status: 'submitted' });
    const calls = fixture
      .instance(dataRoot)
      .calls.filter((call) => call.method === 'injectCredentials');
    assert.equal(calls.length, inputs.length);
    for (const [index, input] of inputs.entries()) {
      const { label: _label, ...expected } = input;
      assert.deepEqual(calls[index].input, expected);
    }
    assert.doesNotMatch(
      JSON.stringify(fixture.launches),
      /Synthetic saved account|Synthetic-only-value|123456/,
    );
  } finally {
    await fixture.close();
  }
});

test('each application namespace retains its own worker and disposal drains only that namespace', async () => {
  const fixture = await harness();
  try {
    const first = fixture.client('/synthetic/first');
    const second = fixture.client('/synthetic/second');
    await Promise.all([
      first.act('same-task', { action: 'snapshot' }),
      second.act('same-task', { action: 'snapshot' }),
    ]);
    const one = fixture.instance('/synthetic/first');
    const two = fixture.instance('/synthetic/second');
    await first.dispose();
    assert.equal(one.calls.filter((call) => call.method === 'dispose').length, 1);
    assert.equal(
      two.calls.some((call) => call.method === 'dispose'),
      false,
    );
    await assert.rejects(first.act('same-task', { action: 'snapshot' }), /unavailable/);
    await second.act('same-task', { action: 'snapshot' });
  } finally {
    await fixture.close();
  }
});

test('malformed methods and namespaces never reach a computer or filesystem path', async () => {
  const fixture = await harness();
  try {
    for (const request of [
      { id: randomUUID(), namespace: '../../private', method: 'status' },
      {
        id: randomUUID(),
        namespace: browserNamespace('/synthetic/invalid'),
        method: 'eval',
        input: 'private',
      },
      {
        id: randomUUID(),
        namespace: browserNamespace('/synthetic/invalid'),
        method: 'act',
        threadId: '../outside',
        input: { action: 'snapshot' },
      },
    ]) {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(fixture.socketPath);
        socket.on('error', reject);
        socket.on('close', resolve);
        socket.on('connect', () =>
          socket.write(JSON.stringify({ type: 'request', request }) + '\n'),
        );
      });
    }
    assert.equal(fixture.instances.size, 0);
    assert.throws(
      () => createContainerBrowserComputer({ dataRoot: '/synthetic', container: 'otto-workspace' }),
      /BROWSER_CONTAINER/,
    );
  } finally {
    await fixture.close();
  }
});

test('an unacknowledged cancellation fences new actions until namespace cleanup succeeds', async () => {
  const fixture = await harness();
  const drain = deferred();
  try {
    const computer = fixture.client('/synthetic/timeout', { drainTimeoutMs: 20 });
    await computer.act('task', { action: 'snapshot' });
    const entered = deferred();
    fixture.instance('/synthetic/timeout').setAct(async () => {
      entered.resolve();
      await drain.promise;
      return { text: 'Late', url: 'https://example.com', candidates: [] };
    });
    const controller = new AbortController();
    const cancelled = assert.rejects(
      computer.act('task', { action: 'snapshot' }, controller.signal),
      /did not finish safely/,
    );
    await entered.promise;
    controller.abort();
    await cancelled;
    await assert.rejects(computer.takeControl!('task'), /unavailable/);
    assert.match(computer.status(), /needs a restart/);
    drain.resolve();
    await computer.dispose();
  } finally {
    drain.resolve();
    await fixture.close();
  }
});

// Login inspection and observation redaction

function element(tag: string, attributes: Record<string, string> = {}, text = '') {
  const value = new LoginElement();
  value.tagName = tag.toUpperCase();
  value.innerText = text;
  for (const [name, content] of Object.entries(attributes)) {
    if (['type', 'id', 'name', 'autocomplete'].includes(name))
      Object.assign(value, { [name]: content });
    else value.setAttribute(name, content);
  }
  return value;
}

test('ambiguous dialogs and separate-window OAuth fail closed and inert controls are ignored', () => {
  const page = new LoginDom();
  const first = element('div', { role: 'dialog' });
  first.append(
    element('input', { autocomplete: 'username' }),
    element('a', { target: '_blank' }, 'Continue with Google'),
  );
  const second = element('dialog', { open: '' });
  const secondInput = element('input', { type: 'email' });
  second.append(secondInput);
  const hidden = element('div', { inert: '' });
  hidden.append(element('button', {}, 'Continue with Microsoft'));
  page.body.append(first, second, hidden);
  let inspection = loginInspectionSchema.parse(page.evaluate(loginInspectionScript()));
  assert.equal(inspection.methods.find((method) => method.id === 'credentials')?.supported, false);
  assert.equal(inspection.methods.find((method) => method.id === 'oauth-google')?.supported, false);
  assert.equal(
    inspection.methods.find((method) => method.id === 'oauth-microsoft'),
    undefined,
  );
  page.activeElement = secondInput;
  inspection = loginInspectionSchema.parse(page.evaluate(loginInspectionScript()));
  assert.equal(inspection.fields.length, 1);
  assert.equal(inspection.methods.find((method) => method.id === 'credentials')?.supported, true);
});

test('sign-in inspection preserves tab and nested radio choices and selects only the observed option', async () => {
  const pages = [
    '<h1>Autenticação</h1><div role="tablist" aria-label="Forma de autenticação"><button role="tab" aria-selected="true">CC / CMD</button><button role="tab" aria-selected="false">NIF</button><button role="tab" aria-selected="false">EORI</button></div><section role="tabpanel"><p>Faça a sua autenticação com Cartão de Cidadão ou Chave Móvel Digital</p><button><img alt="Logo Autenticação Gov"></button></section><section hidden><input type="email" value="private-hidden-identifier"></section>',
    '<h1>Autenticação</h1><form><fieldset><legend>Forma de Autenticação</legend><label><input type="radio" name="identity" checked>Cartão de Cidadão</label><label><input type="radio" name="identity">Chave Móvel Digital</label><input type="radio" name="identity" value="private-protocol-token"><fieldset><legend>Forma de Autenticação via Chave Móvel Digital</legend><label><input type="radio" name="mobile" checked>Telemóvel</label><label><input type="radio" name="mobile">Código QR</label></fieldset></fieldset><button type="submit">Continuar</button></form>',
  ];
  for (const [index, html] of pages.entries()) {
    const dom = new JSDOM(html, {
      url: 'https://identity.example.test/login',
      runScripts: 'outside-only',
    });
    dom.window.HTMLElement.prototype.getClientRects = () =>
      [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      get() {
        return this.textContent;
      },
    });
    try {
      const inspect = () => loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
      const inspection = inspect();
      assert.equal(inspection.fields.length, 0);
      assert.equal(JSON.stringify(inspection).includes('private-hidden-identifier'), false);
      assert.equal(JSON.stringify(inspection).includes('private-protocol-token'), false);
      if (index === 0) {
        assert.deepEqual(
          inspection.methods
            .filter((method) => method.group === 'Forma de autenticação')
            .map(({ label, selected, supported }) => ({ label, selected, supported })),
          [
            { label: 'CC / CMD', selected: true, supported: true },
            { label: 'NIF', selected: false, supported: true },
            { label: 'EORI', selected: false, supported: true },
          ],
        );
        assert.equal(
          inspection.methods.find((method) => method.label === 'Logo Autenticação Gov')?.supported,
          true,
        );
        const tab = dom.window.document.querySelector('[role="tab"]')!;
        tab.parentElement!.append(tab);
        assert.deepEqual(
          new Set(inspect().methods.map((method) => method.id)),
          new Set(inspection.methods.map((method) => method.id)),
        );
      } else {
        assert.deepEqual(
          inspection.methods
            .filter((method) => method.group)
            .map(({ label, group, selected }) => ({ label, group, selected })),
          [
            { label: 'Cartão de Cidadão', group: 'Forma de Autenticação', selected: true },
            { label: 'Chave Móvel Digital', group: 'Forma de Autenticação', selected: false },
            {
              label: 'Telemóvel',
              group: 'Forma de Autenticação via Chave Móvel Digital',
              selected: true,
            },
            {
              label: 'Código QR',
              group: 'Forma de Autenticação via Chave Móvel Digital',
              selected: false,
            },
          ],
        );
        const method = inspection.methods.find((item) => item.label === 'Chave Móvel Digital')!;
        assert.equal(method.supported, true);
        const submitted = (await dom.window.eval(
          credentialSubmitScript(dom.window.location.origin, method.selector!),
        )) as { ok: boolean };
        assert.equal(submitted.ok, true);
        assert.equal(inspect().methods.find((item) => item.id === method.id)?.selected, true);
        assert.equal(
          inspect().methods.find((item) => item.label === 'Cartão de Cidadão')?.selected,
          false,
        );
        assert.equal(inspection.methods.find((item) => item.id === 'continue')?.group, undefined);
        assert.equal(inspection.methods.find((item) => item.id === 'continue')?.supported, true);
      }
    } finally {
      dom.window.close();
    }
  }
});

test('sign-in inspection recognizes semantic identifiers and PIN labels without exposing or weakening secret fields', () => {
  for (const [label, type] of [
    ['Número de telemóvel', 'tel'],
    ['NIF', 'text'],
    ['EORI', 'text'],
  ]) {
    const dom = new JSDOM(
      `<h1>Autenticação</h1><form><label for="account">${label}</label><input id="account" type="${type}" value="private-identifier"><label for="secret">PIN de autenticação</label><input id="secret" type="password" value="private-secret"><button type="submit">Autenticar</button></form>`,
      { url: 'https://identity.example.test/login', runScripts: 'outside-only' },
    );
    dom.window.HTMLElement.prototype.getClientRects = () =>
      [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      get() {
        return this.textContent;
      },
    });
    try {
      const inspection = loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
      assert.deepEqual(
        inspection.fields.map(({ kind, label }) => ({ kind, label })),
        [
          { kind: 'identifier', label },
          { kind: 'password', label: 'PIN de autenticação' },
        ],
      );
      assert.ok(inspection.submitSelector);
      assert.equal(
        inspection.methods.find((method) => method.id === 'credentials')?.supported,
        true,
      );
      assert.doesNotMatch(JSON.stringify(inspection), /private-identifier|private-secret/);
      dom.window.document.querySelector<HTMLInputElement>('#secret')!.type = 'text';
      const unsupported = loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
      assert.equal(
        unsupported.fields.some((field) => field.kind === 'password'),
        false,
      );
      assert.equal(
        unsupported.methods.find((method) => method.id === 'credentials')?.supported,
        false,
      );
      assert.match(
        dom.window.document.querySelector('#secret')!.getAttribute('data-otto-login-field')!,
        /^password-unsupported-/,
      );
      dom.window.eval(maskPageScript([], []));
      assert.equal(
        dom.window.document.querySelector<HTMLElement>('#secret')!.style.color,
        'transparent',
      );
    } finally {
      dom.window.close();
    }
  }
  const mobile = new JSDOM(
    '<h1>Autenticação</h1><form><div><p>Número de telemóvel</p><div><span>Portugal: +351</span><input id="field1" value="private-phone"><span>private-phone password</span></div></div><div><p>Inserir PIN</p><input id="field2" type="password" value="private-pin"><span>private-pin PIN</span></div><button>Autenticar</button></form>',
    { url: 'https://identity.example.test/login', runScripts: 'outside-only' },
  );
  mobile.window.HTMLElement.prototype.getClientRects = () =>
    [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
  Object.defineProperty(mobile.window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent;
    },
  });
  try {
    const inspection = loginInspectionSchema.parse(mobile.window.eval(loginInspectionScript()));
    assert.deepEqual(
      inspection.fields.map(({ kind, label }) => ({ kind, label })),
      [
        { kind: 'identifier', label: 'Número de telemóvel' },
        { kind: 'password', label: 'Inserir PIN' },
      ],
    );
    assert.ok(inspection.submitSelector);
    assert.doesNotMatch(JSON.stringify(inspection), /private-phone|private-pin|Portugal/);
  } finally {
    mobile.window.close();
  }
  for (const kind of ['identifier', 'password', 'otp'] as const) {
    for (const source of ['label', 'aria-label', 'placeholder']) {
      const value = kind === 'otp' ? '137924' : `private-${kind}`;
      const type = kind === 'identifier' ? 'tel' : kind === 'password' ? 'password' : 'text';
      const label = `${kind === 'password' ? 'PIN' : kind === 'otp' ? 'Verification code' : 'Phone'} for ${value}`;
      const dom = new JSDOM(
        `<form>${source === 'label' ? `<label for="field">${label}</label>` : ''}<input id="field" type="${type}" ${source === 'label' ? '' : `${source}="${label}"`} value="${value}"><button type="submit">Continue</button></form>`,
        { url: 'https://identity.example.test/login', runScripts: 'outside-only' },
      );
      dom.window.HTMLElement.prototype.getClientRects = () =>
        [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
      Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
        get() {
          return this.textContent;
        },
      });
      try {
        const inspect = () => loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
        assert.equal(inspect().fields[0]?.kind, kind);
        assert.equal(JSON.stringify(inspect()).includes(value), false);
        dom.window.document.querySelector<HTMLInputElement>('#field')!.value = '';
        assert.equal(JSON.stringify(inspect()).includes(value), false);
      } finally {
        dom.window.close();
      }
    }
  }
  for (const [label, delivery, expected] of [
    [
      'Código de segurança',
      'Enviámos um código por email para owner@example.test.',
      { recipient: 'owner@example.test', length: 6 },
    ],
    [
      'Código de confirmação',
      'Enviámos um código por email para o***@example.test.',
      { recipientHint: 'o***@example.test', length: 6 },
    ],
    ['Código de confirmação', 'Enviámos um código por email.', { length: 6 }],
    ['Código recebido por SMS', 'Enviámos um código por SMS.', undefined],
    [
      'Código de segurança',
      'Enviámos um código por email para a@example.test e b@example.test.',
      undefined,
    ],
  ] as const) {
    const dom = new JSDOM(
      `<form><p>${delivery}</p><label for="code">${label}</label><input id="code" maxlength="6" value="418693"><button type="submit">Confirmar</button></form>`,
      { url: 'https://identity.example.test/login', runScripts: 'outside-only' },
    );
    dom.window.HTMLElement.prototype.getClientRects = () =>
      [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      get() {
        return this.textContent;
      },
    });
    try {
      const inspection = loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
      assert.deepEqual(
        inspection.fields.map(({ kind, label }) => ({ kind, label })),
        [{ kind: 'otp', label }],
      );
      assert.deepEqual(inspection.emailCode, expected);
      assert.equal(JSON.stringify(inspection).includes('418693'), false);
    } finally {
      dom.window.close();
    }
  }
});

test('sign-in recognizes focus-unlocked mobile fields despite conflicting OTP autocomplete and securely enters them', () => {
  const dom = new JSDOM(
    '<h1>Autenticação</h1><form><div class="row"><div class="col-md-12"><span id="MainContent_lblMobile">Número de telemóvel</span><br><div class="wrapperModal"><div class="intl-tel-input pretty inside"><input id="inputMobile" name="inputMobile" type="text" inputmode="numeric" autocomplete="one-time-code" readonly onfocus="this.removeAttribute(\'readonly\');"></div></div></div></div><div class="row"><div class="col-md-12"><span id="MainContent_lblPin" class="lblMobileTxtModal">Inserir PIN</span><br><div class="wrapperModal"><input name="ctl00$MainContent$txtPin" type="password" maxlength="8" id="MainContent_txtPin" inputmode="numeric" size="8" class="wrapperModalInput"><img alt="Show Password"></div></div></div><button type="submit">Autenticar</button></form>',
    { url: 'https://identity.example.test/login', runScripts: 'outside-only' },
  );
  dom.window.HTMLElement.prototype.getClientRects = () =>
    [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent;
    },
  });
  try {
    const mobile = dom.window.document.querySelector<HTMLInputElement>('#inputMobile')!;
    mobile.onfocus = () => mobile.removeAttribute('readonly');
    const pin = dom.window.document.querySelector<HTMLInputElement>('#MainContent_txtPin')!;
    const inspection = loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
    assert.equal(
      inspection.fields.find((field) => field.kind === 'password')?.label,
      'Inserir PIN',
    );
    assert.deepEqual(
      inspection.fields.map(({ kind, label }) => ({ kind, label })),
      [
        { kind: 'identifier', label: 'Número de telemóvel' },
        { kind: 'password', label: 'Inserir PIN' },
      ],
    );
    assert.equal(mobile.readOnly, true);
    assert.ok(inspection.submitSelector);
    let submitted = false;
    dom.window.document.querySelector('form')!.onsubmit = (event) => {
      event.preventDefault();
      submitted = true;
    };
    const fields = credentialFields({
      threadId: 'mobile-fixture',
      origin: dom.window.location.origin,
      kind: 'password',
      username: '900000000',
      password: '12345678',
      usernameSelector: inspection.fields.find((field) => field.kind === 'identifier')!.selector,
      passwordSelector: inspection.fields.find((field) => field.kind === 'password')!.selector,
    });
    const result = dom.window.eval(
      credentialScript(dom.window.location.origin, fields, inspection.submitSelector),
    ) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(mobile.readOnly, false);
    assert.equal(mobile.value, '900000000');
    assert.equal(pin.value, '12345678');
    assert.equal(mobile.style.color, 'transparent');
    assert.equal(pin.style.color, 'transparent');
    assert.equal(submitted, true);
    assert.doesNotMatch(JSON.stringify(result), /900000000|12345678/);
  } finally {
    dom.window.close();
  }
});

test('sign-in preserves a fixed readonly identifier while securely entering a staged password', () => {
  const dom = new JSDOM(
    '<h1>Sign in</h1><form><label for="account">Email</label><input id="account" type="email" readonly value="owner@example.test"><label for="password">Password</label><input id="password" type="password"><button type="submit">Continue</button></form>',
    { url: 'https://identity.example.test/login', runScripts: 'outside-only' },
  );
  dom.window.HTMLElement.prototype.getClientRects = () =>
    [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent;
    },
  });
  try {
    const inspection = loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
    assert.deepEqual(
      inspection.fields.map((field) => field.kind),
      ['password'],
    );
    let submitted = false;
    dom.window.document.querySelector('form')!.onsubmit = (event) => {
      event.preventDefault();
      submitted = true;
    };
    const result = dom.window.eval(
      credentialScript(
        dom.window.location.origin,
        [{ selector: inspection.fields[0].selector, value: 'synthetic-password', password: true }],
        inspection.submitSelector,
      ),
    ) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(submitted, true);
    assert.equal(
      dom.window.document.querySelector<HTMLInputElement>('#account')!.value,
      'owner@example.test',
    );
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('#account')!.readOnly, true);
    assert.equal(
      dom.window.document.querySelector<HTMLInputElement>('#password')!.value,
      'synthetic-password',
    );
  } finally {
    dom.window.close();
  }
});

test('secure entry rejects persistent readonly fields and focus-time target or origin changes before entering secrets', () => {
  for (const behavior of ['locked', 'replace', 'hide', 'password-type', 'origin'] as const) {
    const dom = new JSDOM(
      '<input id="mobile" readonly><input id="pin" type="password"><button id="submit">Continue</button>',
      { url: 'https://identity.example.test/login', runScripts: 'outside-only' },
    );
    dom.window.HTMLElement.prototype.getClientRects = () =>
      [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
    try {
      const mobile = dom.window.document.querySelector<HTMLInputElement>('#mobile')!;
      const pin = dom.window.document.querySelector<HTMLInputElement>('#pin')!;
      let focused = false;
      let submitted = false;
      dom.window.document.querySelector<HTMLButtonElement>('#submit')!.onclick = () => {
        submitted = true;
      };
      mobile.onfocus = () => {
        focused = true;
        if (behavior === 'locked') return;
        mobile.readOnly = false;
        if (behavior === 'replace') mobile.replaceWith(mobile.cloneNode());
        if (behavior === 'hide') pin.hidden = true;
        if (behavior === 'password-type') pin.type = 'text';
        if (behavior === 'origin') dom.reconfigure({ url: 'https://other.example.test/login' });
      };
      const result = dom.window.eval(
        credentialScript(
          dom.window.location.origin,
          [
            { selector: '#mobile', value: '900000000', password: false },
            { selector: '#pin', value: '12345678', password: true },
          ],
          '#submit',
        ),
      ) as { ok: boolean };
      assert.equal(focused, true);
      assert.equal(result.ok, false);
      assert.equal(mobile.value, '');
      assert.equal(pin.value, '');
      assert.equal(dom.window.document.querySelector<HTMLInputElement>('#mobile')?.value, '');
      assert.equal(submitted, false);
    } finally {
      dom.window.close();
    }
  }
});

test('browser observations redact OAuth callback values, API credentials and signed URL query values', () => {
  const url = redactBrowserUrl(
    'https://example.com/callback?code=private-code&email=private-email&state=private-state&view=account#access_token=private-token',
    [],
  );
  for (const value of ['private-code', 'private-email', 'private-state', 'private-token'])
    assert.equal(url.includes(value), false);
  assert.equal(new URL(url).searchParams.get('view'), 'account');
  for (const name of [
    'api_key',
    'X-API-Key',
    'client_secret',
    'signature',
    'X-Amz-Signature',
    'X-Amz-Credential',
    'X-Goog-Signature',
  ]) {
    const value = redactBrowserUrl(
      `https://example.com/download?${name}=synthetic-private-value&view=account`,
      [],
    );
    assert.equal(value.includes('synthetic-private-value'), false, name);
    assert.equal(new URL(value).searchParams.get('view'), 'account');
  }
});

test('browser observations redact manually typed secrets in encoded paths and unknown query fields', () => {
  const secret = 'fixture secret/with+symbols';
  const variants = [
    encodeURIComponent(secret),
    encodeURI(secret),
    new URLSearchParams({ value: secret }).toString().slice(6),
  ];
  for (const value of variants) {
    assert.equal(redactBrowserText(value, [secret]), '[redacted]');
    assert.equal(
      redactBrowserText(
        value.replace(/%[0-9A-F]{2}/g, (code) => code.toLowerCase()),
        [secret],
      ),
      '[redacted]',
    );
    assert.equal(
      redactBrowserUrl(`https://example.com/${value}?other=${value}`, [secret]).includes(value),
      false,
    );
  }
  assert.doesNotThrow(() => redactBrowserText('fixture', ['\ud800']));
});

test('staged identifier, password and OTP entry waits for Next and keeps secrets out of observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-staged-login-'));
  const fixture = stagedLoginBrowser();
  const computer = createBrowserFixture({ dataRoot: directory, run: fixture.run });
  try {
    await computer.act('login', { action: 'open', url: 'https://1.1.1.1/login' });
    const first = await computer.inspectLogin('login');
    assert.deepEqual(
      first.fields.map((field) => field.kind),
      ['identifier'],
    );
    assert.equal(first.methods.find((method) => method.kind === 'oauth')?.supported, true);
    assert.equal(first.methods.find((method) => method.kind === 'passkey')?.supported, false);
    assert.equal(
      first.methods.find((method) => method.kind === 'manual'),
      undefined,
    );
    await assert.rejects(
      computer.act('login', {
        action: 'fill',
        selector: first.fields[0].selector,
        text: 'not-through-chat',
      }),
      /secure credential/,
    );
    const identifier = computer.injectCredentials({
      threadId: 'login',
      origin: first.origin,
      kind: 'identifier',
      username: 'synthetic-account@example.test',
      usernameSelector: first.fields[0].selector,
      submitSelector: first.submitSelector,
    });
    await delay(1);
    await assert.rejects(computer.screenshot('login'), /paused/);
    await identifier;
    const password = await computer.inspectLogin('login');
    assert.deepEqual(
      password.fields.map((field) => field.kind),
      ['password'],
    );
    await computer.injectCredentials({
      threadId: 'login',
      origin: password.origin,
      kind: 'password',
      password: 'synthetic-password',
      passwordSelector: password.fields[0].selector,
      submitSelector: password.submitSelector,
    });
    const challenge = fixture.pages.get('login')?.input;
    assert.ok(challenge);
    challenge.autocomplete = '';
    challenge.name = '';
    challenge.setAttribute('aria-label', 'Please enter the code here');
    const otp = await computer.inspectLogin('login');
    assert.deepEqual(
      otp.fields.map((field) => field.kind),
      ['otp'],
    );
    await computer.injectCredentials({
      threadId: 'login',
      origin: otp.origin,
      kind: 'otp',
      code: '739204',
      passwordSelector: otp.fields[0].selector,
      submitSelector: otp.submitSelector,
    });
    assert.equal(fixture.pages.get('login')?.stage, 'complete');
    const observation = await computer.act('login', { action: 'snapshot' });
    const screen = await computer.screenshot('login');
    for (const secret of ['synthetic-account@example.test', 'synthetic-password', '739204']) {
      assert.equal(JSON.stringify(observation).includes(secret), false);
      assert.equal(screen?.includes(Buffer.from(secret)), false);
    }
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a signed-in job search box is not a sign-in field', () => {
  const dom = new JSDOM(
    '<main><h1>Jobs</h1><input aria-label="Search" placeholder="Search jobs"></main><footer>Sign in</footer>',
    { url: 'https://www.example.com/company/jobs/', runScripts: 'outside-only' },
  );
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rect = new dom.window.DOMRect(0, 0, 30, 30);
    return Object.assign([rect], { item: (index: number) => (index === 0 ? rect : null) });
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent;
    },
  });
  try {
    const inspection = loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
    assert.equal(inspection.fields.length, 0);
    assert.equal(inspection.methods.length, 0);
  } finally {
    dom.window.close();
  }
});

test('split-code observations hide each private input value and retain unrelated numbers and refs', async () => {
  const directory = await mkdtemp('/tmp/otto-private-values-');
  const dom = new JSDOM(
    '<form class="otp"><h1>Verification</h1>' +
      Array.from(
        { length: 6 },
        (_, index) => `<input class="otp-input" aria-label="Digit ${index + 1}" maxlength="1">`,
      ).join('') +
      '<button type="button">Verify</button></form><p>Invoice 2026, 18 items</p><form><input aria-label="Seats" value="18"></form>',
    { url: 'https://1.1.1.1/login', runScripts: 'outside-only' },
  );
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rect = new dom.window.DOMRect(0, 0, 30, 30);
    return Object.assign([rect], { item: (index: number) => (index === 0 ? rect : null) });
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent;
    },
  });
  const inputs = [...dom.window.document.querySelectorAll('input')];
  inputs[0].focus();
  const snapshots: string[] = [];
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: async (_executable, args, options) => {
      const command = args.slice(args.indexOf('--idle-timeout') + 2);
      let data: Record<string, unknown> = {};
      if (command[0] === 'get' && command[1] === 'url') data = { url: dom.window.location.href };
      if (command[0] === 'eval') data = { result: await dom.window.eval(options?.input ?? '') };
      if (command[0] === 'snapshot') {
        const snapshot = [
          ...inputs.map(
            (input, index) =>
              `- textbox "${input.getAttribute('aria-label')}" [ref=e${index + 1}]: ${input.value}`,
          ),
          '- button "Verify" [ref=e8]',
        ].join('\n');
        snapshots.push(snapshot);
        data = { snapshot };
      }
      if (command[0] === 'screenshot') await writeFile(command[1], 'synthetic masked frame');
      return { stdout: JSON.stringify({ success: true, data }), stderr: '', exitCode: 0 };
    },
  });
  try {
    await computer.act('fixture', { action: 'open', url: dom.window.location.href });
    const inspection = await computer.inspectLogin('fixture');
    const otp = inspection.fields.find((field) => field.kind === 'otp')!;
    assert.ok(otp);
    for (const [index, digit] of [...'137924'].entries()) inputs[index].value = digit;
    const beforeEntry = await computer.act('fixture', { action: 'snapshot' });
    assert.equal(beforeEntry.text.includes('137924'), false);
    for (let index = 0; index < 6; index++)
      assert.ok(
        beforeEntry.text.includes(`textbox "Digit ${index + 1}" [ref=e${index + 1}]: [redacted]`),
      );
    await computer.injectCredentials({
      threadId: 'fixture',
      origin: dom.window.location.origin,
      kind: 'otp',
      code: '483729',
      passwordSelector: otp.selector,
    });
    const observation = await computer.act('fixture', { action: 'snapshot' });
    assert.match(snapshots.at(-1)!, /textbox "Digit 1" \[ref=e1\]: 4/);
    assert.match(observation.text, /Invoice 2026, 18 items/);
    assert.match(observation.text, /textbox "Seats" \[ref=e7\]: 18/);
    for (let index = 0; index < 6; index++) {
      assert.ok(
        observation.text.includes(`textbox "Digit ${index + 1}" [ref=e${index + 1}]: [redacted]`),
      );
      assert.equal(inputs[index].style.color, 'transparent');
    }
    assert.deepEqual(observation.candidates, [{ id: '@e8', label: '- button "Verify" [ref=e8]' }]);
    assert.equal(observation.text.includes('483729'), false);
  } finally {
    await computer.dispose();
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a restarted credential session serves only its cached masked image without reading the page', async () => {
  const directory = await mkdtemp('/tmp/sk-sensitive-screen-');
  const fixture = stagedLoginBrowser();
  const original = createBrowserFixture({ dataRoot: directory, run: fixture.run });
  let commands = 0;
  const restored = createBrowserFixture({
    dataRoot: directory,
    run: async () => {
      commands += 1;
      throw new Error('No daemon command should run for a recovered sensitive screen.');
    },
  });
  try {
    await original.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const inspection = await original.inspectLogin('fixture');
    await original.injectCredentials({
      threadId: 'fixture',
      origin: inspection.origin,
      kind: 'identifier',
      username: 'synthetic-secret@example.test',
      usernameSelector: inspection.fields[0].selector,
      submitSelector: inspection.submitSelector,
    });
    const masked = await original.screenshot('fixture');
    assert.equal(masked?.includes(Buffer.from('synthetic-secret@example.test')), false);
    assert.deepEqual(await restored.screenshot('fixture'), masked);
    assert.equal(restored.screenStatus?.('fixture').state, 'last_known');
    assert.equal(commands, 0);
    await assert.rejects(restored.inspectLogin('fixture'), /Open the login page/);
    const metadata = await readFile(join(directory, 'runtime/screen-fixture.json'), 'utf8');
    assert.equal(metadata.includes('synthetic-secret'), false);
  } finally {
    await original.dispose();
    await restored.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

function frameFixture() {
  const page = new JSDOM('<iframe></iframe>', {
    url: 'https://example.test/',
    runScripts: 'outside-only',
  });
  const frame = page.window.document.querySelector('iframe')!;
  const document = frame.contentDocument!;
  document.body.innerHTML = '<input><p></p>';
  page.window.HTMLElement.prototype.getClientRects = () =>
    [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
  const input = document.querySelector('input')!;
  input.getClientRects = () => [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
  input.focus();
  return { page, frame, input, document };
}

test('same-origin iframe typing protects the real focused field and reflected text', () => {
  const f = frameFixture();
  try {
    assert.equal(f.page.window.eval(protectFocusedField), true);
    assert.equal(f.input.getAttribute('data-otto-manual-field'), 'true');
    const value = 'synthetic private typed text';
    f.input.value = value;
    f.document.querySelector('p')!.textContent = value;
    const result = f.page.window.eval(
      maskPageScript(['[data-otto-manual-field="true"]'], [value]),
    ) as { masked: boolean; values: string[] };
    assert.equal(result.masked, true);
    assert.ok(result.values.includes(value));
    assert.equal(f.input.style.getPropertyValue('color'), 'transparent');
    assert.equal(f.document.querySelector('p')!.style.getPropertyValue('color'), 'transparent');
  } finally {
    f.page.window.close();
  }
});

test('hidden and inaccessible iframe fields stay blocked with a native sign-in fallback', () => {
  const f = frameFixture();
  try {
    f.frame.setAttribute('inert', '');
    assert.equal(f.page.window.eval(protectFocusedField), false);
    f.frame.removeAttribute('inert');
    Object.defineProperty(f.frame, 'contentDocument', { get: () => null });
    assert.equal(f.page.window.eval(protectFocusedField), 'unsupported_frame');
    f.page.window.eval(maskPageScript([], ['synthetic value']));
    assert.equal(f.frame.style.getPropertyValue('visibility'), 'hidden');
  } finally {
    f.page.window.close();
  }
});

function desktopFixture() {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(800, 20);
  const calls: Array<{
    command: string;
    args: string[];
    options: SpawnOptions;
    input: string;
    signals: Array<NodeJS.Signals | number | undefined>;
    finish(code?: number): void;
  }> = [];
  let hold = '';
  let badCapture = false;
  let failServer = false;
  return {
    calls,
    png,
    hold(command: string) {
      hold = command;
    },
    badCapture() {
      badCapture = true;
    },
    failServer() {
      failServer = true;
    },
    spawn(command: string, args: string[], options: SpawnOptions) {
      const child = new EventEmitter();
      const stdout = new PassThrough();
      const stdin = new PassThrough();
      let finished = false;
      const call = {
        command,
        args,
        options,
        input: '',
        signals: [] as Array<NodeJS.Signals | number | undefined>,
        finish(code = 0) {
          if (finished) return;
          finished = true;
          if (command.endsWith('/ffmpeg')) stdout.write(badCapture ? Buffer.from('invalid') : png);
          if (args[0] === 'getdisplaygeometry') stdout.write('1280 800\n');
          child.emit('close', code, null);
        },
      };
      calls.push(call);
      stdin.on('data', (chunk) => {
        call.input += chunk.toString();
      });
      stdin.once('finish', () => {
        if (command !== hold) queueMicrotask(() => call.finish());
      });
      if (command.endsWith('/Xvfb') && failServer) queueMicrotask(() => call.finish(1));
      return Object.assign(child, {
        stdout,
        stdin,
        kill(signal?: NodeJS.Signals | number) {
          call.signals.push(signal);
          queueMicrotask(() => call.finish());
          return true;
        },
      }) as unknown as ChildProcess;
    },
  };
}

test('native sign-in typing sends credentials only through stdin and rejects malformed input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sk-desktop-'));
  const f = desktopFixture();
  const desktop = await createSignInDesktop({ spawn: f.spawn })(root);
  try {
    const secret = 'synthetic password --shell $(not-code)';
    await desktop.control({ action: 'type', text: secret });
    const typing = f.calls.at(-1)!;
    assert.equal(typing.command, '/usr/bin/xdotool');
    assert.deepEqual(typing.args, ['type', '--clearmodifiers', '--delay', '0', '--file', '-']);
    assert.equal(typing.input, secret);
    assert.equal(JSON.stringify(typing.args).includes(secret), false);
    assert.equal(JSON.stringify(typing.options).includes(secret), false);
    const count = f.calls.length;
    await assert.rejects(desktop.control({ action: 'click', x: -1, y: 0 }));
    await assert.rejects(desktop.control({ action: 'type', text: 'bad\0value' }));
    await assert.rejects(desktop.control({ action: 'type', text: 'x'.repeat(8193) }));
    await assert.rejects(desktop.control({ action: 'press', key: 'a' }));
    await assert.rejects(
      desktop.control({ action: 'press', key: 'a', modifiers: ['Control', 'Control'] }),
    );
    await assert.rejects(desktop.control({ action: 'wheel', deltaX: 0, deltaY: 2001 }));
    assert.equal(f.calls.length, count);
  } finally {
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Inspector secret redaction

test('inspector masks nested credentials, headers and encoded JSON before persistence', () => {
  const secret = 'fixture-provider-secret-with/slash';
  const redact = createInspectorRedactor([secret]);
  const input = {
    query: 'messages after yesterday',
    password: 'private-password',
    customHeaders: { 'X-API-Key': 'custom-api-secret' },
    headers: [{ name: 'Authorization', value: 'header-private' }, ['Cookie', 'session-private']],
    result: JSON.stringify({
      password: 'nested-password',
      cookie: 'nested-cookie',
      nested: { api_key: 'nested-api-key' },
      title: 'Useful result',
    }),
    url: `https://example.com?key=${encodeURIComponent(secret)}&q=hello`,
    text: `An opaque value: ${secret}. Another one: ${encodeURIComponent(secret)}.`,
    otp: '834192',
    card_number: '4111111111111111',
    credentials: { username: 'private-login', password: 'private-pass' },
  };
  const encoded = JSON.stringify(redact(input));
  for (const value of [
    secret,
    encodeURIComponent(secret),
    'private-password',
    'header-private',
    'session-private',
    'nested-password',
    'nested-cookie',
    'nested-api-key',
    '834192',
    '4111111111111111',
    'private-login',
    'custom-api-secret',
  ])
    assert.ok(!encoded.includes(value), value);
  assert.ok(encoded.includes('Useful result'));
  assert.ok(encoded.includes('messages after yesterday'));
  assert.ok(encoded.includes('q=hello'));
});

test('inspector masks secure links, common token strings and secret assignments in tool text', () => {
  const redact = createInspectorRedactor();
  const values = [
    'opaque-form-token',
    'opaque-approval-id',
    'oauth-code-value',
    'oauth-state-value',
    'account-password',
    'cookie-value',
    'sk-proj-abcdefghijklmnopqrstuvwxyz',
    'eyJabc.eyJdef.signature-value',
    'BEGIN PRIVATE KEY',
    'nonstandard-auth-secret',
  ];
  const result = redact([
    'Open http://localhost:4310/credentials/opaque-form-token?x=2 or /approvals/opaque-approval-id',
    'https://example.com?code=oauth-code-value&state=oauth-state-value&safe=true',
    'https://user:account-password@example.com/',
    'Cookie: cookie-value',
    'Authorization: Token nonstandard-auth-secret',
    'sk-proj-abcdefghijklmnopqrstuvwxyz eyJabc.eyJdef.signature-value',
    '-----BEGIN PRIVATE KEY-----\nfixture-private\n-----END PRIVATE KEY-----',
  ]);
  for (const value of values) assert.ok(!JSON.stringify(result).includes(value), value);
  assert.ok(JSON.stringify(result).includes('safe=true'));
  assert.equal(
    redact('Open /vault/private-bearer-token for login'),
    'Open /vault/[redacted] for login',
  );
});
