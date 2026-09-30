import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const role = process.argv[2];
let worker;
let workerExit;
let server;
let stopping;

function socketReady() {
  return new Promise((resolve) => {
    const socket = connect('/data/control.sock');
    const id = '00000000-0000-4000-8000-000000000000';
    let incoming = '';
    const finish = (ready) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(500, () => finish(false));
    socket.setEncoding('utf8');
    socket.once('connect', () =>
      socket.write(
        JSON.stringify({
          type: 'request',
          request: { id, namespace: 'sk-000000000000000000000000', method: 'quiesce' },
        }) + '\n',
      ),
    );
    socket.on('data', (chunk) => {
      incoming += chunk;
      const end = incoming.indexOf('\n');
      if (end < 0) return;
      try {
        const response = JSON.parse(incoming.slice(0, end));
        finish(response.id === id && response.ok === true && response.result === true);
      } catch {
        finish(false);
      }
    });
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

function stop(code) {
  if (stopping) return stopping;
  stopping = (async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGTERM');
      const timer = setTimeout(() => {
        code = 1;
        try {
          process.kill(-worker.pid, 'SIGKILL');
        } catch {}
      }, 10_000);
      await workerExit;
      clearTimeout(timer);
    }
    process.exitCode = code;
  })();
  return stopping;
}

async function verifyHelper(name) {
  const path = `/opt/otto/${name}`;
  const file = await lstat(path);
  if (!file.isFile() || file.uid !== 0 || file.mode & 0o222) throw new Error();
  await access(path, constants.R_OK);
}

try {
  process.umask(0o077);
  if (
    !['browser', 'workspace'].includes(role) ||
    process.argv.length !== 3 ||
    process.getuid() === 0
  )
    throw new Error();
  await verifyHelper('checkpoint.py');
  if (role === 'workspace') await verifyHelper('workspace-command.py');
  process.once('SIGTERM', () => void stop(0));
  process.once('SIGINT', () => void stop(0));
  if (role === 'browser') {
    worker = spawn(
      process.execPath,
      ['--import', 'tsx', '/app/src/providers/container-browser/worker.ts'],
      {
        cwd: '/app',
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/node', LANG: 'C.UTF-8' },
        detached: true,
        stdio: 'ignore',
      },
    );
    workerExit = new Promise((resolve) => {
      worker.once('error', () => resolve(1));
      worker.once('exit', (code) => resolve(code ?? 1));
    });
    void workerExit.then(() => {
      if (!stopping) void stop(1);
    });
    const deadline = Date.now() + 30_000;
    while (!(await socketReady())) {
      if (stopping || Date.now() >= deadline) throw new Error();
      await delay(100);
    }
  }
  if (!stopping) {
    server = createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      if (request.method !== 'GET' || request.url !== '/health') {
        response.writeHead(404).end();
        return;
      }
      const ready = !stopping && (role === 'workspace' || (await socketReady()));
      response.writeHead(ready ? 200 : 503).end();
    });
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(4311, '0.0.0.0', resolve);
    });
  }
} catch {
  await stop(1);
}
