import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import type { AudioInput } from '../src/ports/speech.ts';
import { createMultipartReader } from '../src/server/multipart.ts';
import {
  deriveRuntimeSecret,
  runtimeHeader,
  signRuntimeRequest,
} from '../src/server/runtime-auth.ts';

const boundary = 'sidekick-synthetic-multipart-boundary';
const contentType = `multipart/form-data; boundary=${boundary}`;
type Part = { name: string; bytes: Buffer; filename?: string; mimeType?: string };
function form(parts: Part[], close = true) {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}\r\n${part.mimeType ? `Content-Type: ${part.mimeType}\r\n` : ''}\r\n`,
      ),
    );
    chunks.push(part.bytes, Buffer.from('\r\n'));
  }
  if (close) chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}
const upload = {
  name: 'file',
  filename: 'synthetic.bin',
  mimeType: 'application/octet-stream',
  bytes: Buffer.from([0, 1, 127, 128, 255]),
};

test(
  'signed tenant uploads and transcription parse only complete authenticated multipart bytes over HTTP',
  { timeout: 20_000 },
  async (t) => {
    const ownerId = randomUUID();
    const secret = deriveRuntimeSecret(randomBytes(32), 'development', ownerId);
    const context = { ownerId, secret, environment: 'development', generation: '1' };
    const environment = {
      DOTENV_CONFIG_PATH: '/nonexistent-sidekick-fixture-env',
      DATABASE_URL: 'postgresql://fixture:unused@127.0.0.1:1/unavailable',
      SIDEKICK_MODE: 'tenant',
      SIDEKICK_OWNER_ID: ownerId,
      SIDEKICK_RUNTIME_SECRET: secret,
      SIDEKICK_RUNTIME_GENERATION: '1',
      SIDEKICK_ENVIRONMENT: 'development',
      PGBOSS_SCHEMA: 'sk_jobs_' + 'a'.repeat(32),
    };
    const previous = Object.fromEntries(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, environment);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const { createApp } = await import('../src/server/app.ts');
    const { localArtifacts, maxFileSize } = await import('../src/server/artifacts.ts');
    const { pool } = await import('../src/server/db.ts');
    const writes: { bytes: Buffer; name: string; mimeType: string }[] = [];
    const transcriptions: AudioInput[] = [];
    const app = await createApp({
      artifacts: {
        ...localArtifacts,
        async storeArtifact(bytes, name, mimeType) {
          writes.push({ bytes, name, mimeType });
          const id = randomUUID();
          return { id, name, mimeType, size: bytes.length, url: `/api/artifacts/${id}` };
        },
      },
      speech: {
        async transcribe(input) {
          transcriptions.push(input);
          return 'Synthetic transcription';
        },
        async synthesize() {
          throw new Error('Unexpected speech synthesis');
        },
      },
    });
    const rawRequests = new WeakMap<FastifyRequest, FastifyRequest['raw']>();
    app.addHook('onRequest', async (request) => {
      rawRequests.set(request, request.raw);
    });
    app.addHook('preHandler', async (request) => {
      assert.equal(request.raw, rawRequests.get(request));
    });
    t.after(async () => {
      await app.close();
      await pool.end();
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    function token(target: string, body: Buffer) {
      return signRuntimeRequest({ ...context, method: 'POST', target, body, developer: false });
    }
    const send = (
      target: string,
      body: Buffer,
      signature = token(target, body),
      type = contentType,
    ) =>
      fetch(origin + target, {
        method: 'POST',
        headers: { 'content-type': type, [runtimeHeader]: signature },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(5000),
      });
    await t.test(
      'valid files and audio preserve bytes and metadata; replay and tampering have no effects',
      async () => {
        const bytes = form([{ name: 'context', bytes: Buffer.from('synthetic') }, upload]);
        const signature = token('/api/uploads', bytes);
        const result = await send('/api/uploads', bytes, signature);
        assert.equal(result.status, 200);
        assert.equal((await result.json()).name, upload.filename);
        assert.deepEqual(writes, [
          { bytes: upload.bytes, name: upload.filename, mimeType: upload.mimeType },
        ]);
        assert.equal((await send('/api/uploads', bytes, signature)).status, 401);
        const changed = Buffer.from(bytes);
        changed[changed.length - 1] ^= 1;
        assert.equal(
          (await send('/api/uploads', changed, token('/api/uploads', bytes))).status,
          401,
        );
        assert.equal(writes.length, 1);
        const audio = form([{ ...upload, filename: 'recording.webm', mimeType: 'audio/webm' }]);
        assert.equal((await send('/api/speech/transcribe', audio)).status, 200);
        assert.deepEqual(transcriptions, [
          { bytes: upload.bytes, fileName: 'recording.webm', mimeType: 'audio/webm' },
        ]);
        assert.equal(
          (await send('/api/speech/transcribe', changed, token('/api/speech/transcribe', audio)))
            .status,
          401,
        );
        assert.equal(transcriptions.length, 1);
      },
    );
    await t.test(
      'malformed tails and parser headers fail before artifact or speech calls',
      async () => {
        const before = writes.length;
        const beforeAudio = transcriptions.length;
        for (const body of [
          form([upload], false),
          form(
            [upload, { name: 'unfinished', bytes: Buffer.from('private malformed field') }],
            false,
          ),
          form([
            upload,
            {
              name: 'invalid-json',
              mimeType: 'application/json',
              bytes: Buffer.from('{malformed'),
            },
          ]),
        ]) {
          const response = await send('/api/uploads', body);
          assert.equal(response.status, 400);
          assert.deepEqual(await response.json(), {
            error: 'The uploaded form could not be read.',
          });
          assert.equal((await send('/api/speech/transcribe', body)).status, 400);
        }
        assert.equal(
          (await send('/api/uploads', form([upload]), undefined, 'multipart/form-data')).status,
          400,
        );
        assert.equal(writes.length, before);
        assert.equal(transcriptions.length, beforeAudio);
      },
    );
    await t.test(
      'extra files, extra fields, and oversized files cannot partially publish the first file',
      async () => {
        const before = writes.length;
        for (const body of [
          form([upload, { ...upload, filename: 'extra.bin' }]),
          form([
            upload,
            ...Array.from({ length: 6 }, (_, index) => ({
              name: `field${index}`,
              bytes: Buffer.from('value'),
            })),
          ]),
          form([{ ...upload, bytes: Buffer.alloc(maxFileSize + 1) }]),
          Buffer.alloc(16 * 1024 * 1024 + 1),
        ]) {
          assert.equal((await send('/api/uploads', body)).status, 413);
          assert.equal(writes.length, before);
        }
        const accepted = await send(
          '/api/uploads',
          form([{ ...upload, bytes: Buffer.alloc(maxFileSize) }]),
        );
        assert.equal(accepted.status, 200);
        assert.equal(writes.at(-1)!.bytes.length, maxFileSize);
      },
    );
  },
);

test('the local multipart reader retains the existing request.file path and tenant configuration fails closed', async () => {
  const local = createMultipartReader({ maxFileSize: 1024 });
  const app = Fastify({ forceCloseConnections: true });
  await app.register(multipart, { limits: local.limits });
  app.post('/upload', async (request) => {
    const file = await local.readFile(request);
    return { name: file?.filename, bytes: file?.bytes.toString('base64') };
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(origin + '/upload', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: new Uint8Array(form([upload])),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      name: upload.filename,
      bytes: upload.bytes.toString('base64'),
    });
  } finally {
    await app.close();
  }
  let localReads = 0;
  const tenant = createMultipartReader({ maxFileSize: 1024, verifiedBody: () => undefined });
  await assert.rejects(
    tenant.readFile({
      file: async () => {
        localReads++;
      },
    } as unknown as FastifyRequest),
    { statusCode: 401 },
  );
  assert.equal(localReads, 0);
});
