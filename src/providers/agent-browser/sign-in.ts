import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ManualBrowserInput } from '../../ports/computer.ts';
import { createSignInDesktop, type SignInDesktop } from './desktop.ts';

export interface BrowserSignInHandle {
  readonly closed: boolean;
  readonly exited: Promise<void>;
  close(options?: { force?: boolean }): Promise<void>;
  screenshot?(signal?: AbortSignal): Promise<Buffer>;
  control?(input: ManualBrowserInput, signal?: AbortSignal): Promise<void>;
}

export async function resolveSignInBrowser(
  profilePath: string,
  options: { browsersDirectory?: string; platform?: NodeJS.Platform } = {},
): Promise<string> {
  const directory = options.browsersDirectory ?? join(homedir(), '.agent-browser', 'browsers');
  const platform = options.platform ?? process.platform;
  const binaryPaths =
    platform === 'darwin'
      ? [
          'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        ]
      : platform === 'linux'
        ? ['chrome', 'chrome-linux64/chrome']
        : platform === 'win32'
          ? ['chrome.exe', 'chrome-win64/chrome.exe']
          : [];
  let version: string;
  try {
    const metadataPath = join(profilePath, 'Last Version');
    const metadata = await lstat(metadataPath);
    if (!metadata.isFile() || metadata.size > 100) throw new Error();
    version = (await readFile(metadataPath, 'utf8')).trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error();
  } catch {
    throw new Error('The task browser version is unavailable. Reopen the website and try again.');
  }
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    if (!entries.some((entry) => entry.isDirectory() && entry.name === `chrome-${version}`))
      throw new Error();
    for (const name of binaryPaths) {
      const executable = join(directory, `chrome-${version}`, name);
      try {
        await access(executable, constants.X_OK);
        if ((await lstat(executable)).isFile()) return executable;
      } catch {}
    }
  } catch {}
  throw new Error(
    'The matching task browser is unavailable. Rebuild the browser container and try again.',
  );
}

export function createBrowserSignIn(
  options: {
    spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
    startupMs?: number;
    closeMs?: number;
    killMs?: number;
    desktop?: (directory: string) => Promise<SignInDesktop>;
    sandbox?: boolean;
  } = {},
) {
  const launch = options.spawn ?? spawn;
  const createDesktop = options.desktop ?? createSignInDesktop();
  const profiles = new Set<string>();

  async function start(input: {
    profilePath: string;
    proxyUrl: string;
    url?: string;
    executablePath?: string;
  }): Promise<BrowserSignInHandle> {
    if (
      !isAbsolute(input.profilePath) ||
      input.profilePath !== resolve(input.profilePath) ||
      dirname(input.profilePath) === input.profilePath
    )
      throw new Error('A private task browser profile is required.');
    if (profiles.has(input.profilePath))
      throw new Error('A sign-in window is already open for this task.');
    let proxy: URL;
    let destination: URL;
    try {
      proxy = new URL(input.proxyUrl);
      destination = new URL(input.url ?? 'about:blank');
    } catch {
      throw new Error('The sign-in browser address is invalid.');
    }
    if (
      proxy.protocol !== 'http:' ||
      proxy.hostname !== '127.0.0.1' ||
      !proxy.port ||
      proxy.username ||
      proxy.password ||
      proxy.pathname !== '/' ||
      proxy.search ||
      proxy.hash
    )
      throw new Error('The protected browser connection is unavailable.');
    if (
      (destination.href !== 'about:blank' && !['http:', 'https:'].includes(destination.protocol)) ||
      destination.username ||
      destination.password
    )
      throw new Error('An HTTP(S) website address without embedded credentials is required.');
    profiles.add(input.profilePath);
    let child: ChildProcess;
    let desktop: SignInDesktop | undefined;
    try {
      await mkdir(input.profilePath, { recursive: true, mode: 0o700 });
      if (!(await lstat(input.profilePath)).isDirectory()) throw new Error();
      await chmod(input.profilePath, 0o700);
      const executable = input.executablePath ?? (await resolveSignInBrowser(input.profilePath));
      if (!isAbsolute(executable)) throw new Error();
      desktop = await createDesktop(dirname(input.profilePath));
      child = launch(
        executable,
        [
          `--user-data-dir=${input.profilePath}`,
          `--proxy-server=${proxy.origin}`,
          '--proxy-bypass-list=<-loopback>',
          '--disable-quic',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--disable-background-networking',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-sync',
          '--password-store=basic',
          '--use-mock-keychain',
          '--restore-last-session',
          '--ozone-platform=x11',
          '--window-position=0,0',
          '--window-size=1280,800',
          ...(options.sandbox === false ? ['--no-sandbox'] : []),
          '--new-window',
          destination.href,
        ],
        { env: desktop.environment, stdio: 'ignore', shell: false },
      );
    } catch {
      await desktop?.close();
      profiles.delete(input.profilePath);
      throw new Error('The sign-in browser could not start. Reopen the website and try again.');
    }

    let closed = false;
    let launchFailed = false;
    let finish: () => void;
    const exited = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onClose = () => {
      closed = true;
      profiles.delete(input.profilePath);
      void desktop!.close().then(finish, () => {});
    };
    child.once('close', onClose);
    child.on('error', () => {
      launchFailed = true;
    });
    let closing: Promise<void> | undefined;
    let forcedClosing: Promise<void> | undefined;
    let quitRequested = false;
    let forced = false;
    const waitForClose = (milliseconds: number) =>
      new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), milliseconds);
        void exited.then(() => {
          clearTimeout(timeout);
          resolve(true);
        });
      });
    const handle: BrowserSignInHandle = {
      get closed() {
        return closed;
      },
      exited,
      screenshot(signal) {
        if (closed || quitRequested || forced)
          return Promise.reject(new Error('The sign-in browser is closed.'));
        return desktop!.screenshot(signal);
      },
      control(input, signal) {
        if (closed || quitRequested || forced)
          return Promise.reject(new Error('The sign-in browser is closed.'));
        return desktop!.control(input, signal);
      },
      close({ force = false } = {}) {
        if (force) {
          if (closed) return desktop!.close();
          forced = true;
          forcedClosing ??= (async () => {
            child.kill('SIGTERM');
            if (await waitForClose(options.closeMs ?? 3000)) return;
            child.kill('SIGKILL');
            if (await waitForClose(options.killMs ?? 1000)) return;
            throw new Error(
              'The workspace sign-in browser could not close. Restart its container before continuing.',
            );
          })().finally(() => {
            forcedClosing = undefined;
          });
          return forcedClosing;
        }
        if (closed && !forced) return desktop!.close();
        closing ??= (async () => {
          if (!quitRequested && !forced) {
            quitRequested = true;
            child.kill('SIGINT');
          }
          if (!forced && (await waitForClose(options.closeMs ?? 3000)) && !forced) return;
          throw new Error(
            'The workspace sign-in browser is still closing. Try Continue in Sidekick again.',
          );
        })().finally(() => {
          closing = undefined;
        });
        return closing;
      },
    };
    void desktop.exited.then(() => {
      if (!closed) void handle.close({ force: true }).catch(() => {});
    });
    await new Promise<void>((resolve) => setTimeout(resolve, options.startupMs ?? 350));
    if (closed || launchFailed) {
      await handle.close({ force: true });
      throw new Error(
        'The workspace sign-in browser could not start. Restart its container and try again.',
      );
    }
    return handle;
  }

  return { start };
}
