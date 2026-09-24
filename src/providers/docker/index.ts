import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Workspace } from '../../ports/computer.ts';
import { taskId } from '../../ports/task-identity.ts';
import { runProcess } from '../process.ts';

export function workspaceFile(id: string, path: string): string {
  const base = `/workspace/${taskId(id)}`;
  if (!path || path.includes('\0') || path.includes('\\'))
    throw new Error('A workspace file path is required.');
  const full = resolve(base, path);
  if (full !== base && !full.startsWith(base + '/'))
    throw new Error('Files must stay within the task workspace.');
  return full;
}

async function dockerCommand(
  container: string,
  id: string,
  args: string[],
  options: { input?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  if (!/^sidekick-workspace(?:-[a-zA-Z0-9_-]+)?$/.test(container))
    throw new Error('WORKSPACE_CONTAINER must identify a Sidekick workspace.');
  const seconds = Math.max(1, Math.ceil((options.timeoutMs ?? 30_000) / 1000));
  const result = await runProcess(
    'docker',
    [
      'exec',
      '-i',
      '--user',
      'node',
      '--workdir',
      `/workspace/${taskId(id)}`,
      container,
      'timeout',
      '--signal=TERM',
      '--kill-after=2s',
      `${seconds}s`,
      ...args,
    ],
    { ...options, timeoutMs: seconds * 1000 + 5000 },
  );
  if (result.exitCode)
    throw new Error(
      `Workspace command failed (${result.exitCode}).\n${(result.stdout + result.stderr).slice(0, 20_000)}`,
    );
  return result.stdout + result.stderr;
}

const fileProgram = `import os,sys,json\nr=json.load(sys.stdin)\nbase=os.path.realpath(r['base'])\np=os.path.realpath(r['path'])\nif os.path.commonpath([base,p])!=base: raise ValueError('Path outside workspace')\nif r['action']=='read':\n with open(p,'rb') as f: data=f.read(65537)\n if len(data)>65536: raise ValueError('File too large; use bounded shell commands')\n sys.stdout.write(data.decode('utf-8'))\nelse:\n os.makedirs(os.path.dirname(p),exist_ok=True)\n with open(p,'w',encoding='utf-8') as f: f.write(r['content'])\n print('File saved')`;

export function createDockerWorkspace(options: {
  container: string;
  workspaceRoot: string;
}): Workspace {
  return {
    status: () => `${options.container}; Linux · public internet enabled`,
    dispose: () => {},
    open(input) {
      const id = taskId(input.taskId);
      if (resolve(input.workspacePath) !== resolve(options.workspaceRoot, id))
        throw new Error('The task workspace does not match its configured root.');
      const base = `/workspace/${id}`;
      const file = (action: 'read' | 'write', path: string, content?: string) =>
        dockerCommand(options.container, id, ['python3', '-c', fileProgram], {
          input: JSON.stringify({ action, base, path: workspaceFile(id, path), content }),
          signal: input.signal,
        });
      return {
        path: base,
        instructions:
          'This is your own Linux computer, not the user’s personal device. It has public internet access; private networks and host services are blocked. Node, Python, pipx, git, curl, and ffmpeg are installed. Install trusted CLI tools with npm install -g <package> or pipx install <package>; /home/node persists across tasks and restarts. You are an unprivileged user and cannot use sudo. There is no graphical desktop or display, so native GUI applications cannot run here; use a supported CLI or the browser web app. Keep task outputs under this task workspace; do not ask the user to install your tools on their device.',
        execute: (command, timeoutSeconds = 30) =>
          dockerCommand(options.container, id, ['sh', '-c', command], {
            signal: input.signal,
            timeoutMs: Math.max(1, Math.min(timeoutSeconds, 120)) * 1000,
          }),
        readFile: (path) => file('read', path),
        writeFile: async (path, content) => {
          if (Buffer.byteLength(content) > 256 * 1024)
            throw new Error('File content exceeds 256 KB.');
          return file('write', path, content);
        },
        resolveArtifact: async (path) => {
          const subpath = relative(base, workspaceFile(id, path));
          const root = await realpath(input.workspacePath);
          const file = await realpath(resolve(root, subpath));
          const local = relative(root, file);
          if (!local || local.startsWith('..' + sep) || local === '..' || isAbsolute(local))
            throw new Error('Only files inside the task workspace can be published.');
          return file;
        },
      };
    },
  };
}
