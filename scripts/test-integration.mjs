import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';

const files = (await readdir('tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `tests/${name}`);
const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TEST_DATABASE_URL:
      process.env.TEST_DATABASE_URL ||
      'postgresql://sidekick:sidekick-local@127.0.0.1:54329/sidekick',
  },
});
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code || 0;
});
