import { createHash } from 'node:crypto';
import type { Computer, Workspace } from '../../ports/computer.ts';
import type { ComputerAllocationStore } from '../../ports/computer-allocation.ts';
import { taskId } from '../../ports/task-identity.ts';
import { createBridgeComputer } from '../container-browser/client.ts';
import { createCommandWorkspace } from '../docker/index.ts';
import { runSupervisedCommand } from '../docker/command.ts';
import { createE2BAllocation } from './allocation.ts';
import { createE2BClient, type E2BClient } from './client.ts';
import { launchE2BCommand } from './transport.ts';

export function createE2BAdapters(options: {
  apiKey: string;
  ownerId: string;
  templates: { browser: string; workspace: string };
  workspaceRoot: string;
  allocations: ComputerAllocationStore;
  sandboxTimeoutMs?: number;
  requestTimeoutMs?: number;
  leaseMs?: number;
  idlePauseMs?: number;
  maxActiveMs?: number;
  browserTimeoutMs?: number;
  drainTimeoutMs?: number;
  client?: E2BClient;
}): { computer: Computer; workspace: Workspace } {
  const client = options.client ?? createE2BClient(options);
  const allocation = (role: 'browser' | 'workspace') =>
    createE2BAllocation({
      ownerId: options.ownerId,
      role,
      templateId: options.templates[role],
      store: options.allocations,
      client,
      leaseMs: options.leaseMs,
      idlePauseMs: options.idlePauseMs,
      maxActiveMs: options.maxActiveMs,
    });
  const browser = allocation('browser');
  const shell = allocation('workspace');
  let browserUsed = false;
  let browserDisposed = false;
  const computer = createBridgeComputer({
    namespace: `sk-${createHash('sha256').update(options.ownerId).digest('hex').slice(0, 24)}`,
    launch: () => {
      if (browserDisposed) throw new Error('The remote browser is stopped.');
      browserUsed = true;
      return launchE2BCommand(
        browser,
        'cd /app && exec node --import tsx /app/src/providers/container-browser/bridge.ts',
      );
    },
    timeoutMs: options.browserTimeoutMs,
    drainTimeoutMs: options.drainTimeoutMs,
  });
  const workspace = createCommandWorkspace({
    workspaceRoot: options.workspaceRoot,
    status: 'Remote Linux workspace is ready.',
    instructions:
      'This is your own remote Linux workspace, separate from the user’s device and the trusted browser. Node, Python, pipx, git, curl, and ffmpeg are installed. You are an unprivileged user and cannot use sudo. Install trusted command-line tools with npm install -g <package> or pipx install <package>. Internet access follows the server-selected provider policy. There is no graphical display; use a supported CLI or the browser web app. Keep task outputs under this task workspace.',
    runCommand: (id, args, input) =>
      runSupervisedCommand({
        args,
        ...input,
        drainTimeoutMs: options.drainTimeoutMs,
        launch: () =>
          launchE2BCommand(
            shell,
            `mkdir -p /workspace/${taskId(id)} && cd /workspace/${taskId(id)} && exec python3 -u /opt/sidekick/workspace-command.py`,
          ),
      }),
  });
  return {
    computer: {
      ...computer,
      status: () => (browserDisposed ? 'Workspace browser is stopped.' : computer.status()),
      async dispose() {
        if (browserUsed) await computer.dispose();
        browserDisposed = true;
        await browser.dispose();
      },
    },
    workspace: {
      ...workspace,
      async dispose() {
        await workspace.dispose();
        await shell.dispose();
      },
    },
  };
}
