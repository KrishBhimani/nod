import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { RuntimeContext } from '../shared/contracts.ts';
import { runProcess } from './process.ts';

export function taskId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid task identifier.');
  return value;
}

export function workspaceFile(id: string, path: string): string {
  const base = `/workspace/${taskId(id)}`;
  if (!path || path.includes('\0') || path.includes('\\')) throw new Error('A workspace file path is required.');
  const full = resolve(base, path);
  if (full !== base && !full.startsWith(base + '/')) throw new Error('Files must stay within the task workspace.');
  return full;
}

export async function dockerCommand(id: string, args: string[], options: { input?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  const container = process.env.WORKSPACE_CONTAINER || 'sidekick-workspace';
  if (!/^sidekick-workspace(?:-[a-zA-Z0-9_-]+)?$/.test(container)) throw new Error('WORKSPACE_CONTAINER must identify a Sidekick workspace.');
  const seconds = Math.max(1, Math.ceil((options.timeoutMs ?? 30_000) / 1000));
  const result = await runProcess('docker', ['exec', '-i', '--workdir', `/workspace/${taskId(id)}`, container, 'timeout', '--signal=TERM', '--kill-after=2s', `${seconds}s`, ...args], { ...options, timeoutMs: seconds * 1000 + 5000 });
  if (result.exitCode) throw new Error(`Workspace command failed (${result.exitCode}).\n${(result.stdout + result.stderr).slice(0,20_000)}`);
  return result.stdout + result.stderr;
}

const fileProgram = `import os,sys,json\nr=json.load(sys.stdin)\nbase=os.path.realpath(r['base'])\np=os.path.realpath(r['path'])\nif os.path.commonpath([base,p])!=base: raise ValueError('Path outside workspace')\nif r['action']=='read':\n with open(p,'rb') as f: data=f.read(65537)\n if len(data)>65536: raise ValueError('File too large; use bounded shell commands')\n sys.stdout.write(data.decode('utf-8'))\nelse:\n os.makedirs(os.path.dirname(p),exist_ok=True)\n with open(p,'w',encoding='utf-8') as f: f.write(r['content'])\n print('File saved')`;

export async function readWorkspace(context: RuntimeContext, path: string): Promise<string> {
  return dockerCommand(context.taskId, ['python3', '-c', fileProgram], { input: JSON.stringify({ action: 'read', base: `/workspace/${taskId(context.taskId)}`, path: workspaceFile(context.taskId, path) }), signal: context.signal });
}

export async function writeWorkspace(context: RuntimeContext, path: string, content: string): Promise<string> {
  if (Buffer.byteLength(content) > 256 * 1024) throw new Error('File content exceeds 256 KB.');
  return dockerCommand(context.taskId, ['python3', '-c', fileProgram], { input: JSON.stringify({ action: 'write', base: `/workspace/${taskId(context.taskId)}`, path: workspaceFile(context.taskId, path), content }), signal: context.signal });
}

export async function publishWorkspace(context: RuntimeContext, path: string, name?: string) {
  const containerPath = workspaceFile(context.taskId, path);
  const subpath = relative(`/workspace/${taskId(context.taskId)}`, containerPath);
  const root = await realpath(context.workspacePath);
  const file = await realpath(resolve(root, subpath));
  const local = relative(root, file);
  if (!local || local.startsWith('..' + sep) || local === '..' || isAbsolute(local)) throw new Error('Only files inside the task workspace can be published.');
  return context.publish(file, name);
}
