import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('the integration runner fails when the test process is terminated by a signal', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-test-runner-'));
  try {
    await mkdir(join(directory, 'tests'));
    await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    await writeFile(
      join(directory, 'tests', 'terminated.test.ts'),
      "import { writeFileSync } from 'node:fs';\nwriteFileSync('termination-reached', 'yes');\nprocess.kill(process.ppid, 'SIGKILL');\n",
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      TEST_DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/unused',
    };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(root, 'scripts', 'test-integration.mjs')],
      {
        cwd: directory,
        env: environment,
        stdio: 'ignore',
        timeout: 10_000,
      },
    );
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      },
    );
    assert.equal(await readFile(join(directory, 'termination-reached'), 'utf8'), 'yes');
    assert.deepEqual(result, { code: 1, signal: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
