import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { DeploymentRequest } from '../../../src/ports/deployment.ts';
import { signDeploymentRequest } from '../../../src/server/deployment-auth.ts';
import { createGatewayDeployment } from '../src/deployment-gateway.ts';

function fixture() {
  const master = Buffer.alloc(32, 19);
  const values = new Map<string, unknown>();
  const requests: Request[] = [];
  const input: DeploymentRequest = {
    action: 'prepare',
    nonce: randomUUID(),
    targetRelease: 'a'.repeat(40),
    previousRelease: 'b'.repeat(40),
    deadline: Date.now() + 60_000,
  };
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    transaction: async <T>(operation: (value: unknown) => Promise<T>) => operation(storage),
  } as unknown as DurableObjectStorage;
  let reply = async (_request: Request) => Response.json({ ok: true, receipts: [] });
  const create = () =>
    createGatewayDeployment({
      storage,
      environment: 'development',
      gatewayEnvironment: JSON.stringify({
        SIDEKICK_MASTER_KEY: master.toString('base64'),
        SIDEKICK_RELEASE: input.previousRelease,
      }),
      forward: async (request) => {
        requests.push(request);
        return reply(request);
      },
    });
  const request = (changes: Partial<DeploymentRequest> = {}, requestId = randomUUID()) => {
    const body = Buffer.from(JSON.stringify({ ...input, ...changes }));
    return new Request('https://sidekick.example.test/api/deployment', {
      method: 'POST',
      headers: {
        'x-sidekick-deployment': signDeploymentRequest({
          masterKey: master,
          environment: 'development',
          body,
          requestId,
        }),
      },
      body,
    });
  };
  return {
    input,
    values,
    requests,
    create,
    request,
    reply(value: typeof reply) {
      reply = value;
    },
  };
}

test('gateway persists admission closure before signed forwarding and survives controller replacement', async () => {
  const f = fixture();
  const control = f.create();
  let seen = false;
  f.reply(async (request) => {
    seen = true;
    assert.equal(await control.closed(), true);
    assert.equal((f.values.get('deployment-barrier') as { phase: string }).phase, 'draining');
    assert.deepEqual(await request.json(), f.input);
    assert.ok(request.headers.get('x-sidekick-deployment'));
    return Response.json({ ok: true, receipts: [] });
  });
  assert.equal(await control.closed(), false);
  const result = await control.handle(f.request());
  assert.equal(seen, true);
  assert.equal(result.state?.phase, 'prepared');
  assert.equal(await f.create().closed(), true);
});

test('durable deployment request replay protection survives replacement and rejected auth cannot close admission', async () => {
  const f = fixture();
  const id = randomUUID();
  const first = f.request({}, id);
  const replay = new Request(first.clone());
  await f.create().handle(first);
  await assert.rejects(f.create().handle(replay));
  assert.equal(f.requests.length, 1);
  const fresh = fixture();
  const bad = fresh.request();
  bad.headers.set('x-sidekick-deployment', 'invalid');
  await assert.rejects(fresh.create().handle(bad));
  assert.equal(await fresh.create().closed(), false);
  assert.equal(fresh.requests.length, 0);
  assert.equal(fresh.values.size, 0);
});

test('gateway refuses malformed successful acknowledgements and keeps admission closed', async () => {
  for (const body of [
    { ok: true },
    { ok: true, receipts: [{ ownerId: randomUUID(), generation: '0' }] },
    { ok: true, receipts: [], extra: true },
  ]) {
    const f = fixture();
    f.reply(async () => Response.json(body));
    await assert.rejects(f.create().handle(f.request()));
    assert.equal(await f.create().closed(), true);
    assert.equal((f.values.get('deployment-barrier') as { phase: string }).phase, 'failed');
  }
});

test('wrong target, method, query and oversized bodies never dispatch deployment work', async () => {
  for (const variant of ['target', 'method', 'query', 'oversize']) {
    const f = fixture();
    const original = f.request();
    const request =
      variant === 'method'
        ? new Request(original.url, { method: 'GET', headers: original.headers })
        : new Request(
            original.url + (variant === 'query' ? '?x=1' : variant === 'target' ? '/other' : ''),
            {
              method: 'POST',
              headers: original.headers,
              body: variant === 'oversize' ? 'x'.repeat(2049) : await original.text(),
            },
          );
    await assert.rejects(f.create().handle(request));
    assert.equal(f.requests.length, 0);
    assert.equal(await f.create().closed(), false);
  }
});
