import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { createIntegrations } from '../src/server/integrations.ts';
import { createTenantDrain } from '../src/server/tenant-drain.ts';
import { createVault } from '../src/server/vault.ts';
import { createWorkAdmission, createWorkConsumers } from '../src/server/work-admission.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await delay(5);
  }
  throw new Error('The fixture condition did not complete.');
}
const input = () => ({
  nonce: randomUUID(),
  targetRelease: 'a'.repeat(40),
  deadline: Date.now() + 5000,
});

test(
  'integration timers and detached account refresh remain counted through provider and database completion',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const schema = `test_background_drain_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const admission = createWorkAdmission();
    const consumers = createWorkConsumers();
    const drain = createTenantDrain({ admission, consumers });
    const account = gate();
    const watch = gate();
    const event = gate();
    let inspected = 0;
    let subscribed = 0;
    const delivered: string[] = [];
    const unused = async () => {
      throw new Error('Unused fixture.');
    };
    const service = await createIntegrations(pool, {
      admission,
      ownerId: 'fixture-owner',
      baseUrl: 'http://localhost:4310',
      provider: {
        id: 'fixture',
        configured: true,
        webhooksConfigured: true,
        supportsSubscriptions: ['gmail', 'googlecalendar'],
        createSession: unused,
        restoreSession: unused,
        deleteSession: unused,
        inspectAccount: async (id) => {
          inspected++;
          await account.promise;
          return { active: true, service: id === 'gmail-account' ? 'gmail' : 'googlecalendar' };
        },
        deleteAccount: unused,
        parseCallback: () => {
          throw new Error('Unused fixture.');
        },
        subscribe: async () => {
          subscribed++;
          await watch.promise;
          return { id: 'calendar-trigger' };
        },
        unsubscribe: unused,
        verifyWebhook: unused,
        matchesSubscription: () => true,
      },
      wake: async (_prompt, id) => {
        delivered.push(id);
        await event.promise;
      },
    });
    const app = Fastify();
    service.registerRoutes(app);
    await app.ready();
    try {
      await pool.query(`INSERT INTO app_connections(owner_id,slug,account_id,trigger_id,triggers_enabled,provider_id)
        VALUES('fixture-owner','gmail','gmail-account','gmail-trigger',true,'fixture'),
          ('fixture-owner','googlecalendar','calendar-account',NULL,false,'fixture')`);
      const enqueue = (id: string) =>
        pool.query(
          `INSERT INTO integration_events(id,owner_id,summary,slug,account_id,trigger_id,provider_id)
        VALUES($1,'fixture-owner','Synthetic calendar change','gmail','gmail-account','gmail-trigger','fixture')`,
          [id],
        );
      await enqueue('event-first');
      t.mock.timers.tick(5000);
      await service.list();
      await waitFor(() => inspected === 2 && subscribed === 1 && delivered.length === 1);
      assert.equal(admission.pending, 3);
      let received = false;
      const request = input();
      const receipt = drain.prepare(request).then(() => {
        received = true;
      });
      t.mock.timers.tick(5000);
      await service.list();
      assert.equal(inspected, 2);
      assert.equal(subscribed, 1);
      assert.equal(received, false);
      account.resolve();
      watch.resolve();
      await waitFor(() => admission.pending === 1);
      assert.equal(received, false);
      event.resolve();
      await receipt;
      assert.equal(
        (await pool.query("SELECT state FROM integration_events WHERE id='event-first'")).rows[0]
          .state,
        'delivered',
      );
      assert.equal(
        (await pool.query("SELECT trigger_id FROM app_connections WHERE slug='googlecalendar'"))
          .rows[0].trigger_id,
        'calendar-trigger',
      );
      await enqueue('event-second');
      t.mock.timers.tick(5000);
      await delay(5);
      assert.deepEqual(delivered, ['event-first']);
      await drain.resume(request);
      t.mock.timers.tick(5000);
      await waitFor(() => delivered.length === 2 && admission.pending === 0);
      assert.deepEqual(delivered, ['event-first', 'event-second']);
    } finally {
      account.resolve();
      watch.resolve();
      event.resolve();
      admission.close();
      await admission.drain(Date.now() + 5000);
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('Vault periodic retries stop entering during drain and resume pending credentials afterward', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const admission = createWorkAdmission();
  const consumers = createWorkConsumers();
  const drain = createTenantDrain({ admission, consumers });
  const held = gate();
  const pending = new Set(['request-a']);
  const attempted: string[] = [];
  const database = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('SELECT r.*'))
        return { rows: [...pending].map((id) => ({ id, turn_id: id })) };
      if (sql.startsWith('UPDATE credential_requests SET resume_pending'))
        pending.delete(String(values?.[0]));
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const vault = await createVault(database, {
    admission,
    keyStore: { id: 'fixture', configured: true, getKey: async () => randomBytes(32) },
    inject: async () => {},
    retry: async () => {},
    resume: async (id) => {
      attempted.push(id);
      await held.promise;
    },
  });
  const app = Fastify();
  vault.registerRoutes(app);
  await app.ready();
  try {
    t.mock.timers.tick(5000);
    await waitFor(() => attempted.length === 1);
    const request = input();
    let received = false;
    const receipt = drain.prepare(request).then(() => {
      received = true;
    });
    t.mock.timers.tick(5000);
    assert.equal(admission.pending, 1);
    assert.equal(received, false);
    pending.add('request-b');
    held.resolve();
    await receipt;
    assert.deepEqual(attempted, ['request-a']);
    assert.deepEqual([...pending], ['request-b']);
    t.mock.timers.tick(5000);
    await delay(5);
    assert.deepEqual(attempted, ['request-a']);
    await drain.resume(request);
    t.mock.timers.tick(5000);
    await waitFor(() => pending.size === 0 && admission.pending === 0);
    assert.deepEqual(attempted, ['request-a', 'request-b']);
    admission.close();
    t.mock.timers.tick(5000);
    await delay(5);
    assert.deepEqual(attempted, ['request-a', 'request-b']);
  } finally {
    held.resolve();
    await app.close();
  }
});
