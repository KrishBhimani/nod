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
async function fixture(options: { signIn?: boolean } = {}) {
  const taskId = randomUUID();
  const foreignId = randomUUID();
  const rows = new Map<
    string,
    { owner: string; status: string; revision: number; waiting_reason: string | null }
  >([
    [
      taskId,
      { owner: 'owner', status: 'running', revision: 0, waiting_reason: null as string | null },
    ],
    [
      foreignId,
      { owner: 'other', status: 'running', revision: 0, waiting_reason: null as string | null },
    ],
  ]);
  const calls: string[] = [];
  let enabled = true;
  let failAcquire = false;
  let failClose = false;
  let failRelease = false;
  let failResume = false;
  let failSignIn = false;
  let failFinish = false;
  let failFrame = false;
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
    query: async (_query: string, values: unknown[]) => {
      const row = rows.get(String(values[0]));
      return { rows: row?.owner === values[1] ? [{ ...row }] : [] };
    },
  } as unknown as Pool;
  const app = Fastify({ logger: false });
  registerLocalAccess(app, 4310);
  app.setErrorHandler((error, _request, reply) => {
    const known = error as Error & { statusCode?: number };
    reply
      .code(error instanceof z.ZodError ? 400 : (known.statusCode ?? 500))
      .send({ error: known.message });
  });
  const dependencies = {
    pool,
    ownerId: 'owner',
    enabled: () => enabled,
    computer: {
      close: async () => {
        calls.push('close');
        if (failClose) throw new Error('private close failure');
      },
      ...(options.signIn
        ? {
            openSignIn: async () => {
              calls.push('sign-in');
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
      takeControl: async () => {
        calls.push('acquire');
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
    pause: async (id: string) => {
      calls.push('pause');
      const row = rows.get(id)!;
      if (row.waiting_reason !== 'manual_control') row.revision++;
      row.status = 'waiting_user';
      row.waiting_reason = 'manual_control';
      return { revision: row.revision };
    },
    resume: async (id: string, revision: number) => {
      calls.push('resume');
      if (failResume) throw Object.assign(new Error('Resume failed.'), { statusCode: 409 });
      const row = rows.get(id)!;
      assert.equal(row.revision, revision);
      row.status = 'queued';
      row.waiting_reason = null;
      row.revision++;
      return { ok: true };
    },
    waitForTask: async () => {
      calls.push('drain');
      drainEntered.resolve();
      await drain;
    },
  };
  createTakeover(dependencies).registerRoutes(app);
  const request = (suffix: string, body?: unknown, id: string = taskId, core = false) =>
    app.inject({
      method: body === undefined ? 'GET' : 'POST',
      url: `/api/${core ? 'browser' : 'inspector'}/control/${id}${suffix}`,
      headers: { host: 'localhost:4310' },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  return {
    app,
    taskId,
    foreignId,
    rows,
    calls,
    request,
    coreRequest: (suffix: string, body?: unknown, id: string = taskId) =>
      request(suffix, body, id, true),
    frameEntered: frameEntered.promise,
    setFrame: (value: Promise<void>) => {
      frameWait = value;
    },
    setFrameFailure: (value: boolean) => {
      failFrame = value;
    },
    drainEntered: drainEntered.promise,
    inputEntered: inputEntered.promise,
    releaseEntered: releaseEntered.promise,
    signInEntered: signInEntered.promise,
    finishEntered: finishEntered.promise,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setCloseFailure: (value: boolean) => {
      failClose = value;
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
    assert.deepEqual(started.json(), { revision: 1, mode: 'manual', resumable: true });
    assert.deepEqual((await f.request('')).json(), {
      paused: true,
      active: true,
      revision: 1,
      mode: 'manual',
      signInAvailable: false,
      resumable: true,
    });
    const input = deferred();
    f.setInput(input.promise);
    const typing = f.request('/input', {
      revision: 1,
      input: { action: 'type', text: 'synthetic secret' },
    });
    const resume = f.request('/resume', { revision: 1 });
    await f.inputEntered;
    assert.deepEqual(f.calls, ['pause', 'drain', 'acquire', 'input']);
    input.resolve();
    assert.equal((await typing).statusCode, 200);
    assert.equal((await resume).statusCode, 200);
    assert.deepEqual(f.calls, ['pause', 'drain', 'acquire', 'input', 'release', 'resume']);
    assert.deepEqual((await f.request('')).json(), {
      paused: false,
      active: false,
      revision: null,
      mode: null,
      signInAvailable: false,
      resumable: true,
    });
    assert.equal(
      (await f.request('/input', { revision: 1, input: { action: 'press', key: 'Enter' } }))
        .statusCode,
      409,
    );
  } finally {
    await f.app.close();
  }
});

test('takeover checks inspector access, ownership, exact revisions and bounded inputs', async () => {
  const f = await fixture();
  try {
    f.setEnabled(false);
    assert.equal((await f.request('/start', {})).statusCode, 404);
    f.setEnabled(true);
    assert.equal((await f.request('/start', {}, f.foreignId)).statusCode, 404);
    assert.equal((await f.request('', undefined, randomUUID())).statusCode, 404);
    assert.equal(f.calls.length, 0);
    await f.request('/start', {});
    for (const input of [
      { action: 'click', x: -0.1, y: 0 },
      { action: 'click', x: 0, y: 1.1 },
      { action: 'type', text: 'x'.repeat(8193) },
      { action: 'press', key: 'Meta+L' },
      { action: 'scroll', direction: 'left' },
      { action: 'type', text: 'valid', extra: 'secret' },
    ])
      assert.equal((await f.request('/input', { revision: 1, input })).statusCode, 400);
    assert.equal(
      (await f.request('/input', { revision: 0, input: { action: 'press', key: 'Enter' } }))
        .statusCode,
      409,
    );
    f.rows.get(f.taskId)!.revision++;
    assert.equal((await f.request('/resume', { revision: 1 })).statusCode, 409);
    assert.equal(f.calls.includes('input'), false);
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
      revision: 1,
      mode: null,
      signInAvailable: false,
      resumable: true,
    });
    f.setAcquireFailure(false);
    assert.equal((await f.request('/start', {})).statusCode, 200);
    f.setReleaseFailure(true);
    assert.equal((await f.request('/resume', { revision: 1 })).statusCode, 409);
    assert.equal(f.rows.get(f.taskId)!.status, 'waiting_user');
    f.setReleaseFailure(false);
    f.setResumeFailure(true);
    assert.equal((await f.request('/resume', { revision: 1 })).statusCode, 409);
    assert.deepEqual((await f.request('')).json(), {
      paused: true,
      active: false,
      revision: 1,
      mode: null,
      signInAvailable: false,
      resumable: true,
    });
    f.setResumeFailure(false);
    assert.equal((await f.request('/resume', { revision: 1 })).statusCode, 200);
  } finally {
    await f.app.close();
  }
});

test('a task revision changed during draining cannot acquire browser control', async () => {
  const f = await fixture();
  try {
    const drain = deferred();
    f.setDrain(drain.promise);
    const start = f.request('/start', {});
    await f.drainEntered;
    const row = f.rows.get(f.taskId)!;
    row.status = 'cancelled';
    row.revision++;
    drain.resolve();
    assert.equal((await start).statusCode, 409);
    assert.equal(f.calls.includes('acquire'), false);
  } finally {
    await f.app.close();
  }
});

test(
  'stale lease cleanup releases the adapter before reacquisition and cannot release its replacement',
  { timeout: 3000 },
  async () => {
    const f = await fixture();
    try {
      assert.equal((await f.request('/start', {})).statusCode, 200);
      f.rows.get(f.taskId)!.revision++;
      const release = deferred();
      f.setRelease(release.promise);
      const expired = f.request('');
      await f.releaseEntered;
      const restart = f.request('/start', {});
      assert.equal(f.calls.filter((call) => call === 'acquire').length, 1);
      release.resolve();
      assert.deepEqual((await expired).json(), {
        paused: true,
        active: false,
        revision: 2,
        mode: null,
        signInAvailable: false,
        resumable: true,
      });
      assert.equal((await restart).statusCode, 200);
      assert.deepEqual((await f.request('')).json(), {
        paused: true,
        active: true,
        revision: 2,
        mode: 'manual',
        signInAvailable: false,
        resumable: true,
      });
      assert.equal(
        (await f.request('/input', { revision: 1, input: { action: 'press', key: 'Enter' } }))
          .statusCode,
        409,
      );
      assert.equal(f.calls.filter((call) => call === 'release').length, 1);
      assert.equal((await f.request('')).json().active, true);
    } finally {
      await f.app.close();
    }
  },
);

test('cancelled, missing and transferred tasks release stale control, with retry after release failure', async () => {
  for (const change of ['cancelled', 'missing', 'foreign']) {
    const f = await fixture();
    try {
      await f.request('/start', {});
      const row = f.rows.get(f.taskId)!;
      if (change === 'cancelled') {
        row.status = 'cancelled';
        row.revision++;
      } else if (change === 'missing') f.rows.delete(f.taskId);
      else row.owner = 'other';
      f.setReleaseFailure(true);
      const failed = await f.request('');
      assert.equal(failed.statusCode, 409);
      assert.equal(failed.body.includes('private release'), false);
      f.setReleaseFailure(false);
      const status = await f.request('');
      assert.equal(status.statusCode, change === 'cancelled' ? 200 : 404);
      assert.equal(f.calls.filter((call) => call === 'release').length, 2);
      await f.request('');
      assert.equal(f.calls.filter((call) => call === 'release').length, 2);
    } finally {
      await f.app.close();
    }
  }
});

test('explicit takeover of a terminal task preserves its profile without resuming work', async () => {
  for (const status of ['succeeded', 'failed', 'cancelled']) {
    const f = await fixture({ signIn: true });
    try {
      await f.coreRequest('/start', {});
      const row = f.rows.get(f.taskId)!;
      row.status = status;
      row.revision++;
      assert.equal(
        (await f.coreRequest('/input', { revision: 1, input: { action: 'press', key: 'Enter' } }))
          .statusCode,
        409,
      );
      const snapshot = { ...row };
      const taken = await f.coreRequest('/start', {});
      assert.equal(taken.statusCode, 200);
      const revision = taken.json().revision;
      assert.equal(taken.json().resumable, false);
      assert.ok(Number.isSafeInteger(revision) && revision > 1);
      assert.equal((await f.coreRequest('')).json().active, true);
      assert.equal((await f.coreRequest('')).json().paused, false);
      assert.equal(
        (await f.coreRequest('/input', { revision, input: { action: 'press', key: 'Enter' } }))
          .statusCode,
        200,
      );
      assert.equal((await f.coreRequest('/resume', { revision })).statusCode, 200);
      assert.deepEqual(row, snapshot);
      assert.equal(f.calls.includes('resume'), false);
      assert.equal(f.calls.includes('finish'), true);
      assert.equal(f.calls.filter((call) => call === 'pause').length, 1);
      assert.equal(f.calls.filter((call) => call === 'sign-in').length, 2);
      assert.equal((await f.coreRequest('/sign-in-screen?revision=' + revision)).statusCode, 409);
    } finally {
      await f.app.close();
    }
  }
});

test('terminal browser control invalidates on task revision, status and ownership changes', async () => {
  for (const change of ['revision', 'status', 'owner']) {
    const f = await fixture({ signIn: true });
    try {
      const row = f.rows.get(f.taskId)!;
      row.status = 'succeeded';
      const revision = (await f.coreRequest('/start', {})).json().revision;
      if (change === 'revision') row.revision++;
      if (change === 'status') row.status = 'cancelled';
      if (change === 'owner') row.owner = 'other';
      const input = await f.coreRequest('/input', {
        revision,
        input: { action: 'press', key: 'Enter' },
      });
      assert.equal(input.statusCode, change === 'owner' ? 404 : 409);
      assert.equal(f.calls.includes('sign-in-input'), false);
      assert.equal(f.calls.includes('resume'), false);
      assert.ok(f.calls.includes('release'));
      assert.equal(
        (await f.coreRequest('/resume', { revision })).statusCode,
        change === 'owner' ? 404 : 409,
      );
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
    assert.deepEqual((await start).json(), { revision: 1, mode: 'sign_in', resumable: true });
    assert.deepEqual((await f.request('')).json(), {
      paused: true,
      active: true,
      revision: 1,
      mode: 'sign_in',
      signInAvailable: true,
      resumable: true,
    });
    assert.equal(
      (await f.request('/input', { revision: 1, input: { action: 'type', text: 'private' } }))
        .statusCode,
      200,
    );
    assert.equal(f.calls.includes('input'), false);
    const finish = deferred();
    f.setFinish(finish.promise);
    const resume = f.request('/resume', { revision: 1 });
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

test('browser sign-in rejects unavailable adapters, foreign tasks and client destinations', async () => {
  for (const available of [false, true]) {
    const f = await fixture({ signIn: available });
    try {
      assert.equal((await f.request('')).json().signInAvailable, available);
      assert.equal((await f.request('/sign-in', { url: 'https://example.test' })).statusCode, 400);
      assert.equal(f.calls.length, 0);
      assert.equal(
        (await f.request('/sign-in', {}, f.foreignId)).statusCode,
        available ? 404 : 409,
      );
      if (!available) assert.equal((await f.request('/sign-in', {})).statusCode, 409);
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
    assert.equal(f.rows.get(f.taskId)!.status, 'waiting_user');
    f.setSignInFailure(false);
    assert.equal((await f.request('/sign-in', {})).statusCode, 200);
    f.setFinishFailure(true);
    const failedFinish = await f.request('/resume', { revision: 1 });
    assert.equal(failedFinish.statusCode, 409);
    assert.equal(failedFinish.body.includes('private'), false);
    assert.equal((await f.request('')).json().mode, 'sign_in');
    assert.equal(f.calls.includes('resume'), false);
    f.setFinishFailure(false);
    assert.equal((await f.request('/resume', { revision: 1 })).statusCode, 200);
  } finally {
    await f.app.close();
  }
});

test('cancelled or expired sign-in leases close without restoring an automated browser', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const reason of ['cancelled', 'expired']) {
    const f = await fixture({ signIn: true });
    try {
      assert.equal((await f.request('/sign-in', {})).statusCode, 200);
      if (reason === 'cancelled') {
        f.rows.get(f.taskId)!.status = 'cancelled';
        f.rows.get(f.taskId)!.revision++;
      } else context.mock.timers.tick(30 * 60_000);
      const state = await f.request('');
      assert.equal(state.json().active, false);
      assert.equal(state.json().mode, null);
      assert.deepEqual(f.calls, ['pause', 'drain', 'sign-in', 'release']);
      await f.request('');
      assert.equal(f.calls.filter((call) => call === 'release').length, 1);
    } finally {
      await f.app.close();
    }
  }
});

test('cancellation during native opening or restoration cannot resume the task', async () => {
  for (const operation of ['open', 'finish']) {
    const f = await fixture({ signIn: true });
    try {
      const gate = deferred();
      if (operation === 'open') f.setSignIn(gate.promise);
      else {
        await f.request('/sign-in', {});
        f.setFinish(gate.promise);
      }
      const pending =
        operation === 'open' ? f.request('/sign-in', {}) : f.request('/resume', { revision: 1 });
      await (operation === 'open' ? f.signInEntered : f.finishEntered);
      f.rows.get(f.taskId)!.status = 'cancelled';
      f.rows.get(f.taskId)!.revision++;
      gate.resolve();
      assert.equal((await pending).statusCode, 409);
      assert.equal(f.calls.includes('release'), true);
      assert.equal(f.calls.includes('resume'), false);
      if (operation === 'finish') assert.equal(f.calls.includes('close'), true);
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
    f.rows.get(f.taskId)!.revision++;
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
    assert.equal(f.calls.filter((call) => call === 'release').length, 1);
    assert.equal(f.calls.includes('finish'), false);
  } finally {
    await f.app.close();
  }
});

test('core sign-in works without Inspector and frames require an owned exact sign-in lease', async () => {
  const f = await fixture({ signIn: true });
  try {
    f.setEnabled(false);
    assert.equal((await f.request('')).statusCode, 404);
    assert.equal((await f.coreRequest('')).json().signInAvailable, true);
    assert.equal((await f.coreRequest('/sign-in-screen?revision=0')).statusCode, 409);
    assert.equal((await f.coreRequest('/start', {})).statusCode, 200);
    assert.equal((await f.coreRequest('/sign-in-screen?revision=1')).statusCode, 200);
    assert.equal((await f.coreRequest('/sign-in', {})).statusCode, 200);
    const frame = await f.coreRequest('/sign-in-screen?revision=1');
    assert.equal(frame.statusCode, 200);
    assert.equal(frame.headers['cache-control'], 'no-store');
    assert.equal(frame.headers['referrer-policy'], 'no-referrer');
    assert.match(String(frame.headers['content-type']), /^image\/png/);
    assert.equal(frame.body, 'synthetic-private-frame');
    assert.equal((await f.coreRequest('/sign-in-screen?revision=0')).statusCode, 409);
    assert.equal(
      (await f.coreRequest('/sign-in-screen?revision=1&url=https://example.test')).statusCode,
      400,
    );
    assert.equal(
      (await f.coreRequest('/sign-in-screen?revision=1', undefined, f.foreignId)).statusCode,
      404,
    );
    assert.equal(
      (await f.coreRequest('/sign-in-screen?revision=1', undefined, 'invalid')).statusCode,
      400,
    );
    for (const headers of [
      { host: 'external.test:4310' },
      { host: 'localhost:4310', origin: 'https://external.test' },
      { host: 'localhost:4310', 'sec-fetch-site': 'cross-site' },
    ]) {
      const blocked = await f.app.inject({
        url: `/api/browser/control/${f.taskId}/sign-in-screen?revision=1`,
        headers,
      });
      assert.equal(blocked.statusCode, 403);
      assert.equal(blocked.body.includes('synthetic-private-frame'), false);
    }
    assert.equal(f.calls.filter((call) => call === 'sign-in-frame').length, 2);
    f.setFrameFailure(true);
    const failed = await f.coreRequest('/sign-in-screen?revision=1');
    assert.equal(failed.statusCode, 409);
    assert.equal(failed.body.includes('private frame failure'), false);
  } finally {
    await f.app.close();
  }
});

test('private frames are discarded when ownership, revision or lease expiry changes during capture', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const change of ['owner', 'revision', 'cancelled', 'expired']) {
    const f = await fixture({ signIn: true });
    try {
      await f.coreRequest('/sign-in', {});
      const gate = deferred();
      f.setFrame(gate.promise);
      const capture = f.coreRequest('/sign-in-screen?revision=1');
      await f.frameEntered;
      const row = f.rows.get(f.taskId)!;
      if (change === 'owner') row.owner = 'other';
      if (change === 'revision') row.revision++;
      if (change === 'cancelled') row.status = 'cancelled';
      if (change === 'expired') context.mock.timers.tick(30 * 60_000);
      gate.resolve();
      const response = await capture;
      assert.equal(response.statusCode, change === 'owner' ? 404 : 409);
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
  'real cancellation and reset release manual and sign-in leases without restoring or resuming',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15_000 },
  async () => {
    const schema = `test_control_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
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
      pause: tasks.pauseOwnedTaskForControl,
      resume: async () => {
        resumes++;
        return { ok: true };
      },
      waitForTask: async () => {},
      computer: {
        async close(id) {
          if (manualBrowser === id) manualBrowser = undefined;
        },
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
      await tasks.initializeTaskSchema();
      for (const { action, route } of [
        { action: 'cancel', route: 'start' },
        { action: 'reset', route: 'start' },
        { action: 'cancel', route: 'sign-in' },
        { action: 'reset', route: 'sign-in' },
      ]) {
        const taskId = randomUUID();
        await db.pool.query(
          "INSERT INTO tasks(id,owner_id,title,prompt,status,conversation_revision) VALUES($1,$2,'Browser fixture','Browser fixture','running',COALESCE((SELECT revision FROM conversations WHERE owner_id=$2 AND channel='web'),0))",
          [taskId, ownerId],
        );
        const endpoint = `/api/inspector/control/${taskId}`;
        const start = await app.inject({
          method: 'POST',
          url: `${endpoint}/${route}`,
          payload: {},
        });
        assert.equal(start.statusCode, 200);
        const revision = start.json().revision;
        assert.equal(currentSession(), taskId);
        if (action === 'cancel') await tasks.cancelTask(taskId);
        else await tasks.resetConversation();
        const status = await app.inject(endpoint);
        assert.deepEqual(status.json(), {
          paused: false,
          active: false,
          revision: null,
          mode: null,
          signInAvailable: true,
          resumable: false,
        });
        assert.equal(currentSession(), newerBrowser);
        assert.equal(
          (await app.inject({ method: 'POST', url: `${endpoint}/resume`, payload: { revision } }))
            .statusCode,
          409,
        );
        assert.equal(
          (await db.pool.query('SELECT status FROM tasks WHERE id=$1', [taskId])).rows[0].status,
          'cancelled',
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

test('idle workspace takeover opens a private browser without creating or resuming a task', async () => {
  const f = await fixture({ signIn: true });
  try {
    f.setEnabled(false);
    const before = [...f.rows].map(([id, row]) => [id, { ...row }]);
    const started = await f.coreRequest('/start', {}, 'workspace');
    assert.equal(started.statusCode, 200);
    const revision = started.json().revision;
    assert.ok(Number.isSafeInteger(revision));
    assert.equal(started.json().mode, 'sign_in');
    assert.equal(started.json().resumable, false);
    assert.deepEqual(f.calls, ['close', 'sign-in']);
    assert.equal(
      (await f.coreRequest('/sign-in-screen?revision=' + revision, undefined, 'workspace')).body,
      'synthetic-private-frame',
    );
    assert.equal(
      (
        await f.coreRequest(
          '/input',
          { revision, input: { action: 'type', text: 'private fixture' } },
          'workspace',
        )
      ).statusCode,
      200,
    );
    assert.equal((await f.coreRequest('/resume', { revision }, 'workspace')).statusCode, 200);
    assert.deepEqual(f.calls, [
      'close',
      'sign-in',
      'sign-in-frame',
      'sign-in-input',
      'release',
      'close',
    ]);
    assert.deepEqual([...f.rows], before);
    assert.equal((await f.coreRequest('', undefined, 'workspace')).json().active, false);
    assert.equal(
      (await f.coreRequest('/sign-in-screen?revision=' + revision, undefined, 'workspace'))
        .statusCode,
      409,
    );
    const replacement = (await f.coreRequest('/start', {}, 'workspace')).json().revision;
    assert.ok(replacement > revision);
    assert.equal(
      (
        await f.coreRequest(
          '/input',
          { revision, input: { action: 'press', key: 'Enter' } },
          'workspace',
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (await f.coreRequest('/resume', { revision: replacement }, 'workspace')).statusCode,
      200,
    );
  } finally {
    await f.app.close();
  }
});

test('workspace takeover rejects unsupported adapters, caller destinations and cross-site access', async () => {
  for (const signIn of [false, true]) {
    const f = await fixture({ signIn });
    try {
      assert.equal(
        (await f.coreRequest('/start', { url: 'https://example.test' }, 'workspace')).statusCode,
        400,
      );
      if (!signIn) assert.equal((await f.coreRequest('/start', {}, 'workspace')).statusCode, 409);
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/browser/control/workspace/start',
            headers: { host: 'localhost:4310', origin: 'https://external.test' },
            payload: {},
          })
        ).statusCode,
        403,
      );
      assert.deepEqual(f.calls, []);
    } finally {
      await f.app.close();
    }
  }
});

test('workspace takeover expiry closes private capture without starting an agent', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture({ signIn: true });
  try {
    const revision = (await f.coreRequest('/start', {}, 'workspace')).json().revision;
    context.mock.timers.tick(30 * 60_000);
    assert.equal((await f.coreRequest('', undefined, 'workspace')).json().active, false);
    assert.deepEqual(f.calls, ['close', 'sign-in', 'release', 'close']);
    assert.equal((await f.coreRequest('/resume', { revision }, 'workspace')).statusCode, 409);
  } finally {
    await f.app.close();
    context.mock.timers.reset();
  }
});

test('failed workspace reacquisition retains only the revision that actually acquired control', async () => {
  for (const failure of ['release', 'close']) {
    const f = await fixture({ signIn: true });
    try {
      const revision = (await f.coreRequest('/start', {}, 'workspace')).json().revision;
      if (failure === 'release') f.setReleaseFailure(true);
      else f.setCloseFailure(true);
      assert.equal((await f.coreRequest('/start', {}, 'workspace')).statusCode, 409);
      assert.equal((await f.coreRequest('', undefined, 'workspace')).json().revision, revision);
      assert.equal(
        (
          await f.coreRequest(
            '/input',
            { revision: revision + 1, input: { action: 'press', key: 'Enter' } },
            'workspace',
          )
        ).statusCode,
        409,
      );
      f.setReleaseFailure(false);
      f.setCloseFailure(false);
      assert.ok((await f.coreRequest('/start', {}, 'workspace')).json().revision > revision);
    } finally {
      await f.app.close();
    }
  }
});

test('a recreated takeover never accepts the prior standalone control revision', async () => {
  const previous = await fixture({ signIn: true });
  const current = await fixture({ signIn: true });
  try {
    const oldRevision = (await previous.coreRequest('/start', {}, 'workspace')).json().revision;
    const revision = (await current.coreRequest('/start', {}, 'workspace')).json().revision;
    assert.notEqual(revision, oldRevision);
    assert.equal(
      (
        await current.coreRequest(
          '/input',
          { revision: oldRevision, input: { action: 'press', key: 'Enter' } },
          'workspace',
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (await current.coreRequest('/resume', { revision: oldRevision }, 'workspace')).statusCode,
      409,
    );
    assert.equal((await current.coreRequest('', undefined, 'workspace')).json().revision, revision);
  } finally {
    await previous.app.close();
    await current.app.close();
  }
});

test('failed standalone launch closes the reserved native browser and permits a fresh acquisition', async () => {
  const f = await fixture({ signIn: true });
  try {
    f.setSignInFailure(true);
    assert.equal((await f.coreRequest('/start', {}, 'workspace')).statusCode, 409);
    assert.deepEqual(f.calls, ['close', 'sign-in', 'release', 'close']);
    assert.equal((await f.coreRequest('', undefined, 'workspace')).json().active, false);
    f.setSignInFailure(false);
    assert.equal((await f.coreRequest('/start', {}, 'workspace')).statusCode, 200);
    assert.equal(f.calls.filter((call) => call === 'sign-in').length, 2);
  } finally {
    await f.app.close();
  }
});

test('a terminal task changed while draining cannot open or close its browser', async () => {
  const f = await fixture({ signIn: true });
  try {
    const row = f.rows.get(f.taskId)!;
    row.status = 'succeeded';
    const drain = deferred();
    f.setDrain(drain.promise);
    const pending = f.coreRequest('/start', {});
    await f.drainEntered;
    assert.deepEqual(f.calls, ['drain']);
    row.status = 'queued';
    row.revision++;
    drain.resolve();
    assert.equal((await pending).statusCode, 409);
    assert.deepEqual(f.calls, ['drain']);
  } finally {
    await f.app.close();
  }
});
