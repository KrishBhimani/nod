import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { ObjectStoreConflict } from '../src/ports/object-storage.ts';
import { createFilesystemObjectStore } from '../src/providers/object-storage/filesystem.ts';
import { createHttpObjectStore } from '../src/providers/object-storage/http.ts';
import { createS3ObjectStore } from '../src/providers/object-storage/s3.ts';
import { objectKey } from '../src/ports/object-storage-validation.ts';

const key = `artifacts/${randomUUID()}`;

test('private object keys use the same canonical UUID grammar as the hosted broker', () => {
  const id = '01234567-89ab-4cde-8fab-0123456789ab';
  for (const value of [`artifacts/${id}`, `sessions/${id}.jsonl`])
    assert.equal(objectKey(value), value);
  for (const value of [
    `artifacts/${id.toUpperCase()}`,
    `sessions/${id.toUpperCase()}.jsonl`,
    'sessions/task.jsonl',
    `artifacts/${id.replace('-4cde-', '-0cde-')}`,
    `sessions/${id.replace('-8fab-', '-7fab-')}.jsonl`,
    `artifacts/${id}.jsonl`,
    `sessions/${id}`,
    `sessions/../${id}.jsonl`,
  ])
    assert.throws(() => objectKey(value), /identifier/);
});

test('filesystem storage validates missing reads before lookup and conceals filesystem failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-object-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFilesystemObjectStore(root);
  for (const limit of [0, -1, 0.5, NaN, 16 * 1024 * 1024 + 1])
    await assert.rejects(store.read(key, limit), /size limit is invalid/);
  await writeFile(join(root, 'artifacts'), 'synthetic private path');
  for (const operation of [
    () => store.write(key, Buffer.from('fixture'), { expectedVersion: null }),
    () => store.remove(key),
    () => store.read(key, 100),
  ])
    await assert.rejects(operation(), {
      message: 'Private file storage is temporarily unavailable.',
    });
  await rm(join(root, 'artifacts'));
  await mkdir(join(root, key), { recursive: true });
  await assert.rejects(store.remove(key), {
    message: 'Private file storage is temporarily unavailable.',
  });
  await rm(join(root, key), { recursive: true });
  await store.write(key, Buffer.from('fixture'), { expectedVersion: null });
  await assert.rejects(
    store.write(key, Buffer.from('stale'), { expectedVersion: null }),
    ObjectStoreConflict,
  );
});
test('private filesystem objects survive factory restart and preserve conditional writes and path bounds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-objects-'));
  const outside = await mkdtemp(join(tmpdir(), 'sidekick-outside-'));
  try {
    const first = createFilesystemObjectStore(root);
    assert.equal(await first.read(key, 100), undefined);
    const version = await first.write(key, Buffer.from('private'), { expectedVersion: null });
    const next = createFilesystemObjectStore(root);
    assert.equal((await next.read(key, 100))?.bytes.toString(), 'private');
    await assert.rejects(
      next.write(key, Buffer.from('foreign'), { expectedVersion: null }),
      ObjectStoreConflict,
    );
    await assert.rejects(
      next.write(key, Buffer.from('foreign'), { expectedVersion: 'stale' }),
      ObjectStoreConflict,
    );
    await assert.rejects(next.read(key, 2), /unavailable/);
    await assert.rejects(next.read('../secret', 100), /identifier/);
    await next.write(key, Buffer.from('next'), { expectedVersion: version });
    await assert.rejects(next.remove(key, { expectedVersion: version }), ObjectStoreConflict);
    const file = join(outside, 'private');
    await writeFile(file, 'never read');
    await rm(join(root, key));
    await symlink(file, join(root, key));
    await assert.rejects(next.read(key, 100), /unavailable/);
    await rm(join(root, 'artifacts'), { recursive: true });
    await symlink(outside, join(root, 'artifacts'));
    await assert.rejects(
      next.write(key, Buffer.from('escape'), { expectedVersion: null }),
      /unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('HTTP storage bounds responses, uses version conditions and never forwards owner or credentials', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let status = 200;
  const store = createHttpObjectStore({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init! });
      if (init?.method === 'PUT')
        return new Response(null, { status: 204, headers: { etag: '"next"' } });
      if (status === 500) throw new Error('secret upstream URL?token=private');
      return new Response('payload', { status, headers: { etag: '"current"' } });
    },
  });
  assert.equal((await store.read(key, 100))?.version, '"current"');
  assert.equal(
    await store.write(key, Buffer.from('bytes'), { expectedVersion: '"current"' }),
    '"next"',
  );
  assert.equal(new Headers(requests[1].init.headers).get('if-match'), '"current"');
  assert.equal(new Headers(requests[1].init.headers).get('authorization'), null);
  assert.equal(new Headers(requests[1].init.headers).get('x-owner-id'), null);
  assert.equal(requests[0].url, 'http://sidekick.storage/v1/objects/' + encodeURIComponent(key));
  assert.equal(requests[0].init.redirect, 'manual');
  await assert.rejects(store.read(key, 3), /unavailable/);
  status = 412;
  await assert.rejects(store.read(key, 100), ObjectStoreConflict);
  status = 404;
  assert.equal(await store.read(key, 100), undefined);
  status = 500;
  await assert.rejects(
    store.read(key, 100),
    (error: Error) => !/secret|private.*URL|token/.test(error.message),
  );
});

test('self-host S3 storage binds every operation to the configured owner and environment', async (t) => {
  const client = new S3Client({
    region: 'auto',
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
  });
  const commands: unknown[] = [];
  t.mock.method(
    client,
    'send',
    async (command: GetObjectCommand | PutObjectCommand | DeleteObjectCommand) => {
      commands.push(command);
      assert.equal(command.input.Bucket, 'fixture-private');
      assert.equal(command.input.Key, 'development/owner-one/' + key);
      if (command instanceof GetObjectCommand)
        return {
          ETag: '"read"',
          ContentLength: 3,
          Body: { transformToWebStream: () => new Response('abc').body! },
        };
      if (command instanceof PutObjectCommand) return { ETag: '"written"' };
      return {};
    },
  );
  const store = createS3ObjectStore({
    client,
    bucket: 'fixture-private',
    ownerId: 'owner-one',
    environment: 'development',
  });
  assert.equal((await store.read(key, 4))?.bytes.toString(), 'abc');
  await store.write(key, Buffer.from('x'), { expectedVersion: null });
  assert.equal((commands[1] as PutObjectCommand).input.IfNoneMatch, '*');
  await store.remove(key, { expectedVersion: '"written"' });
  assert.equal((commands[2] as DeleteObjectCommand).input.IfMatch, '"written"');
  await assert.rejects(
    store.write('../other-owner/file', Buffer.from('x'), { expectedVersion: null }),
    /unavailable/,
  );
  client.destroy();
});

test('private object body reads time out even after headers arrive', async () => {
  let cancelled = false;
  const store = createHttpObjectStore({
    timeoutMs: 20,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { etag: '"fixture"' } },
      ),
  });
  await assert.rejects(store.read(key, 100), /unavailable/);
  assert.equal(cancelled, true);
});
