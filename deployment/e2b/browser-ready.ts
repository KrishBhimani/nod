import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import { browserResponse } from '../../src/providers/container-browser/protocol.ts';

export async function checkBrowserWorker(path = '/data/control.sock', timeoutMs = 3_000) {
  const info = await lstat(path);
  if (!info.isSocket() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.())
    throw new Error('The browser worker is not ready.');
  await new Promise<void>((resolve, reject) => {
    const id = randomUUID();
    const socket = connect(path);
    let output = '';
    let finished = false;
    const finish = (ready: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (ready) resolve();
      else reject(new Error('The browser worker is not ready.'));
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(
        JSON.stringify({
          type: 'request',
          request: {
            id,
            namespace: `sk-${randomUUID().replaceAll('-', '').slice(0, 24)}`,
            method: 'dispose',
          },
        }) + '\n',
      );
    });
    socket.on('data', (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > 4_096) return finish(false);
      const end = output.indexOf('\n');
      if (end < 0) return;
      try {
        const result = browserResponse.parse(JSON.parse(output.slice(0, end)));
        finish(result.id === id && result.ok && result.result === null);
      } catch {
        finish(false);
      }
    });
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkBrowserWorker();
  } catch {
    process.stderr.write('The browser worker is not ready.\n');
    process.exitCode = 1;
  }
}
