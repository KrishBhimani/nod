import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import { createBrowserSignIn } from '../src/providers/agent-browser/sign-in.ts';
import { startContainerBrowserWorker } from '../src/providers/container-browser/worker.ts';
import { containerBrowserOptions } from '../src/providers/container-browser/config.ts';
import { createFixtureProxy } from './e2e-fixtures.ts';

const worker = await startContainerBrowserWorker({
  createComputer: async (dataRoot) => {
    const proxy = await createFixtureProxy(join(dataRoot, 'certificate'), (kind, fields = {}) => {
      process.stdout.write(JSON.stringify({ kind, ...fields }) + '\n');
    });
    const computer = createAgentBrowserComputer({
      ...containerBrowserOptions(dataRoot),
      run: proxy.run,
      signInLauncher: createBrowserSignIn({
        sandbox: false,
        spawn: (command, args, options) => spawn(command, proxy.nativeArgs(args), options),
      }),
    });
    return {
      ...computer,
      dispose: async () => {
        try {
          await computer.dispose?.();
        } finally {
          await proxy.close();
        }
      },
    };
  },
});
const stop = () => void worker.close().finally(() => process.exit(0));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
