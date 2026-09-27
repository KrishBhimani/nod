import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createDeploymentVerifier,
  deploymentPath,
  deriveDeploymentKey,
  signDeploymentRequest,
} from '../src/server/deployment-auth.ts';
import { deriveRuntimeSecret, signRuntimeRequest } from '../src/server/runtime-auth.ts';

function fixture() {
  const masterKey = randomBytes(32);
  const environment = 'production';
  let time = 1_000_000;
  const input = {
    action: 'prepare',
    nonce: randomUUID(),
    previousRelease: 'a'.repeat(40),
    targetRelease: 'b'.repeat(40),
    deadline: time + 300_000,
  };
  const body = Buffer.from(JSON.stringify(input));
  const token = signDeploymentRequest({ masterKey, environment, body, now: time });
  return {
    masterKey,
    environment,
    input,
    body,
    token,
    now: () => time,
    advance: (ms: number) => (time += ms),
  };
}

test('deployment capability binds the exact body, method, path and environment', async () => {
  const f = fixture();
  const verify = () => createDeploymentVerifier(f);
  assert.deepEqual(await verify()(f.token, 'POST', deploymentPath, f.body), f.input);
  for (const [method, path, body] of [
    ['GET', deploymentPath, f.body],
    ['POST', `${deploymentPath}?ignored=true`, f.body],
    ['POST', '/api/runtime/drain', f.body],
    ['POST', deploymentPath, Buffer.from(JSON.stringify({ ...f.input, action: 'complete' }))],
    ['POST', deploymentPath, Buffer.concat([f.body, Buffer.from(' ')])],
  ] as const)
    await assert.rejects(verify()(f.token, method, path, body), { status: 401 });
  await assert.rejects(
    createDeploymentVerifier({ ...f, environment: 'development' })(
      f.token,
      'POST',
      deploymentPath,
      f.body,
    ),
    { status: 401 },
  );
});

test('deployment verification rejects replay and uses the durable nonce callback after verification', async () => {
  const f = fixture();
  const accepted = new Map<string, number>();
  let calls = 0;
  const options = {
    ...f,
    async claimNonce(id: string, expiry: number) {
      calls += 1;
      if (accepted.has(id)) return false;
      accepted.set(id, expiry);
      return true;
    },
  };
  await assert.rejects(
    createDeploymentVerifier(options)('invalid', 'POST', deploymentPath, f.body),
  );
  assert.equal(calls, 0);
  await createDeploymentVerifier(options)(f.token, 'POST', deploymentPath, f.body);
  await assert.rejects(createDeploymentVerifier(options)(f.token, 'POST', deploymentPath, f.body));
  assert.equal(calls, 2);
  const inMemory = createDeploymentVerifier(f);
  await inMemory(f.token, 'POST', deploymentPath, f.body);
  await assert.rejects(inMemory(f.token, 'POST', deploymentPath, f.body));
});

test('expired, excessively future, oversized and malformed signed deployment requests fail closed', async () => {
  const f = fixture();
  f.advance(30_000);
  await assert.rejects(createDeploymentVerifier(f)(f.token, 'POST', deploymentPath, f.body));
  const future = signDeploymentRequest({ ...f, now: f.now() + 6_000 });
  await assert.rejects(createDeploymentVerifier(f)(future, 'POST', deploymentPath, f.body));
  for (const body of [
    Buffer.from(JSON.stringify({ ...f.input, ownerId: randomUUID() })),
    Buffer.from(JSON.stringify({ ...f.input, action: 'exec' })),
    Buffer.from([0xff]),
  ]) {
    const signed = signDeploymentRequest({ ...f, body, now: f.now() });
    await assert.rejects(createDeploymentVerifier(f)(signed, 'POST', deploymentPath, body), {
      status: 401,
      message: 'The deployment operation could not be completed.',
    });
  }
  await assert.rejects(
    createDeploymentVerifier(f)(f.token, 'POST', deploymentPath, Buffer.alloc(2049)),
  );
});

test('tenant signing authority cannot authorize deployment control', async () => {
  const f = fixture();
  const ownerId = randomUUID();
  const secret = deriveRuntimeSecret(f.masterKey, f.environment, ownerId);
  assert.notDeepEqual(
    deriveDeploymentKey(f.masterKey, f.environment),
    Buffer.from(secret, 'base64url'),
  );
  const token = signRuntimeRequest({
    secret,
    ownerId,
    environment: f.environment,
    generation: '1',
    method: 'POST',
    target: deploymentPath,
    body: f.body,
    developer: true,
    now: f.now(),
  });
  await assert.rejects(createDeploymentVerifier(f)(token, 'POST', deploymentPath, f.body), {
    status: 401,
  });
});
