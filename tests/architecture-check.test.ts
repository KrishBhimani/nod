import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

test('architecture checks include static template imports without executing source', async () => {
  const directory = await mkdtemp('/tmp/sidekick-architecture-');
  try {
    await mkdir(join(directory, 'src/runtime'), { recursive: true });
    const script = fileURLToPath(new URL('../scripts/check-architecture.mjs', import.meta.url));
    for (const expression of [
      "import('@composio/core')",
      'import(`@composio/core`)',
      'import(`../providers/example.ts`)',
    ]) {
      await writeFile(join(directory, 'src/runtime/example.ts'), expression);
      await assert.rejects(
        promisify(execFile)(process.execPath, [script], { cwd: directory }),
        (error: Error & { stderr?: string }) =>
          /belongs in providers|crosses the runtime boundary/.test(error.stderr ?? ''),
      );
    }
    await writeFile(join(directory, 'src/runtime/example.ts'), 'import(`../ports/computer.ts`)');
    await promisify(execFile)(process.execPath, [script], { cwd: directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
