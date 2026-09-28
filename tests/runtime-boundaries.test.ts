import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  browserCandidates,
  browserSessionId,
  redactBrowserText,
} from '../src/providers/agent-browser/index.ts';
import { validateJevChoice } from '../src/providers/jev/browser.ts';
import { isPublicAddress, publicUrl } from '../src/providers/agent-browser/network.ts';
import { runProcess, serviceEnvironment } from '../src/providers/process.ts';
import { createDockerWorkspace, workspaceFile } from '../src/providers/docker/index.ts';
import { taskId } from '../src/ports/task-identity.ts';

test('public web validation rejects local, private, rebinding and credential URLs', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.20.1.2',
    '192.168.1.2',
    '169.254.169.254',
    '100.100.100.200',
    '0.0.0.0',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of [
    '93.184.216.34',
    '1.1.1.1',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
  ])
    assert.equal(isPublicAddress(address), true, address);
  for (const url of [
    'file:///etc/passwd',
    'http://localhost',
    'http://2130706433',
    'http://[::1]',
    'https://user:secret@example.com',
    'https://example.com:9222',
  ])
    await assert.rejects(publicUrl(url));
  await assert.rejects(
    publicUrl('https://example.com', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]),
  );
  assert.equal(
    (await publicUrl('https://example.com', async () => [{ address: '93.184.216.34', family: 4 }]))
      .address,
    '93.184.216.34',
  );
});

test('workspace paths cannot address host files or other task directories', () => {
  assert.equal(workspaceFile('task-a', 'report.txt'), '/workspace/task-a/report.txt');
  assert.equal(
    workspaceFile('task-a', '/workspace/task-a/report.txt'),
    '/workspace/task-a/report.txt',
  );
  for (const path of ['/etc/passwd', '../task-b/private.txt', '..\\secret', 'file\0name'])
    assert.throws(() => workspaceFile('task-a', path));
  assert.throws(() => taskId('../escape'));
});

test('workspace artifact reads reject paths outside the container task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-runtime-'));
  try {
    const workspace = join(directory, 'task-a');
    await mkdir(workspace);
    await writeFile(join(directory, 'private.txt'), 'fixture');
    await symlink(join(directory, 'private.txt'), join(workspace, 'escape.txt'));
    let launched = 0;
    const runner = createDockerWorkspace({
      container: 'otto-workspace',
      workspaceRoot: directory,
      spawn: () => {
        launched++;
        throw new Error('Unexpected workspace launch.');
      },
    });
    runner.open({
      taskId: 'task-a',
      workspacePath: workspace,
      signal: new AbortController().signal,
    });
    await assert.rejects(
      runner.readArtifact!('task-a', '../private.txt', 1024),
      /^Error: Files must stay within the task workspace\.$/,
    );
    assert.equal(launched, 0);
    assert.throws(() =>
      runner.open({
        taskId: 'task-b',
        workspacePath: workspace,
        signal: new AbortController().signal,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime subprocesses do not inherit provider keys and stop at bounds', async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-secret-not-for-child';
  try {
    assert.equal(serviceEnvironment().OPENAI_API_KEY, undefined);
    const result = await runProcess(process.execPath, [
      '-e',
      'process.stdout.write(String(process.env.OPENAI_API_KEY)); process.stderr.write("fixture-error")',
    ]);
    assert.equal(result.stdout, 'undefined');
    assert.equal(result.stderr, 'fixture-error');
    await assert.rejects(
      runProcess(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 30 }),
      /limit/,
    );
    await assert.rejects(
      runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], {
        maxBytes: 100,
      }),
      /limit/,
    );
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('browser redaction and Jev choices do not expose known secrets or invent targets', () => {
  assert.equal(
    redactBrowserText('Account fixture-secret was used', ['fixture-secret']),
    'Account [redacted] was used',
  );
  const candidates = browserCandidates(
    '- button "Continue" [ref=e2]\n- textbox "Email" [ref=e3]\n- button "Disabled" [ref=e4] [disabled]',
  );
  assert.deepEqual(
    candidates.map((item) => item.id),
    ['@e2'],
  );
  assert.deepEqual(
    validateJevChoice(
      { operation: { choice: 'CLICK' }, click_target: { choice: '@e2' } },
      candidates,
    ).action,
    { action: 'click', selector: '@e2' },
  );
  assert.throws(() =>
    validateJevChoice(
      { operation: { choice: 'CLICK' }, click_target: { choice: '@e3' } },
      candidates,
    ),
  );
  assert.throws(() => validateJevChoice({ operation: { choice: 'EVAL' } }, candidates));
});

test('browser sessions fit macOS socket paths for UUID task identifiers', () => {
  const first = browserSessionId('12345678-1234-1234-1234-123456789012');
  assert.ok(first.length <= 27);
  assert.equal(first, browserSessionId('12345678-1234-1234-1234-123456789012'));
  assert.notEqual(first, browserSessionId('22345678-1234-1234-1234-123456789012'));
});
