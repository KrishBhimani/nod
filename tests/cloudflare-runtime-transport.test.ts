import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createCloudflareRuntimeTransport } from '../src/providers/runtime-host/cloudflare.ts';

test('clean-stop inspection binds the exact private owner and nullable generation and accepts only its receipt', async () => {
  const ownerId = randomUUID();
  for (const generation of ['12', null]) {
    const transport = createCloudflareRuntimeTransport({
      fetch: async (url, input) => {
        assert.equal(url, 'http://sidekick.runtime/runtime/deployment-stopped');
        assert.equal(input?.method, 'POST');
        assert.deepEqual(JSON.parse(String(input?.body)), { ownerId, generation });
        assert.ok(input?.signal);
        return Response.json({ generation, stopped: true });
      },
    });
    assert.equal(await transport.deploymentStopped!(ownerId, generation), true);
  }
});

test('clean-stop inspection refuses stale, malformed, oversized and failed receipts with one fixed error', async () => {
  const ownerId = randomUUID();
  for (const response of [
    () => Response.json({ generation: '13', stopped: true }),
    () => Response.json({ generation: '12', stopped: true, foreign: 'synthetic-private-value' }),
    () => Response.json({ generation: '12', stopped: true }, { status: 503 }),
    () => new Response('x'.repeat(4097)),
    () => new Response(new Uint8Array([0xff])),
    () => new Response('not-json'),
  ]) {
    const transport = createCloudflareRuntimeTransport({ fetch: async () => response() });
    await assert.rejects(transport.deploymentStopped!(ownerId, '12'), {
      message: 'The account runtime could not be verified as stopped.',
    });
  }
  const transport = createCloudflareRuntimeTransport({
    fetch: async () => Response.json({ generation: '12', stopped: false }),
  });
  assert.equal(await transport.deploymentStopped!(ownerId, '12'), false);
});

test('deployment preparation keeps busy distinct from unsafe and requires bounded exact-generation clean stop acknowledgement', async () => {
  const ownerId = randomUUID();
  const input = {
    nonce: randomUUID(),
    targetRelease: 'a'.repeat(40),
    deadline: Date.now() + 30_000,
  };
  for (const [status, value, expected] of [
    [200, { ok: true, generation: '3', clean: true, stopped: true }, 'stopped'],
    [409, { ok: false, generation: '3', status: 'busy' }, 'busy'],
    [409, { ok: false, generation: '3', status: 'unsafe' }, undefined],
    [200, { ok: true, generation: '4', clean: true, stopped: true }, undefined],
    [200, { ok: true, generation: '3', clean: false, stopped: true }, undefined],
  ] as const) {
    const transport = createCloudflareRuntimeTransport({
      fetch: async (url, options) => {
        assert.equal(url, 'http://sidekick.runtime/runtime/prepare-deployment');
        assert.deepEqual(JSON.parse(String(options?.body)), { ownerId, generation: '3', ...input });
        return Response.json(value, { status });
      },
    });
    const result = transport.prepareDeployment!(ownerId, '3', input);
    if (expected) assert.equal(await result, expected);
    else
      await assert.rejects(result, {
        message: 'The account runtime could not be prepared for deployment.',
      });
  }
});
