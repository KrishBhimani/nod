import { spawn } from 'node:child_process';
import { access, chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed (${code}).`)),
    );
  });
try {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && (minor < 22 || (minor === 22 && patch < 3))))
    throw new Error('Use Node.js 22.22.3 or newer.');
  try {
    await access('node_modules/.package-lock.json');
  } catch {
    await run('npm', ['ci']);
  }
  try {
    await access('.env');
  } catch {
    await copyFile('.env.example', '.env');
  }
  await chmod('.env', 0o600);
  await mkdir('.local/workspaces', { recursive: true });
  await run('docker', ['compose', 'up', '-d', '--build', '--wait']);
  try {
    await access('.local/browser-installed');
  } catch {
    await run('npx', ['--no-install', 'agent-browser', 'install']);
    await writeFile('.local/browser-installed', 'installed\n');
  }
  console.log(
    '\nSidekick starts at http://localhost:4310. Add provider keys to .env when ready.\n',
  );
  const child = spawn('npx', ['--no-install', 'tsx', 'watch', 'src/server/index.ts'], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => process.exit(code || 0));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
