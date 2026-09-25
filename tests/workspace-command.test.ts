import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  runWorkspaceCommand,
  WorkspaceCommandError,
  type WorkspaceCommandLauncher,
} from '../src/providers/docker/command.ts';
import { artifactReadProgram } from '../src/providers/docker/index.ts';

async function local() {
  const directory = await mkdtemp('/tmp/sidekick-command-');
  const launch: WorkspaceCommandLauncher = (_command, args, options) =>
    spawn('python3', ['-u', '-c', args.at(-1)!], { ...options, cwd: directory, stdio: 'pipe' });
  return {
    directory,
    run: (args: string[], options: Partial<Parameters<typeof runWorkspaceCommand>[0]> = {}) =>
      runWorkspaceCommand({
        container: 'sidekick-workspace-fixture',
        taskId: 'fixture',
        args,
        spawn: launch,
        ...options,
      }),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
async function exists(path: string) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
async function ready(path: string) {
  for (let i = 0; i < 200; i++) {
    if (await exists(path)) return;
    await delay(10);
  }
  throw new Error('The synthetic process did not start.');
}

test('workspace transport returns binary output and sends command and input only over stdin', async () => {
  const f = await local();
  try {
    const result = await f.run([
      'python3',
      '-c',
      'import sys;sys.stdout.buffer.write(bytes([0,255,128]));sys.stderr.write("note")',
    ]);
    assert.deepEqual(result.stdout, Buffer.from([0, 255, 128]));
    assert.equal(result.stderr.toString(), 'note');
    assert.equal(result.exitCode, 0);
    const echo = await f.run(['python3', '-c', 'import sys;sys.stdout.write(sys.stdin.read())'], {
      input: 'Olá 🔒',
    });
    assert.equal(echo.stdout.toString(), 'Olá 🔒');
  } finally {
    await f.close();
  }
});

test('cancel waits for the remote process group, including a child ignoring TERM', async () => {
  const f = await local();
  const controller = new AbortController();
  try {
    const command =
      'import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); open("ready","w").close(); time.sleep(3); open("late","w").write("unexpected")';
    const operation = f.run(['sh', '-c', `python3 -c '${command}' & wait`], {
      signal: controller.signal,
    });
    const rejected = assert.rejects(
      operation,
      (error: unknown) =>
        error instanceof WorkspaceCommandError &&
        !error.uncertain &&
        error.message === 'Task cancelled.',
    );
    await ready(join(f.directory, 'ready'));
    const started = Date.now();
    controller.abort();
    await rejected;
    assert.ok(Date.now() - started >= 1800);
    await delay(1100);
    assert.equal(await exists(join(f.directory, 'late')), false);
    assert.equal((await f.run(['printf', 'ready again'])).stdout.toString(), 'ready again');
  } finally {
    controller.abort();
    await f.close();
  }
});

test('output overflow and timeout drain the remote command before rejecting', async () => {
  for (const limited of [true, false]) {
    const f = await local();
    try {
      const operation = f.run(
        [
          'python3',
          '-c',
          `${limited ? 'import sys;sys.stdout.write("x"*20000);sys.stdout.flush();' : ''}import time;time.sleep(1);open("late","w").close()`,
        ],
        { maxBytes: 1024, timeoutMs: limited ? 3000 : 100 },
      );
      await assert.rejects(
        operation,
        (error: unknown) =>
          error instanceof WorkspaceCommandError && !error.uncertain && /limit/.test(error.message),
      );
      await delay(1100);
      assert.equal(await exists(join(f.directory, 'late')), false);
    } finally {
      await f.close();
    }
  }
});

test('artifact descriptor reads reject symlinks, special files and oversized data', async () => {
  const f = await local();
  try {
    const base = join(f.directory, 'task');
    await mkdir(join(base, 'nested'), { recursive: true });
    await writeFile(join(base, 'nested', 'ok'), Buffer.from([0, 255, 4]));
    await writeFile(join(f.directory, 'private'), 'synthetic outside value');
    await symlink(join(f.directory, 'private'), join(base, 'linked'));
    await symlink(f.directory, join(base, 'linked-directory'));
    const read = (path: string, maxBytes = 100) =>
      f.run(['python3', '-c', artifactReadProgram], {
        input: JSON.stringify({ base, path, maxBytes }),
        maxBytes,
      });
    assert.deepEqual((await read('nested/ok')).stdout, Buffer.from([0, 255, 4]));
    for (const path of [
      'linked',
      'linked-directory/private',
      '../private',
      'nested/../nested/ok',
      '.',
    ])
      assert.notEqual((await read(path)).exitCode, 0, path);
    assert.notEqual((await read('nested/ok', 2)).exitCode, 0);
    await f.run(['mkfifo', join(base, 'pipe')]);
    assert.notEqual((await read('pipe')).exitCode, 0);
  } finally {
    await f.close();
  }
});

test('a lost acknowledgement fences the workspace instead of accepting another command', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { createDockerWorkspace } = await import('../src/providers/docker/index.ts');
  let launched = 0;
  const launch: WorkspaceCommandLauncher = () => {
    launched++;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        return true;
      },
    });
    child.stdin.once('data', () => queueMicrotask(() => child.emit('close', 1)));
    return child as unknown as ReturnType<WorkspaceCommandLauncher>;
  };
  const workspace = createDockerWorkspace({
    container: 'sidekick-workspace-fixture',
    workspaceRoot: '/synthetic',
    spawn: launch,
  });
  const session = workspace.open({
    taskId: 'fixture',
    workspacePath: '/synthetic/fixture',
    signal: new AbortController().signal,
  });
  try {
    await assert.rejects(session.execute('printf fixture'), /did not stop safely/);
    await assert.rejects(session.execute('printf later'), /Restart Sidekick/);
    assert.equal(launched, 1);
    assert.equal(workspace.status(), 'Workspace needs a restart.');
  } finally {
    await workspace.dispose();
  }
});
