import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { integrationDatabaseUrl } from './local-database.ts';

const files = (await readdir('tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `tests/${name}`);
const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=2', ...files],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      TEST_DATABASE_URL: await integrationDatabaseUrl(process.cwd()),
    },
  },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code || 0;
});
