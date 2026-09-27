import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(
  new URL('../src/providers/cloudflare-computer/checkpoint.py', import.meta.url),
);
const failure = 'Computer checkpoint failed.\n';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function run(args: string[], input?: Buffer) {
  return new Promise<{ code: number | null; stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn('python3', ['-B', helper, ...args], {
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: 'pipe',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (value: Buffer) => stdout.push(value));
    child.stderr.on('data', (value: Buffer) => stderr.push(value));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() }),
    );
    child.stdin.end(input);
  });
}

async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'sidekick-checkpoint-'));
  const source = join(directory, 'source');
  const target = join(directory, 'restored');
  await mkdir(source, { mode: 0o700 });
  return {
    directory,
    source,
    target,
    create: (...args: string[]) => run(['create', source, ...args]),
    restore: (input: Buffer, ...args: string[]) => run(['restore', target, ...args], input),
    async noStaging() {
      assert.deepEqual(
        (await readdir(directory)).filter((name) => name.startsWith('.sidekick-checkpoint-')),
        [],
      );
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

type Entry = { name: string; type?: string; data?: Buffer; link?: string; mode?: number };

function header(entry: Entry, size = entry.data?.length ?? 0) {
  const value = Buffer.alloc(512);
  value.write(entry.name, 0, 100);
  value.write((entry.mode ?? 0o700).toString(8).padStart(7, '0') + '\0', 100, 8);
  value.write('0000000\0', 108, 8);
  value.write('0000000\0', 116, 8);
  value.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  value.write('00000000000\0', 136, 12);
  value.fill(32, 148, 156);
  value.write(entry.type ?? '0', 156, 1);
  if (entry.link) value.write(entry.link, 157, 100);
  value.write('ustar\0' + '00', 257, 8);
  const checksum = [...value].reduce((sum, byte) => sum + byte, 0);
  value.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return value;
}

function pax(key: string, value: string) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(String(length) + body) !== length)
    length = Buffer.byteLength(String(length) + body);
  return Buffer.from(String(length) + body);
}

function archive(entries: Entry[]) {
  const buffers: Buffer[] = [header({ name: '.', type: '5' })];
  for (const entry of entries) {
    if ((entry.type ?? '0') === '0') {
      const digest = pax('sidekick.sha256', hash(entry.data ?? Buffer.alloc(0)));
      buffers.push(
        header({ name: 'PaxHeader', type: 'x' }, digest.length),
        digest,
        Buffer.alloc((512 - (digest.length % 512)) % 512),
      );
    }
    buffers.push(header(entry));
    if (entry.data) {
      buffers.push(entry.data, Buffer.alloc((512 - (entry.data.length % 512)) % 512));
    }
  }
  return Buffer.concat([...buffers, Buffer.alloc(1024)]);
}

function rejected(result: Awaited<ReturnType<typeof run>>) {
  assert.equal(result.code, 1);
  assert.equal(result.stderr, failure);
}

test('checkpoint roundtrip preserves private files, executable modes and internal npm-style symlinks', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.source, 'package'), { mode: 0o700 });
    await mkdir(join(f.source, '.bin'), { mode: 0o700 });
    await writeFile(join(f.source, 'package', 'run'), Buffer.from([0, 255, 128, 10]), {
      mode: 0o700,
    });
    await chmod(join(f.source, 'package', 'run'), 0o4700);
    await writeFile(join(f.source, 'private'), 'synthetic private value', { mode: 0o600 });
    await symlink('../package/run', join(f.source, '.bin', 'run'));
    await symlink('package', join(f.source, 'package-alias'));
    const captured = await f.create();
    assert.equal(captured.code, 0, captured.stderr);
    assert.equal(captured.stderr, '');
    await mkdir(f.target, { mode: 0o700 });
    const restored = await f.restore(captured.stdout, '--sha256', hash(captured.stdout));
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(restored.stdout.length, 0);
    assert.equal(await readFile(join(f.target, 'private'), 'utf8'), 'synthetic private value');
    assert.deepEqual(await readFile(join(f.target, '.bin', 'run')), Buffer.from([0, 255, 128, 10]));
    assert.equal(await readlink(join(f.target, '.bin', 'run')), '../package/run');
    assert.equal(await readlink(join(f.target, 'package-alias')), 'package');
    assert.equal((await lstat(f.target)).mode & 0o7777, 0o700);
    assert.equal((await lstat(join(f.target, 'private'))).mode & 0o7777, 0o600);
    assert.equal((await lstat(join(f.target, 'package', 'run'))).mode & 0o7777, 0o700);
    await f.noStaging();
  } finally {
    await f.close();
  }
});

test('checkpoint supports long UTF-8 paths and contained dangling symlinks', async () => {
  const f = await fixture();
  try {
    const name = 'résumé-'.repeat(20);
    await writeFile(join(f.source, name), 'long path', { mode: 0o600 });
    await symlink('future-file', join(f.source, 'future'));
    const captured = await f.create();
    assert.equal(captured.code, 0, captured.stderr);
    assert.equal((await f.restore(captured.stdout)).code, 0);
    assert.equal(await readFile(join(f.target, name), 'utf8'), 'long path');
    assert.equal(await readlink(join(f.target, 'future')), 'future-file');
    await f.noStaging();
  } finally {
    await f.close();
  }
});

test('restore rejects header corruption, content corruption, truncation and unconsumed trailing data', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, 'secret-file'), 'synthetic secret payload');
    const captured = await f.create();
    assert.equal(captured.code, 0, captured.stderr);
    const damagedHeader = Buffer.from(captured.stdout);
    damagedHeader[0] ^= 1;
    const damagedContent = Buffer.from(captured.stdout);
    damagedContent[damagedContent.indexOf('synthetic secret payload')] ^= 1;
    for (const input of [
      damagedHeader,
      damagedContent,
      captured.stdout.subarray(0, captured.stdout.indexOf('synthetic secret payload') + 3),
      captured.stdout.subarray(0, captured.stdout.length - 1),
      captured.stdout.subarray(0, captured.stdout.length - 512),
      Buffer.concat([captured.stdout, Buffer.from('private trailing text')]),
      Buffer.concat([captured.stdout, Buffer.alloc(1)]),
      Buffer.alloc(1024),
    ]) {
      rejected(await f.restore(input));
      await assert.rejects(lstat(f.target), { code: 'ENOENT' });
      await f.noStaging();
    }
    assert.equal((await f.restore(Buffer.concat([captured.stdout, Buffer.alloc(512)]))).code, 0);
  } finally {
    await f.close();
  }
});

test('restore validates the whole archive digest before replacing an empty target', async () => {
  const f = await fixture();
  try {
    const input = archive([{ name: 'private', data: Buffer.from('synthetic secret') }]);
    await mkdir(f.target, { mode: 0o750 });
    const original = await lstat(f.target);
    rejected(await f.restore(input, '--sha256', '0'.repeat(64)));
    rejected(await f.restore(Buffer.concat([input, Buffer.alloc(512)]), '--sha256', hash(input)));
    const preserved = await lstat(f.target);
    assert.equal(preserved.ino, original.ino);
    assert.equal(preserved.mode, original.mode);
    assert.deepEqual(await readdir(f.target), []);
    await f.noStaging();
    assert.equal((await f.restore(input, '--sha256', hash(input))).code, 0);
  } finally {
    await f.close();
  }
});

test('restore rejects traversal, symlink pivots, duplicates, conflicting parents and special members', async () => {
  const f = await fixture();
  try {
    const sentinel = join(f.directory, 'sentinel');
    await writeFile(sentinel, 'untouched synthetic sentinel', { mode: 0o600 });
    const cases: Entry[][] = [
      [{ name: '../sentinel', data: Buffer.from('overwrite') }],
      [{ name: sentinel, data: Buffer.from('overwrite') }],
      [{ name: 'sub/../sentinel', data: Buffer.from('overwrite') }],
      [
        { name: 'pivot', type: '2', link: '..' },
        { name: 'pivot/sentinel', data: Buffer.from('overwrite') },
      ],
      [{ name: 'pivot', type: '2', link: '../sentinel' }],
      [{ name: 'pivot', type: '2', link: '/tmp' }],
      [
        { name: 'a', type: '2', link: 'b' },
        { name: 'b', type: '2', link: 'a' },
      ],
      [{ name: 'loop', type: '2', link: '.' }],
      [
        { name: 'same', data: Buffer.alloc(0) },
        { name: 'same', data: Buffer.alloc(0) },
      ],
      [
        { name: 'file', data: Buffer.alloc(0) },
        { name: 'file/child', data: Buffer.alloc(0) },
      ],
      [{ name: 'missing/child', data: Buffer.alloc(0) }],
      [{ name: 'hard', type: '1', link: 'sentinel' }],
      ...['3', '4', '6', '7', 'S', 'g', 'L'].map((type) => [{ name: 'special', type }]),
    ];
    for (const entries of cases) {
      rejected(await f.restore(archive(entries)));
      assert.equal(await readFile(sentinel, 'utf8'), 'untouched synthetic sentinel');
      await assert.rejects(lstat(f.target), { code: 'ENOENT' });
      await f.noStaging();
    }
  } finally {
    await f.close();
  }
});

test('create and restore enforce archive, file, entry and path quotas', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, 'long-file-name'), Buffer.alloc(1024, 42));
    const captured = await f.create();
    assert.equal(captured.code, 0, captured.stderr);
    for (const args of [
      ['--max-bytes', '1024'],
      ['--max-file-bytes', '1023'],
      ['--max-entries', '1'],
      ['--max-path-bytes', '4'],
    ]) {
      const result = await f.create(...args);
      rejected(result);
      if (args[0] === '--max-bytes') assert.ok(result.stdout.length <= 1024);
      rejected(await f.restore(captured.stdout, ...args));
      await assert.rejects(lstat(f.target), { code: 'ENOENT' });
      await f.noStaging();
    }
    for (const args of [
      ['--max-bytes', '268435457'],
      ['--max-file-bytes', '67108865'],
      ['--max-entries', '20001'],
      ['--max-path-bytes', '4097'],
      ['--max-bytes', '-1'],
      ['--max-bytes', 'synthetic secret argument'],
      ['--sha256', 'not a digest'],
    ]) {
      rejected(await f.restore(captured.stdout, ...args));
      await f.noStaging();
    }
  } finally {
    await f.close();
  }
});

test('restore preserves nonempty targets and refuses target or parent symlinks', async () => {
  const f = await fixture();
  try {
    const input = archive([{ name: 'replacement', data: Buffer.from('new') }]);
    await mkdir(f.target);
    await writeFile(join(f.target, 'original'), 'untouched');
    rejected(await f.restore(input));
    assert.equal(await readFile(join(f.target, 'original'), 'utf8'), 'untouched');
    await rm(f.target, { recursive: true });
    await symlink(f.source, f.target);
    rejected(await f.restore(input));
    assert.deepEqual(await readdir(f.source), []);
    rejected(await run(['restore', join(f.target, 'child')], input));
    rejected(await run(['create', f.target]));
    await f.noStaging();
  } finally {
    await f.close();
  }
});

test('restore discards private staging if the target changes while input is streaming', async () => {
  const f = await fixture();
  try {
    await mkdir(f.target, { mode: 0o700 });
    const input = archive([
      { name: 'locked', type: '5', mode: 0 },
      { name: 'locked/file', data: Buffer.from('private staged bytes'), mode: 0 },
    ]);
    const child = spawn('python3', ['-B', helper, 'restore', f.target], { stdio: 'pipe' });
    const closed = once(child, 'close');
    const errors: Buffer[] = [];
    child.stderr.on('data', (value: Buffer) => errors.push(value));
    child.stdout.resume();
    child.stdin.write(input.subarray(0, 512));
    let staging = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      staging = (await readdir(f.directory)).some((name) =>
        name.startsWith('.sidekick-checkpoint-'),
      );
      if (staging) break;
      await delay(10);
    }
    assert.equal(staging, true);
    await writeFile(join(f.target, 'arrived-during-restore'), 'preserve this');
    child.stdin.end(input.subarray(512));
    const [code] = await closed;
    assert.equal(code, 1);
    assert.equal(Buffer.concat(errors).toString(), failure);
    assert.equal(await readFile(join(f.target, 'arrived-during-restore'), 'utf8'), 'preserve this');
    assert.deepEqual(await readdir(f.target), ['arrived-during-restore']);
    await f.noStaging();
  } finally {
    await f.close();
  }
});

test('restore rejects malformed, repeated and unsupported extended metadata', async () => {
  const f = await fixture();
  try {
    const data = Buffer.from('private synthetic bytes');
    const validDigest = pax('sidekick.sha256', hash(data));
    for (const metadata of [
      Buffer.from('999999 path=../sentinel\n'),
      Buffer.concat([pax('path', 'file'), pax('path', '../sentinel'), validDigest]),
      Buffer.concat([pax('path', '../sentinel'), validDigest]),
      Buffer.concat([pax('path', '/sentinel'), validDigest]),
      Buffer.concat([pax('unknown', 'private secret metadata'), validDigest]),
      Buffer.concat([pax('sidekick.sha256', hash(data)), validDigest]),
      Buffer.from([255, 0, 10]),
    ]) {
      const input = Buffer.concat([
        header({ name: '.', type: '5' }),
        header({ name: 'PaxHeader', type: 'x' }, metadata.length),
        metadata,
        Buffer.alloc((512 - (metadata.length % 512)) % 512),
        header({ name: 'file', data }),
        data,
        Buffer.alloc((512 - (data.length % 512)) % 512),
        Buffer.alloc(1024),
      ]);
      rejected(await f.restore(input));
      await assert.rejects(lstat(f.target), { code: 'ENOENT' });
      await f.noStaging();
    }
  } finally {
    await f.close();
  }
});

test('create rejects escaping or cyclic links, FIFOs and sockets without leaking private paths', async () => {
  const f = await fixture();
  try {
    const privateName = 'synthetic-private-token';
    await symlink('../outside', join(f.source, privateName));
    rejected(await f.create());
    await rm(join(f.source, privateName));
    await symlink('b', join(f.source, 'a'));
    await symlink('a', join(f.source, 'b'));
    rejected(await f.create());
    await rm(join(f.source, 'a'));
    await rm(join(f.source, 'b'));
    const fifo = spawn('python3', [
      '-c',
      'import os,sys;os.mkfifo(sys.argv[1])',
      join(f.source, privateName),
    ]);
    const [code] = await once(fifo, 'close');
    assert.equal(code, 0);
    rejected(await f.create());
    await rm(join(f.source, privateName));
    const server = createServer();
    const socket = join(f.source, 'socket');
    server.listen(socket);
    await once(server, 'listening');
    try {
      rejected(await f.create());
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await f.noStaging();
  } finally {
    await f.close();
  }
});

test('create rejects a regular file changed while its archive stream is being consumed', async () => {
  const f = await fixture();
  try {
    const path = join(f.source, 'changing');
    await writeFile(path, Buffer.alloc(16 * 1024 * 1024, 42));
    const child = spawn('python3', ['-B', helper, 'create', f.source], { stdio: 'pipe' });
    const closed = once(child, 'close');
    const errors: Buffer[] = [];
    child.stderr.on('data', (value: Buffer) => errors.push(value));
    child.stdin.end();
    await once(child.stdout, 'readable');
    await writeFile(path, 'changed while captured');
    child.stdout.resume();
    const [code] = await closed;
    assert.equal(code, 1);
    assert.equal(Buffer.concat(errors).toString(), failure);
    await f.noStaging();
  } finally {
    await f.close();
  }
});
