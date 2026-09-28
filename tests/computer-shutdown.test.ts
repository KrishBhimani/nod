import assert from 'node:assert/strict';
import test from 'node:test';
import { createComputerShutdownConfirmation } from '../src/providers/runtime-host/computer-shutdown.ts';

test('computer shutdown acknowledgement binds the fixed private endpoint and immutable generation', async () => {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const input = {
    endpoint: 'http://otto.computer/v1/stopped',
    generation: '12',
    fetch: (async (url, options) => {
      calls.push({ url: String(url), options: options! });
      return Response.json({ ok: true });
    }) as typeof fetch,
  };
  const confirm = createComputerShutdownConfirmation(input);
  input.generation = '13';
  await confirm();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://otto.computer/v1/stopped');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.body, '{}');
  assert.deepEqual(calls[0].options.headers, {
    'content-type': 'application/json',
    'x-otto-generation': '12',
  });
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('computer shutdown refuses configurable remote destinations, invalid generations and unconfirmed results', async () => {
  for (const change of [
    { endpoint: 'https://example.test/v1/stopped' },
    { generation: '0' },
    { generation: '01' },
    { generation: 'bad' },
  ])
    assert.throws(() =>
      createComputerShutdownConfirmation({
        endpoint: 'http://otto.computer/v1/stopped',
        generation: '1',
        ...change,
      }),
    );
  for (const response of [
    () => Response.json({ ok: false }),
    () => Response.json({ ok: true, private: 'detail' }),
    () => Response.json({ private: 'detail' }, { status: 503 }),
    () => {
      throw new Error('secret provider failure');
    },
  ]) {
    const confirm = createComputerShutdownConfirmation({
      endpoint: 'http://otto.computer/v1/stopped',
      generation: '1',
      fetch: (async () => response()) as typeof fetch,
    });
    await assert.rejects(confirm(), { message: 'The computer shutdown could not be confirmed.' });
  }
});
