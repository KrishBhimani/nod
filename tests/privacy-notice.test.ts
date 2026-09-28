import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify, { type InjectOptions } from 'fastify';
import { registerLocalAccess } from '../src/server/access.ts';
import { createGateway } from '../src/server/gateway.ts';
import {
  loadPrivacyNoticeFile,
  parsePrivacyNotice,
  registerPrivacyNotice,
} from '../src/server/privacy.ts';

const origin = 'https://otto.example.test';
const host = 'otto.example.test';

async function fixture(privacyNotice?: string) {
  const calls: string[] = [];
  const unavailable = (name: string) => async (): Promise<never> => {
    calls.push(name);
    throw new Error('Synthetic private provider detail.');
  };
  const app = await createGateway({
    origin,
    privacyNotice,
    release: 'synthetic-private-release',
    authentication: {
      configured: true,
      initialize: unavailable('initialize'),
      session: unavailable('session'),
      signIn: unavailable('signIn'),
      signOut: unavailable('signOut'),
      callback: unavailable('callback'),
    },
    accounts: {
      read: unavailable('accountRead'),
      update: unavailable('accountUpdate'),
    },
    runtimes: {
      fetch: unavailable('runtime'),
      async close() {},
    },
  });
  return { app, calls };
}

test('public privacy reads return only configured Markdown without authentication or tenant access', async () => {
  const content =
    '# Privacy\n\nSynthetic operator notice.\n\n[Contact](mailto:privacy@example.test)';
  const f = await fixture(`\n  ${content}  \n`);
  try {
    for (const headers of [
      { host },
      { host, origin, cookie: 'synthetic=untrusted', 'x-otto-account': 'foreign-account' },
    ]) {
      const response = await f.app.inject({
        url: '/api/privacy?account=foreign-account&content=untrusted',
        headers,
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { content });
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.equal(response.headers['content-security-policy'], "frame-ancestors 'none'");
      assert.equal(response.headers['set-cookie'], undefined);
      assert.deepEqual(f.calls, []);
    }
  } finally {
    await f.app.close();
  }
});

test('unconfigured and whitespace-only notices remain explicitly unavailable', async () => {
  for (const value of [undefined, '', ' \n\t ']) {
    const f = await fixture(value);
    try {
      const response = await f.app.inject({ url: '/api/privacy', headers: { host } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { content: null });
      assert.deepEqual(f.calls, []);
    } finally {
      await f.app.close();
    }
  }
});

test('public privacy reads retain canonical host, origin, cross-site and path guards', async () => {
  const f = await fixture('Synthetic public notice.');
  try {
    for (const headers of [
      { host: 'foreign.example.test', 'x-forwarded-host': host },
      { host, origin: 'https://foreign.example.test' },
      { host, 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = await f.app.inject({ url: '/api/privacy', headers });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().content, undefined);
    }
    const unsafe = await f.app.inject({
      method: 'TRACE' as InjectOptions['method'],
      url: '/api/privacy',
      headers: { host, origin },
    });
    assert.equal(unsafe.statusCode, 405);
    const encoded = await f.app.inject({ url: '/api/%70rivacy', headers: { host } });
    assert.equal(encoded.statusCode, 400);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.app.close();
  }
});

test('privacy configuration enforces the trimmed limit and never echoes invalid values', async () => {
  const content = 'x'.repeat(32_000);
  assert.equal(parsePrivacyNotice(` \n${content}\n `), content);
  const f = await fixture(content);
  try {
    const response = await f.app.inject({ url: '/api/privacy', headers: { host } });
    assert.deepEqual(response.json(), { content });
  } finally {
    await f.app.close();
  }
  for (const invalid of [null, 123, { secret: 'synthetic-private-value' }, content + 'x']) {
    assert.throws(() => parsePrivacyNotice(invalid), {
      name: 'Error',
      message: 'Configure a valid public privacy notice.',
    });
    await assert.rejects(fixture(invalid as string), {
      name: 'Error',
      message: 'Configure a valid public privacy notice.',
    });
  }
});

test('privacy files are bounded UTF-8 Markdown with fixed configuration failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-privacy-'));
  const path = join(directory, 'synthetic-private-file-path.md');
  try {
    assert.equal(await loadPrivacyNoticeFile(), undefined);
    assert.equal(await loadPrivacyNoticeFile(' \n '), undefined);
    await writeFile(path, ' \n# Privacy\n\nSynthetic operator notice.\n ', { mode: 0o600 });
    assert.equal(await loadPrivacyNoticeFile(path), '# Privacy\n\nSynthetic operator notice.');
    for (const content of [
      '',
      '\n\t ',
      'x'.repeat(32_001),
      ' '.repeat(131_073),
      Buffer.from([0xc3, 0x28]),
    ]) {
      await writeFile(path, content, { mode: 0o600 });
      await assert.rejects(loadPrivacyNoticeFile(path), {
        name: 'Error',
        message: 'Configure a valid public privacy notice.',
      });
    }
    for (const invalid of [directory, join(directory, 'missing-notice.md')])
      await assert.rejects(loadPrivacyNoticeFile(invalid), {
        name: 'Error',
        message: 'Configure a valid public privacy notice.',
      });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the local privacy route keeps loopback and origin restrictions', async () => {
  const app = Fastify({ logger: false });
  registerLocalAccess(app, 4399);
  registerPrivacyNotice(app, '  Synthetic local notice.  ');
  try {
    const response = await app.inject({
      url: '/api/privacy',
      headers: { host: 'localhost:4399' },
    });
    assert.deepEqual(response.json(), { content: 'Synthetic local notice.' });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    for (const headers of [
      { host: 'foreign.example.test' },
      { host: 'localhost:4399', origin: 'https://foreign.example.test' },
      { host: 'localhost:4399', 'sec-fetch-site': 'cross-site' },
    ])
      assert.equal((await app.inject({ url: '/api/privacy', headers })).statusCode, 403);
  } finally {
    await app.close();
  }
});
