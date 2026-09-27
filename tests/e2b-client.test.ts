import assert from 'node:assert/strict';
import test from 'node:test';
import { Sandbox } from 'e2b';
import { createE2BClient, type E2BCommandRole } from '../src/providers/e2b/client.ts';

test('E2B SDK configuration keeps keys server-side, blocks public traffic and bounds command transport', async (t) => {
  const calls: Array<{ action: string; args: unknown[] }> = [];
  const fake = {
    sandboxId: 'fixture-sandbox',
    commands: {
      async run(...args: unknown[]) {
        calls.push({ action: 'run', args });
        if (args[0] === 'python3 /opt/sidekick/computer-guard.py check')
          return { exitCode: 0, stdout: '{"ready":true}\n', stderr: '' };
        return {
          sendStdin: async (...args: unknown[]) => {
            calls.push({ action: 'stdin', args });
          },
          closeStdin: async (...args: unknown[]) => {
            calls.push({ action: 'eof', args });
          },
          wait: async () => ({ exitCode: 0 }),
          disconnect: async () => {},
        };
      },
    },
    setTimeout: async (...args: unknown[]) => {
      calls.push({ action: 'timeout', args });
    },
    pause: async (...args: unknown[]) => {
      calls.push({ action: 'pause', args });
      return true;
    },
  };
  t.mock.method(Sandbox, 'create', async (...args: unknown[]) => {
    calls.push({ action: 'create', args });
    return fake;
  });
  t.mock.method(Sandbox, 'connect', async (...args: unknown[]) => {
    calls.push({ action: 'connect', args });
    return fake;
  });
  const client = createE2BClient({
    apiKey: 'synthetic-server-key',
    requestTimeoutMs: 1234,
    sandboxTimeoutMs: 60_000,
  });
  const sandbox = await client.create('computer-template', { role: 'computer' });
  assert.equal(sandbox.id, 'fixture-sandbox');
  const created = calls.find((call) => call.action === 'create')!.args[1] as Record<
    string,
    unknown
  >;
  assert.deepEqual(created.network, { allowPublicTraffic: false });
  assert.deepEqual(created.envs, {});
  assert.deepEqual(created.lifecycle, { onTimeout: 'pause', autoResume: false });
  assert.equal(created.apiKey, 'synthetic-server-key');
  assert.equal('retries' in created, false);
  await sandbox.ready();
  assert.deepEqual(calls.find((call) => call.action === 'run')!.args, [
    'python3 /opt/sidekick/computer-guard.py check',
    { user: 'root', envs: {}, timeoutMs: 30_000, requestTimeoutMs: 1234 },
  ]);
  const command = await sandbox.start({
    role: 'browser',
    command: 'fixed-command',
    stdout: () => {},
    stderr: () => {},
  });
  const started = calls.find((call) => call.args[0] === 'fixed-command')!.args[1] as Record<
    string,
    unknown
  >;
  assert.equal(started.user, 'sidekick-browser');
  assert.equal(started.stdin, true);
  assert.equal(started.background, true);
  assert.equal(started.requestTimeoutMs, 1234);
  assert.equal(started.timeoutMs, 180_000);
  assert.deepEqual(started.envs, {});
  assert.equal(JSON.stringify(started).includes('synthetic-server-key'), false);
  await command.sendStdin(Buffer.from('synthetic private input'));
  await command.closeStdin();
  await command.wait();
  await sandbox.start({
    role: 'workspace',
    command: 'fixed-workspace',
    stdout: () => {},
    stderr: () => {},
  });
  const workspace = calls.find((call) => call.args[0] === 'fixed-workspace')!.args[1] as Record<
    string,
    unknown
  >;
  assert.equal(workspace.user, 'node');
  assert.deepEqual(workspace.envs, {});
  const beforeInvalid = calls.length;
  await assert.rejects(
    sandbox.start({
      role: 'root' as E2BCommandRole,
      command: 'forbidden',
      stdout: () => {},
      stderr: () => {},
    }),
    /invalid/,
  );
  assert.equal(calls.length, beforeInvalid);
  await sandbox.keepAlive();
  await sandbox.pause();
  await client.connect('fixture-sandbox');
  assert.deepEqual(calls.find((call) => call.action === 'connect')!.args, [
    'fixture-sandbox',
    {
      apiKey: 'synthetic-server-key',
      requestTimeoutMs: 1234,
      timeoutMs: 60_000,
      onResume: 'restore',
    },
  ]);
  assert.equal('getHost' in sandbox, false);
  assert.equal('trafficAccessToken' in sandbox, false);
});

test('E2B disposable acceptance can disable control-plane retries without replaying failures', async (t) => {
  const calls: Array<{ action: string; options: Record<string, unknown> }> = [];
  const failure = new Error('Synthetic provider throttling');
  for (const action of ['create', 'connect'] as const) {
    t.mock.method(Sandbox, action, async (_id: string, options: Record<string, unknown>) => {
      calls.push({ action, options });
      throw failure;
    });
  }
  const client = createE2BClient({ apiKey: 'synthetic-key', retries: 0 });
  await assert.rejects(client.create('synthetic-template', {}), (error) => error === failure);
  await assert.rejects(client.connect('synthetic-resource'), (error) => error === failure);
  assert.deepEqual(
    calls.map(({ action, options }) => ({ action, retries: options.retries })),
    [
      { action: 'create', retries: 0 },
      { action: 'connect', retries: 0 },
    ],
  );
});

test('E2B readiness refuses missing, malformed or failed protected-computer proof with fixed errors', async (t) => {
  let result: unknown;
  let failure = false;
  const fake = {
    sandboxId: 'synthetic',
    commands: {
      async run() {
        if (failure) throw new Error('synthetic provider secret');
        return result;
      },
    },
  };
  t.mock.method(Sandbox, 'create', async () => fake);
  const sandbox = await createE2BClient({ apiKey: 'synthetic-key' }).create('computer', {});
  for (const value of [
    undefined,
    { exitCode: 1, stdout: '{"ready":true}\n', stderr: '' },
    { exitCode: 0, stdout: '{"ready":false}\n', stderr: '' },
    { exitCode: 0, stdout: '{"ready":true}\nextra', stderr: '' },
    { exitCode: 0, stdout: '{"ready":true}\n', stderr: 'synthetic private detail' },
  ]) {
    result = value;
    await assert.rejects(sandbox.ready(), {
      message: 'The remote computer did not pass its readiness check.',
    });
  }
  failure = true;
  await assert.rejects(sandbox.ready(), {
    message: 'The remote computer did not pass its readiness check.',
  });
});
