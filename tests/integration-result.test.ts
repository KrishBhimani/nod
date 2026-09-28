import assert from 'node:assert/strict';
import test from 'node:test';
import {
  integrationResultBytes,
  integrationResultSnapshot,
} from '../src/server/integration-result.ts';

function assertOmitted(value: unknown) {
  const serialized = JSON.stringify(value ?? null);
  const result = integrationResultSnapshot(value);
  assert.ok(result && typeof result === 'object' && !Array.isArray(result));
  assert.deepEqual(Object.keys(result).sort(), [
    'message',
    'originalBytes',
    'resultOmitted',
    'truncated',
  ]);
  const marker = result as Record<string, unknown>;
  assert.equal(marker.truncated, true);
  assert.equal(marker.resultOmitted, true);
  assert.equal(marker.originalBytes, Buffer.byteLength(serialized, 'utf8'));
  assert.equal(typeof marker.message, 'string');
  const message = marker.message as string;
  assert.match(message, /incomplete evidence/i);
  assert.match(message, /not a not-found result/i);
  assert.match(message, /do not repeat a completed action/i);
  assert.match(message, /narrower read-only query/i);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= integrationResultBytes);
  return marker;
}

test('integration snapshots retain small JSON values and pagination metadata by value', () => {
  assert.equal(integrationResultBytes, 18_000);
  assert.equal(integrationResultSnapshot(undefined), null);
  for (const value of [null, true, false, 0, 42.5, '', 'small result', [null, 'item', 3]])
    assert.deepEqual(integrationResultSnapshot(value), value);
  const value = {
    records: [{ title: 'Synthetic page', properties: { selected: true } }],
    has_more: true,
    next_cursor: 'synthetic-next-page',
    count: 1,
  };
  const result = integrationResultSnapshot(value);
  assert.deepEqual(result, value);
  value.records[0].title = 'Changed after snapshot';
  assert.deepEqual(result, {
    records: [{ title: 'Synthetic page', properties: { selected: true } }],
    has_more: true,
    next_cursor: 'synthetic-next-page',
    count: 1,
  });
});

for (const [kind, value] of [
  ['ASCII', 'x'.repeat(17_998)],
  ['UTF-8', '€'.repeat(5_999) + 'x'],
  ['JSON escapes', '\n'.repeat(8_999)],
]) {
  test(`integration snapshots accept exactly 18,000 serialized bytes and omit one byte over for ${kind}`, () => {
    assert.equal(Buffer.byteLength(JSON.stringify(value), 'utf8'), 18_000);
    assert.equal(integrationResultSnapshot(value), value);
    const over = value + 'x';
    assert.equal(Buffer.byteLength(JSON.stringify(over), 'utf8'), 18_001);
    assertOmitted(over);
  });
}

test('oversized integration snapshots omit all records including a later match without vendor prefixes', () => {
  const value = {
    vendorMessage: 'synthetic-vendor-output-must-not-survive',
    records: [
      { title: 'Unrelated synthetic page', body: 'x'.repeat(18_000) },
      { title: 'Requested synthetic page', match: true },
    ],
    has_more: false,
    next_cursor: null,
  };
  const original = JSON.stringify(value);
  const marker = assertOmitted(value);
  const serialized = JSON.stringify(marker);
  assert.equal(JSON.stringify(value), original);
  for (const text of [
    value.vendorMessage,
    value.records[0].title,
    value.records[1].title,
    'records',
    'has_more',
    'next_cursor',
  ])
    assert.equal(serialized.includes(text), false);
  const other = assertOmitted({ unrelated: 'different vendor data'.repeat(2_000) });
  assert.equal(other.message, marker.message);
});
