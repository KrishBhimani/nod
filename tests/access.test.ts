import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerLocalAccess } from '../src/server/access.ts';

test('OAuth return permits top-level connections navigation and keeps cross-site APIs blocked', async () => {
  const app = Fastify();
  registerLocalAccess(app, 4310);
  app.get('/connections', async () => 'Application shell');
  app.get('/goals', async () => 'Application shell');
  app.get('/schedule', async () => 'Application shell');
  app.post('/connections', async () => ({ ok: true }));
  app.get('/api/connections', async () => []);
  app.post('/api/connections/gmail/connect', async () => ({ ok: true }));
  app.get('/api/connections/callback', async (_request, reply) => reply.redirect('/connections'));
  const headers = {
    host: 'localhost:4310',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  };
  try {
    const callback = await app.inject({ url: '/api/connections/callback', headers });
    assert.equal(callback.statusCode, 302);
    assert.equal((await app.inject({ url: callback.headers.location!, headers })).statusCode, 200);
    for (const url of ['/goals', '/schedule']) {
      assert.equal((await app.inject({ url, headers })).statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url, headers })).statusCode, 403);
      assert.equal(
        (await app.inject({ url, headers: { ...headers, 'sec-fetch-dest': 'iframe' } })).statusCode,
        403,
      );
    }
    for (const url of ['/api/connections', '/api/connections/gmail/connect']) {
      assert.equal((await app.inject({ url, headers })).statusCode, 403);
      assert.equal((await app.inject({ method: 'POST', url, headers })).statusCode, 403);
    }
    for (const rejected of [
      { ...headers, 'sec-fetch-mode': 'cors' },
      { ...headers, 'sec-fetch-dest': 'iframe' },
      { ...headers, origin: 'https://attacker.example' },
      { ...headers, host: 'attacker.example:4310' },
    ]) {
      assert.equal((await app.inject({ url: '/connections', headers: rejected })).statusCode, 403);
    }
    assert.equal(
      (await app.inject({ method: 'POST', url: '/connections', headers })).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});
