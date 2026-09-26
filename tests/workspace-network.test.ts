import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceNetwork } from '../scripts/e2e-workspace.ts';

const connection = { NetworkID: 'a'.repeat(64) };

test('the acceptance workspace reuses one observed normal Docker network', () => {
  for (const name of ['bridge', 'sidekick-local_default', 'sidekick.fixture-network']) {
    const inspected = JSON.stringify({ [name]: { ...connection, IPAddress: '172.18.0.3' } });
    assert.equal(workspaceNetwork(inspected), name);
  }
});

test('the acceptance workspace rejects privileged, absent, malformed and ambiguous network attachments', () => {
  for (const inspected of [
    '',
    'container:guard',
    'null',
    '[]',
    '{}',
    JSON.stringify({ host: connection }),
    JSON.stringify({ none: connection }),
    JSON.stringify({ 'container:guard': connection }),
    JSON.stringify({ '--network=host': connection }),
    JSON.stringify({ 'normal\n--privileged': connection }),
    JSON.stringify({ bridge: connection, another: connection }),
    JSON.stringify({ bridge: {} }),
    JSON.stringify({ bridge: { NetworkID: '' } }),
    JSON.stringify({ bridge: { NetworkID: 42 } }),
    JSON.stringify({ bridge: null }),
  ])
    assert.throws(
      () => workspaceNetwork(inspected),
      /^Error: Start the Sidekick workspace on a normal Docker network first\.$/,
    );
});
