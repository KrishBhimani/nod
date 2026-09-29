import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg, { type Pool } from 'pg';
import { z } from 'zod';
import { createTakeover } from '../src/server/takeover.ts';
import { registerLocalAccess } from '../src/server/access.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const idle = (signInAvailable: boolean) => ({
  paused: false,
  active: false,
  mode: null,
  signInAvailable,
  resumable: false,
});

async function fixture(options: { signIn?: boolean } = {}) {
  let thread: { id: string; owner: string; status: string } | undefined = {
    id: randomUUID(),
    owner: 'owner',
    status: 'running',
  };
  const opened: string[] = [];
  const calls: string[] = [];
  let enabled = true;
  let failAcquire = false;
  let failRelease = false;
  let failResume = false;
  let failSignIn = false;
  let failFinish = false;
  let failFrame = false;
  let resumed = 0;
  let drain = Promise.resolve();
  let inputWait = Promise.resolve();
  let releaseWait = Promise.resolve();
  let signInWait = Promise.resolve();
  let finishWait = Promise.resolve();
  let frameWait = Promise.resolve();
  const drainEntered = deferred();
  const inputEntered = deferred();
  const releaseEntered = deferred();
  const signInEntered = deferred();
  const finishEntered = deferred();
  const frameEntered = deferred();
  const pool = {
    query: async (_query: string, values: unknown[]) => ({
      rows: thread && thread.owner === values[0] ? [{ id: thread.id, status: thread.status }] : [],
    }),
  } as unknown as Pool;
  const app = Fastify({ logger: false });
  registerLocalAccess(app, 4310);
  app.setErrorHandler((error, _request, reply) => {
    const known = error as Error & { statusCode?: number };
    reply
      .code(error instanceof z.ZodError ? 400 : (known.statusCode ?? 500))
      .send({ error: known.message });
  });
  createTakeover({
    pool,
    ownerId: 'owner',
    enabled: () => enabled,
    computer: {
      ...(options.signIn
        ? {
            openSignIn: async (id: string) => {
              calls.push('sign-in');
              opened.push(id);
              signInEntered.resolve();
              await signInWait;
              if (failSignIn) throw new Error('private sign-in failure');
            },
            signInScreenshot: async () => {
              calls.push('sign-in-frame');
              frameEntered.resolve();
              await frameWait;
              if (failFrame) throw new Error('private frame failure');
              return Buffer.from('synthetic-private-frame');
            },
            signInControl: async () => {
              calls.push('sign-in-input');
              inputEntered.resolve();
              await inputWait;
            },
            finishSignIn: async () => {
              calls.push('finish');
              finishEntered.resolve();
              await finishWait;
              if (failFinish) throw new Error('private finish failure');
            },
          }
        : {}),
      takeControl: async (id: string) => {
        calls.push('acquire');
        opened.push(id);
        if (failAcquire) throw new Error('private browser failure');
      },
      control: async () => {
        calls.push('input');
        inputEntered.resolve();
        await inputWait;
      },
      releaseControl: async () => {
        calls.push('release');
        releaseEntered.resolve();
        await releaseWait;
        if (failRelease) throw new Error('private release failure');
      },
    },
    pause: async () => {
      calls.push('pause');
      thread ??= { id: randomUUID(), owner: 'owner', status: 'idle' };
      thread.status = 'manual_control';
      return { threadId: thread.id };
    },
    resume: async () => {
      calls.push('resume');
      if (failResume || thread?.status !== 'manual_control')
        throw Object.assign(new Error('Resume failed.'), { statusCode: 409 });
      thread.status = 'idle';
      resumed++;
      return { ok: true };
    },
    waitForThread: async () => {
      calls.push('drain');
      drainEntered.resolve();
      await drain;
    },
  }).registerRoutes(app);
  const request = (suffix: string, body?: unknown, core = false) =>
    app.inject({
      method: body === undefined ? 'GET' : 'POST',
      url: `/api/${core ? 'browser' : 'inspector'}/control${suffix}`,
      headers: { host: 'localhost:4310' },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  return {
    app,
    calls,
    opened,
    request,
    coreRequest: (suffix: string, body?: unknown) => request(suffix, body, true),
    thread: () => thread,
    reset: () => {
      thread = { id: randomUUID(), owner: 'owner', status: 'idle' };
    },
    remove: () => {
      thread = undefined;
    },
    resumed: () => resumed,
    frameEntered: frameEntered.promise,
    drainEntered: drainEntered.promise,
    inputEntered: inputEntered.promise,
    releaseEntered: releaseEntered.promise,
    signInEntered: signInEntered.promise,
    finishEntered: finishEntered.promise,
    setFrame: (value: Promise<void>) => {
      frameWait = value;
    },
    setFrameFailure: (value: boolean) => {
      failFrame = value;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setAcquireFailure: (value: boolean) => {
      failAcquire = value;
    },
    setReleaseFailure: (value: boolean) => {
      failRelease = value;
    },
    setResumeFailure: (value: boolean) => {
      failResume = value;
    },
    setSignInFailure: (value: boolean) => {
      failSignIn = value;
    },
    setFinishFailure: (value: boolean) => {
      failFinish = value;
    },
    setDrain: (value: Promise<void>) => {
      drain = value;
    },
    setInput: (value: Promise<void>) => {
      inputWait = value;
    },
    setRelease: (value: Promise<void>) => {
      releaseWait = value;
    },
    setSignIn: (value: Promise<void>) => {
      signInWait = value;
    },
    setFinish: (value: Promise<void>) => {
      finishWait = value;
    },
  };
}

test('takeover drains agent work before acquiring and serializes input before resume', async () => {
  const f = await fixture();
  try {
    const drain = deferred();
    f.setDrain(drain.promise);
    const start = f.request('/start', {});
    await f.drainEntered;
    assert.deepEqual(f.calls, ['pause', 'drain']);
    drain.resolve();
    const started = await start;
    assert.equal(started.statusCode, 200);
    assert.deepEqual(started.json(), { mode: 'manual', resumable: true });
    assert.deepEqual(f.opened, [f.thread()!.id]);
    assert.deepEqual((await f.request('')).json(), {
      paused: true,
      active: true,
      mode: 'manual',
      signInAvailable: false,
      resumable: true,
    });
    const input = deferred();
    f.setInput(input.promise);
    const typing = f.request('/input', { input: { action: 'type', text: 'synthetic secret' } });
    const resume = f.request('/resume', {});
    await f.inputEntered;
    assert.deepEqual(f.calls, ['pause', 'drain', 'acquire', 'input']);
    input.resolve();
    assert.equal((await typing).statusCode, 200);
    assert.equal((await resume).statusCode, 200);
    assert.deepEqual(f.calls, ['pause', 'drain', 'acquire', 'input', 'release', 'resume']);
    assert.equal(f.resumed(), 1);
    assert.deepEqual((await f.request('')).json(), idle(false));
    assert.equal(
      (await f.request('/input', { input: { action: 'press', key: 'Enter' } })).statusCode,
      409,
    );
  } finally {
    await f.app.close();
  }
});

test('takeover checks inspector access, an open session and bounded inputs', async () => {
  const f = await fixture();
  try {
    f.setEnabled(false);
    assert.equal((await f.request('/start', {})).statusCode, 404);
    assert.equal((await f.request('')).statusCode, 404);
    f.setEnabled(true);
    assert.equal(f.calls.length, 0);
    assert.equal(
      (await f.request('/input', { input: { action: 'press', key: 'Enter' } })).statusCode,
      409,
    );
    assert.equal((await f.request('/resume', {})).statusCode, 409);
    await f.request('/start', {});
    for (const input of [
      { action: 'click', x: -0.1, y: 0 },
      { action: 'click', x: 0, y: 1.1 },
      { action: 'type', text: 'x'.repeat(8193) },
      { action: 'press', key: 'Meta+L' },
      { action: 'scroll', direction: 'left' },
      { action: 'type', text: 'valid', extra: 'secret' },
    ])
      assert.equal((await f.request('/input', { input })).statusCode, 400);
    assert.equal(f.calls.includes('input'), false);
    assert.equal(f.calls.includes('resume'), false);
  } finally {
    await f.app.close();
  }
});

test('takeover rejects caller-supplied destinations and extra control fields', async () => {
  const f = await fixture({ signIn: true });
  try {
    assert.equal((await f.coreRequest('/start', { url: 'https://example.test' })).statusCode, 400);
    assert.equal(
      (await f.coreRequest('/sign-in', { url: 'https://example.test' })).statusCode,
      400,
    );
    assert.equal(f.calls.length, 0);
    assert.equal((await f.coreRequest('/start', {})).statusCode, 200);
    assert.equal(
      (
        await f.coreRequest('/input', {
          input: { action: 'press', key: 'Enter' },
          url: 'https://example.test',
        })
      ).statusCode,
      400,
    );
    assert.equal((await f.coreRequest('/resume', { url: 'https://example.test' })).statusCode, 400);
    assert.equal(f.calls.includes('sign-in-input'), false);
    assert.equal(f.calls.includes('resume'), false);
  } finally {
    await f.app.close();
  }
});

test('failed acquire or resume stays paused, permits retry and never returns provider errors', async () => {
  const f = await fixture();
  try {
    f.setAcquireFailure(true);
    const failed = await f.request('/start', {});
    assert.equal(failed.statusCode, 409);
    assert.equal(failed.body.includes('private browser'), false);
    assert.deepEqual((await f.request('')).json(), {
      paused: true,
      active: false,
      mode: null,
      signInAvailable: false,
      resumable: true,
    });
    f.setAcquireFailure(false);
    assert.equal((await f.request('/start', {})).statusCode, 200);
    f.setReleaseFailure(true);
    const releaseFailed = await f.request('/resume', {});
    assert.equal(releaseFailed.statusCode, 409);
    assert.equal(releaseFailed.body.includes('private release'), false);
    assert.equal(f.thread()!.status, 'manual_control');
    f.setReleaseFailure(false);
    f.setResumeFailure(true);
    assert.equal((await f.request('/resume', {})).statusCode, 409);
    assert.deepEqual((await f.request('')).json(), {
      paused: true,
      active: false,
      mode: null,
      signInAvailable: false,
      resumable: true,
    });
    f.setResumeFailure(false);
    assert.equal((await f.request('/resume', {})).statusCode, 200);
    assert.equal(f.resumed(), 1);
  } finally {
    await f.app.close();
  }
});

test('a thread reset during draining releases the opened browser and fails the start', async () => {
  const f = await fixture();
  try {
    const drain = deferred();
    f.setDrain(drain.promise);
    const start = f.request('/start', {});
    await f.drainEntered;
    const paused = f.thread()!.id;
    f.reset();
    drain.resolve();
    assert.equal((await start).statusCode, 409);
    assert.deepEqual(f.opened, [paused]);
    assert.ok(f.calls.includes('release'));
    assert.deepEqual((await f.request('')).json(), idle(false));
    assert.equal(f.resumed(), 0);
  } finally {
    await f.app.close();
  }
});

test(
  'stale control cleanup releases the adapter before reacquisition and cannot release its replacement',
  { timeout: 3000 },
  async () => {
    const f = await fixture();
    try {
      assert.equal((await f.request('/start', {})).statusCode, 200);
      f.reset();
      const release = deferred();
      f.setRelease(release.promise);
      const expired = f.request('');
      await f.releaseEntered;
      const restart = f.request('/start', {});
      assert.equal(f.calls.filter((call) => call === 'acquire').length, 1);
      release.resolve();
      assert.deepEqual((await expired).json(), idle(false));
      assert.equal((await restart).statusCode, 200);
      assert.deepEqual((await f.request('')).json(), {
        paused: true,
        active: true,
        mode: 'manual',
        signInAvailable: false,
        resumable: true,
      });
      assert.equal(f.opened.at(-1), f.thread()!.id);
      assert.equal(f.calls.filter((call) => call === 'release').length, 1);
      assert.equal((await f.request('')).json().active, true);
    } finally {
      await f.app.close();
    }
  },
);

test('reset, missing and externally resumed threads release stale control, with retry after release failure', async () => {
  for (const change of ['reset', 'missing', 'resumed']) {
    const f = await fixture();
    try {
      await f.request('/start', {});
      if (change === 'reset') f.reset();
      else if (change === 'missing') f.remove();
      else f.thread()!.status = 'idle';
      f.setReleaseFailure(true);
      const failed = await f.request('');
      assert.equal(failed.statusCode, 409);
      assert.equal(failed.body.includes('private release'), false);
      f.setReleaseFailure(false);
      const status = await f.request('');
      assert.equal(status.statusCode, 200);
      assert.deepEqual(status.json(), idle(false));
      assert.equal(f.calls.filter((call) => call === 'release').length, 2);
      await f.request('');
      assert.equal(f.calls.filter((call) => call === 'release').length, 2);
    } finally {
      await f.app.close();
    }
  }
});

test('browser sign-in drains work, uses private desktop input and restores the browser before resuming', async () => {
  const f = await fixture({ signIn: true });
  try {
    const drain = deferred();
    f.setDrain(drain.promise);
    const start = f.request('/sign-in', {});
    await f.drainEntered;
    assert.deepEqual(f.calls, ['pause', 'drain']);
    drain.resolve();
    assert.deepEqual((await start).json(), { mode: 'sign_in', resumable: true });
    assert.deepEqual((await f.request('')).json(), {
      paused: true,
      active: true,
      mode: 'sign_in',
      signInAvailable: true,
      resumable: true,
    });
    assert.equal(
      (await f.request('/input', { input: { action: 'type', text: 'private' } })).statusCode,
      200,
    );
    assert.equal(f.calls.includes('input'), false);
    const finish = deferred();
    f.setFinish(finish.promise);
    const resume = f.request('/resume', {});
    await f.finishEntered;
    assert.deepEqual(f.calls, ['pause', 'drain', 'sign-in', 'sign-in-input', 'finish']);
    finish.resolve();
    assert.equal((await resume).statusCode, 200);
    assert.deepEqual(f.calls, [
      'pause',
      'drain',
      'sign-in',
      'sign-in-input',
      'finish',
      'release',
      'resume',
    ]);
    assert.equal((await f.request('')).json().mode, null);
  } finally {
    await f.app.close();
  }
});

test('browser sign-in rejects unavailable adapters and cross-site access', async () => {
  for (const available of [false, true]) {
    const f = await fixture({ signIn: available });
    try {
      assert.equal((await f.request('')).json().signInAvailable, available);
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/browser/control/start',
            headers: { host: 'localhost:4310', origin: 'https://external.test' },
            payload: {},
          })
        ).statusCode,
        403,
      );
      assert.equal(f.calls.length, 0);
      if (!available) {
        assert.equal((await f.request('/sign-in', {})).statusCode, 409);
        assert.equal(f.calls.length, 0);
      }
      f.setEnabled(false);
      assert.equal((await f.request('/sign-in', {})).statusCode, 404);
      assert.equal(f.calls.length, 0);
    } finally {
      await f.app.close();
    }
  }
});

test('failed sign-in opening or browser restoration stays paused with a retryable public error', async () => {
  const f = await fixture({ signIn: true });
  try {
    f.setSignInFailure(true);
    const failedOpen = await f.request('/sign-in', {});
    assert.equal(failedOpen.statusCode, 409);
    assert.equal(failedOpen.body.includes('private'), false);
    assert.equal((await f.request('')).json().active, false);
    assert.equal(f.thread()!.status, 'manual_control');
    assert.deepEqual(f.calls, ['pause', 'drain', 'sign-in', 'release']);
    f.setSignInFailure(false);
    assert.equal((await f.request('/sign-in', {})).statusCode, 200);
    f.setFinishFailure(true);
    const failedFinish = await f.request('/resume', {});
    assert.equal(failedFinish.statusCode, 409);
    assert.equal(failedFinish.body.includes('private'), false);
    assert.equal((await f.request('')).json().mode, 'sign_in');
    assert.equal(f.calls.includes('resume'), false);
    f.setFinishFailure(false);
    assert.equal((await f.request('/resume', {})).statusCode, 200);
    assert.equal(f.resumed(), 1);
  } finally {
    await f.app.close();
  }
});

test('a reset thread closes its sign-in session without restoring an automated browser', async () => {
  const f = await fixture({ signIn: true });
  try {
    assert.equal((await f.request('/sign-in', {})).statusCode, 200);
    f.reset();
    const state = await f.request('');
    assert.equal(state.json().active, false);
    assert.equal(state.json().mode, null);
    assert.deepEqual(f.calls, ['pause', 'drain', 'sign-in', 'release']);
    await f.request('');
    assert.equal(f.calls.filter((call) => call === 'release').length, 1);
  } finally {
    await f.app.close();
  }
});

test('a reset during native opening or restoration cannot resume the new thread', async () => {
  for (const operation of ['open', 'finish']) {
    const f = await fixture({ signIn: true });
    try {
      const gate = deferred();
      if (operation === 'open') f.setSignIn(gate.promise);
      else {
        await f.request('/sign-in', {});
        f.setFinish(gate.promise);
      }
      const pending = operation === 'open' ? f.request('/sign-in', {}) : f.request('/resume', {});
      await (operation === 'open' ? f.signInEntered : f.finishEntered);
      f.reset();
      gate.resolve();
      assert.equal((await pending).statusCode, 409);
      assert.equal(f.calls.includes('release'), true);
      assert.equal(f.resumed(), 0);
      assert.equal(f.thread()!.status, 'idle');
      assert.equal((await f.request('')).json().active, false);
    } finally {
      await f.app.close();
    }
  }
});

test('stale sign-in cleanup completes before opening its replacement', async () => {
  const f = await fixture({ signIn: true });
  try {
    await f.request('/sign-in', {});
    f.reset();
    const release = deferred();
    f.setRelease(release.promise);
    const state = f.request('');
    await f.releaseEntered;
    const restart = f.request('/sign-in', {});
    assert.equal(f.calls.filter((call) => call === 'sign-in').length, 1);
    release.resolve();
    assert.equal((await state).json().active, false);
    assert.equal((await restart).statusCode, 200);
    assert.equal((await f.request('')).json().mode, 'sign_in');
    assert.equal(f.opened.at(-1), f.thread()!.id);
    assert.equal(f.calls.filter((call) => call === 'release').length, 1);
    assert.equal(f.calls.includes('finish'), false);
  } finally {
    await f.app.close();
  }
});

test('core sign-in works without Inspector and frames require an open sign-in session', async () => {
  const f = await fixture({ signIn: true });
  try {
    f.setEnabled(false);
    assert.equal((await f.request('')).statusCode, 404);
    assert.equal((await f.coreRequest('')).json().signInAvailable, true);
    assert.equal((await f.coreRequest('/sign-in-screen')).statusCode, 409);
    const started = await f.coreRequest('/start', {});
    assert.equal(started.statusCode, 200);
    assert.equal(started.json().mode, 'sign_in');
    assert.equal((await f.coreRequest('/sign-in-screen')).statusCode, 200);
    assert.equal((await f.coreRequest('/sign-in', {})).statusCode, 200);
    const frame = await f.coreRequest('/sign-in-screen');
    assert.equal(frame.statusCode, 200);
    assert.equal(frame.headers['cache-control'], 'no-store');
    assert.equal(frame.headers['referrer-policy'], 'no-referrer');
    assert.match(String(frame.headers['content-type']), /^image\/png/);
    assert.equal(frame.body, 'synthetic-private-frame');
    for (const headers of [
      { host: 'external.test:4310' },
      { host: 'localhost:4310', origin: 'https://external.test' },
      { host: 'localhost:4310', 'sec-fetch-site': 'cross-site' },
    ]) {
      const blocked = await f.app.inject({ url: '/api/browser/control/sign-in-screen', headers });
      assert.equal(blocked.statusCode, 403);
      assert.equal(blocked.body.includes('synthetic-private-frame'), false);
    }
    assert.equal(f.calls.filter((call) => call === 'sign-in-frame').length, 2);
    f.setFrameFailure(true);
    const failed = await f.coreRequest('/sign-in-screen');
    assert.equal(failed.statusCode, 409);
    assert.equal(failed.body.includes('private frame failure'), false);
  } finally {
    await f.app.close();
  }
});

test('manual control never serves private sign-in frames', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.coreRequest('/start', {})).json().mode, 'manual');
    assert.equal((await f.coreRequest('/sign-in-screen')).statusCode, 409);
  } finally {
    await f.app.close();
  }
});

test('private frames are discarded when the thread changes during capture', async () => {
  for (const change of ['reset', 'missing', 'resumed']) {
    const f = await fixture({ signIn: true });
    try {
      await f.coreRequest('/sign-in', {});
      const gate = deferred();
      f.setFrame(gate.promise);
      const capture = f.coreRequest('/sign-in-screen');
      await f.frameEntered;
      if (change === 'reset') f.reset();
      else if (change === 'missing') f.remove();
      else f.thread()!.status = 'idle';
      gate.resolve();
      const response = await capture;
      assert.equal(response.statusCode, 409);
      assert.equal(response.body.includes('synthetic-private-frame'), false);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.ok(f.calls.includes('release'));
      assert.equal(f.calls.includes('resume'), false);
    } finally {
      await f.app.close();
    }
  }
});

test(
  'real pause and reset release manual and sign-in control without restoring or resuming',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15_000 },
  async () => {
    const schema = `test_control_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const db = await import('../src/server/db.ts');
    const thread = await import('../src/server/thread.ts');
    const { ownerId } = await import('../src/server/config.ts');
    const app = Fastify({ logger: false });
    const newerBrowser = randomUUID();
    let manualBrowser: string | undefined;
    let resumes = 0;
    let restorations = 0;
    const currentSession = () => manualBrowser ?? newerBrowser;
    createTakeover({
      pool: db.pool,
      ownerId,
      enabled: () => true,
      pause: thread.pauseForControl,
      resume: async () => {
        resumes++;
        return { ok: true };
      },
      waitForThread: async () => {},
      computer: {
        async openSignIn(id) {
          manualBrowser = id;
        },
        async signInScreenshot() {
          return Buffer.from('synthetic-frame');
        },
        async signInControl() {},
        async finishSignIn() {
          restorations++;
        },
        async takeControl(id) {
          manualBrowser = id;
        },
        async control() {},
        async releaseControl(id) {
          if (manualBrowser === id) manualBrowser = undefined;
        },
      },
    }).registerRoutes(app);
    try {
      await db.initializeDatabase();
      await thread.initializeThreadSchema();
      for (const route of ['start', 'sign-in']) {
        const active = await thread.activeThread(db.pool);
        const turnId = randomUUID();
        await db.pool.query(
          "INSERT INTO turns(id,owner_id,thread_id,source,prompt,channel,status) VALUES($1,$2,$3,'user','Browser fixture','web','running')",
          [turnId, ownerId, active.id],
        );
        await db.pool.query("UPDATE threads SET status='running' WHERE id=$1", [active.id]);
        const endpoint = '/api/inspector/control';
        const start = await app.inject({
          method: 'POST',
          url: `${endpoint}/${route}`,
          payload: {},
        });
        assert.equal(start.statusCode, 200);
        assert.equal(currentSession(), active.id);
        const paused = await db.pool.query('SELECT status FROM threads WHERE id=$1', [active.id]);
        assert.equal(paused.rows[0].status, 'manual_control');
        assert.equal(
          (await db.pool.query('SELECT status FROM turns WHERE id=$1', [turnId])).rows[0].status,
          'cancelled',
        );
        assert.equal((await app.inject(endpoint)).json().active, true);
        const reset = await thread.resetThread();
        assert.notEqual(reset.threadId, active.id);
        const status = await app.inject(endpoint);
        assert.deepEqual(status.json(), idle(true));
        assert.equal(currentSession(), newerBrowser);
        assert.equal(
          (await app.inject({ method: 'POST', url: `${endpoint}/resume`, payload: {} })).statusCode,
          409,
        );
      }
      assert.equal(resumes, 0);
      assert.equal(restorations, 0);
    } finally {
      await app.close();
      await db.pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

for (const signIn of [false, true]) {
  test(`a reset while ${signIn ? 'sign-in' : 'manual'} input is pending rejects late success`, async () => {
    const f = await fixture({ signIn });
    const held = deferred();
    try {
      assert.equal((await f.coreRequest('/start', {})).statusCode, 200);
      f.setInput(held.promise);
      const pending = f.coreRequest('/input', {
        input: { action: 'type', text: 'Synthetic input' },
      });
      await f.inputEntered;
      f.reset();
      held.resolve();
      const response = await pending;
      assert.equal(response.statusCode, 409);
      assert.match(response.json().error, /no longer active/);
      assert.ok(f.calls.includes('release'));
      assert.equal(f.resumed(), 0);
      assert.deepEqual((await f.coreRequest('')).json(), idle(signIn));
    } finally {
      held.resolve();
      await f.app.close();
    }
  });
}
