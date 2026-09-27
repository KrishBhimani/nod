import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  deploymentProof,
  runtimeDeploymentAcknowledgement,
  runtimeDeploymentBody,
} from '../src/runtime-deployment.ts';

const input = { nonce: randomUUID(), targetRelease: 'a'.repeat(40), deadline: Date.now() + 60_000 };

test('runtime drain parser preserves authenticated bytes and accepts only exact owned-generation proof', async () => {
  const raw = ` ${JSON.stringify(input)} `;
  const parsed = await runtimeDeploymentBody(
    new Request('http://synthetic/api/runtime/drain', { method: 'POST', body: raw }),
  );
  assert.equal(new TextDecoder().decode(parsed.bytes), raw);
  assert.deepEqual(parsed.input, input);
  assert.equal(deploymentProof({ ...input, generation: '2' }, input, '2'), true);
  assert.equal(deploymentProof({ ...input, generation: '1' }, input, '2'), false);
  assert.equal(deploymentProof({ ...input, generation: '2', extra: true }, input, '2'), false);
  for (const body of [JSON.stringify({ ...input, ownerId: randomUUID() }), 'x'.repeat(2049), '{'])
    await assert.rejects(
      runtimeDeploymentBody(
        new Request('http://synthetic/api/runtime/drain', { method: 'POST', body }),
      ),
    );
});

test('only the exact natural-drain acknowledgement may become a durable proof', async () => {
  const receipt = {
    ok: true,
    nonce: input.nonce,
    targetRelease: input.targetRelease,
    generation: '2',
    drained: true,
  };
  const response = await runtimeDeploymentAcknowledgement(
    Response.json(receipt),
    input,
    '2',
    'drain',
  );
  assert.deepEqual(await response.json(), receipt);
  for (const body of [
    { ...receipt, drained: false },
    { ...receipt, generation: '1' },
    { ...receipt, nonce: randomUUID() },
    { ...receipt, extra: true },
    { ok: true },
  ])
    await assert.rejects(
      runtimeDeploymentAcknowledgement(Response.json(body), input, '2', 'drain'),
    );
  await assert.rejects(
    runtimeDeploymentAcknowledgement(new Response('x'.repeat(2049)), input, '2', 'drain'),
  );
  assert.deepEqual(
    await (
      await runtimeDeploymentAcknowledgement(Response.json({ ok: true }), input, '2', 'resume')
    ).json(),
    { ok: true },
  );
});

test('E2B drain requires an explicit remote computer pause acknowledgement', async () => {
  const receipt = {
    ok: true,
    nonce: input.nonce,
    targetRelease: input.targetRelease,
    generation: '2',
    drained: true,
  };
  for (const computerPaused of [undefined, false, 'true'])
    await assert.rejects(
      runtimeDeploymentAcknowledgement(
        Response.json({ ...receipt, computerPaused }),
        input,
        '2',
        'drain',
        true,
      ),
    );
  const accepted = { ...receipt, computerPaused: true };
  const response = await runtimeDeploymentAcknowledgement(
    Response.json(accepted),
    input,
    '2',
    'drain',
    true,
  );
  assert.deepEqual(await response.json(), accepted);
  assert.equal(
    deploymentProof({ ...input, generation: '2', computerPaused: true }, input, '2'),
    true,
  );
});
