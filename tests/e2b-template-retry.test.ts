import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const templateId = 'synthetic-template';
const buildId = '11111111-1111-4111-8111-111111111111';
const templateName = 'otto-template-retry-fixture';

for (const stage of ['create', 'start'] as const) {
  for (const failure of ['throttled', 'disconnected'] as const) {
    test(`template ${stage} is attempted once after a ${failure} response`, async (context) => {
      const requests: Array<{ method: string; path: string }> = [];
      const errors: unknown[] = [];
      const server = createServer(async (request, response) => {
        try {
          assert.equal(request.headers['x-api-key'], 'synthetic-build-key');
          const path = request.url ?? '';
          const method = request.method ?? '';
          requests.push({ method, path });
          let body = '';
          for await (const chunk of request) {
            body += chunk.toString();
            assert.ok(Buffer.byteLength(body) <= 64 * 1024);
          }
          const create = method === 'POST' && path === '/v3/templates';
          const start =
            method === 'POST' && path === `/v2/templates/${templateId}/builds/${buildId}`;
          if (create) {
            assert.deepEqual(JSON.parse(body), {
              name: templateName,
              cpuCount: 2,
              memoryMB: 3072,
            });
          } else if (start) {
            const template = JSON.parse(body);
            assert.equal(template.startCmd, 'exec python3 /opt/otto/computer-guard.py start');
            assert.equal(template.readyCmd, 'python3 /opt/otto/computer-guard.py check');
            assert.ok(template.steps.some((step: { type: string }) => step.type === 'COPY'));
          }
          if ((stage === 'create' && create) || (stage === 'start' && start)) {
            if (failure === 'disconnected') {
              request.socket.destroy();
            } else {
              response.writeHead(429, {
                'Content-Type': 'application/json',
                'Retry-After': '0',
              });
              response.end(JSON.stringify({ message: 'Synthetic throttling' }));
            }
            return;
          }
          if (create) {
            response.writeHead(202, { 'Content-Type': 'application/json' });
            response.end(
              JSON.stringify({
                templateID: templateId,
                buildID: buildId,
                names: [templateName],
                aliases: [templateName],
                tags: [],
                public: false,
              }),
            );
            return;
          }
          if (
            method === 'GET' &&
            new RegExp(`^/templates/${templateId}/files/[a-f0-9]{64}$`).test(path)
          ) {
            response.writeHead(201, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ present: true }));
            return;
          }
          throw new Error('Unexpected synthetic build request');
        } catch (error) {
          errors.push(error);
          response.writeHead(500, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ message: 'Synthetic fixture rejected the request' }));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      context.after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const address = server.address() as AddressInfo;
      const endpoint = `http://127.0.0.1:${address.port}`;
      const module = new URL('../deployment/e2b/build.ts', import.meta.url).href;
      const program = `
        import { buildE2BTemplate } from ${JSON.stringify(module)};
        globalThis.fetch = () => { throw new Error('Unexpected global transport'); };
        let outcome = 'succeeded';
        try {
          await buildE2BTemplate({ role: 'computer', name: ${JSON.stringify(templateName)}, apiKey: 'synthetic-build-key' });
        } catch {
          outcome = 'rejected';
        }
        process.stdout.write(JSON.stringify({ outcome }) + '\\n');
      `;
      const result = await execute(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', program],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          env: { PATH: process.env.PATH, E2B_API_URL: endpoint },
          encoding: 'utf8',
          timeout: 15_000,
          maxBuffer: 4096,
        },
      );
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), { outcome: 'rejected' });
      assert.deepEqual(errors, []);
      assert.equal(requests.filter((request) => request.path === '/v3/templates').length, 1);
      const starts = requests.filter((request) => request.method === 'POST').slice(1);
      assert.deepEqual(
        starts,
        stage === 'start'
          ? [{ method: 'POST', path: `/v2/templates/${templateId}/builds/${buildId}` }]
          : [],
      );
      const reads = requests.filter((request) => request.method === 'GET');
      if (stage === 'create') assert.deepEqual(reads, []);
      else
        assert.ok(reads.length > 0 && reads.every((request) => request.path.includes('/files/')));
    });
  }
}
