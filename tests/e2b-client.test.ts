import assert from 'node:assert/strict';
import test from 'node:test';
import { Sandbox } from 'e2b';
import { createE2BClient } from '../src/providers/e2b/client.ts';

test('E2B SDK configuration keeps keys server-side, blocks public traffic and bounds command transport', async (t) => {
  const calls: Array<{ action: string; args: unknown[] }> = [];
  const fake = {
    sandboxId: 'fixture-sandbox',
    commands: {
      async run(...args: unknown[]) {
        calls.push({ action: 'run', args });
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
  const sandbox = await client.create('browser-template', { role: 'browser' });
  assert.equal(sandbox.id, 'fixture-sandbox');
  const created = calls.find((call) => call.action === 'create')!.args[1] as Record<
    string,
    unknown
  >;
  assert.deepEqual(created.network, { allowPublicTraffic: false });
  assert.deepEqual(created.envs, {});
  assert.deepEqual(created.lifecycle, { onTimeout: 'pause', autoResume: false });
  assert.equal(created.apiKey, 'synthetic-server-key');
  const command = await sandbox.start({
    command: 'fixed-command',
    stdout: () => {},
    stderr: () => {},
  });
  const started = calls.find((call) => call.action === 'run')!.args[1] as Record<string, unknown>;
  assert.equal(started.user, 'node');
  assert.equal(started.stdin, true);
  assert.equal(started.background, true);
  assert.equal(started.requestTimeoutMs, 1234);
  assert.equal(started.timeoutMs, 180_000);
  assert.deepEqual(started.envs, {});
  assert.equal(JSON.stringify(started).includes('synthetic-server-key'), false);
  await command.sendStdin(Buffer.from('synthetic private input'));
  await command.closeStdin();
  await command.wait();
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
