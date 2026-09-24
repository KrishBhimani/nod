import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  BrowserAction,
  BrowserObservation,
  Computer,
  CredentialInput,
} from '../../ports/computer.ts';
import { taskId } from '../../ports/task-identity.ts';
import { runProcess, serviceEnvironment } from '../process.ts';
import { createBrowserProxy, publicUrl } from './network.ts';
import { credentialFields, credentialScript } from './credentials.ts';

interface BrowserState {
  id: string;
  queue: Promise<unknown>;
  injecting: boolean;
  secrets: Set<string>;
  protectedSelectors: Set<string>;
  started: boolean;
  lastUsed: number;
  busy: number;
  closed: boolean;
}
export class BrowserLockedError extends Error {
  statusCode = 423;
  constructor() {
    super('Browser observations are paused during credential entry.');
  }
}
export function browserSessionId(id: string): string {
  return `sk-${createHash('sha256').update(taskId(id)).digest('hex').slice(0, 24)}`;
}

export function redactBrowserText(text: string, secrets: Iterable<string>): string {
  let result = text;
  for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]');
  return result.replace(/(password[^\n]*?)(?:value=|: )[^\n]*/gi, '$1 [redacted]');
}

export function browserCandidates(snapshot: string): Array<{ id: string; label: string }> {
  const candidates: Array<{ id: string; label: string }> = [];
  for (const line of snapshot.split('\n')) {
    const match = line.match(/\[ref=(e\d+)\]/);
    if (
      match &&
      /\b(button|link|checkbox|radio|tab|menuitem|option)\b/.test(line) &&
      !/disabled/i.test(line)
    )
      candidates.push({ id: '@' + match[1], label: line.trim().slice(0, 350) });
  }
  return candidates.slice(0, 100);
}

export function createAgentBrowserComputer(options: {
  dataRoot: string;
  executable?: string;
  idleTimeoutMs?: number;
  run?: typeof runProcess;
}): Computer {
  const browsers = new Map<string, BrowserState>();
  const runtimeRoot = resolve(options.dataRoot, 'runtime');
  const executable =
    options.executable ?? resolve(process.cwd(), 'node_modules/.bin/agent-browser');
  const run = options.run ?? runProcess;
  const idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
  const proxy = createBrowserProxy();
  let disposed = false;
  function stateFor(id: string): BrowserState {
    if (disposed) throw new Error('The browser service has stopped.');
    taskId(id);
    let state = browsers.get(id);
    if (!state) {
      state = {
        id,
        queue: Promise.resolve(),
        injecting: false,
        secrets: new Set(),
        protectedSelectors: new Set(),
        started: false,
        lastUsed: Date.now(),
        busy: 0,
        closed: false,
      };
      browsers.set(id, state);
    }
    return state;
  }

  function serialize<T>(state: BrowserState, operation: () => Promise<T>): Promise<T> {
    state.lastUsed = Date.now();
    const execute = async () => {
      if (state.closed) throw new Error('The browser session has expired. Open the URL again.');
      state.busy += 1;
      try {
        return await operation();
      } finally {
        state.busy -= 1;
        state.lastUsed = Date.now();
      }
    };
    const pending = state.queue.then(execute, execute);
    state.queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  function selector(value: string | undefined): string {
    if (!value || value.length > 500 || /^[\s-]/.test(value) || value.includes('\0'))
      throw new Error('A valid observed selector or element reference is required.');
    return value;
  }

  async function command(
    state: BrowserState,
    args: string[],
    options: { input?: string; signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const config = resolve(runtimeRoot, 'browser-config.json');
    await writeFile(config, '{}', { mode: 0o600 });
    const proxyUrl = await proxy.url();
    const profile = resolve(runtimeRoot, 'profiles', state.id);
    const result = await run(
      executable,
      [
        '--config',
        config,
        '--namespace',
        `sk-${createHash('sha256').update(runtimeRoot).digest('hex').slice(0, 12)}`,
        '--session',
        browserSessionId(state.id),
        '--profile',
        profile,
        '--json',
        '--proxy',
        proxyUrl,
        '--proxy-bypass',
        '<-loopback>',
        '--args',
        '--disable-quic,--force-webrtc-ip-handling-policy=disable_non_proxied_udp,--disable-background-networking',
        '--download-path',
        resolve(runtimeRoot, 'downloads', state.id),
        '--idle-timeout',
        `${Math.ceil(idleTimeoutMs / 1000)}s`,
        ...args,
      ],
      {
        cwd: runtimeRoot,
        env: serviceEnvironment(),
        input: options.input,
        signal: options.signal,
        timeoutMs: 45_000,
        maxBytes: 256 * 1024,
      },
    );
    let response: { success?: boolean; data?: Record<string, unknown> };
    try {
      response = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error(
        'Browser command failed. Confirm Chrome is installed and restart the browser.',
      );
    }
    if (result.exitCode || response.success === false)
      throw new Error('Browser action could not complete. Observe the page again before retrying.');
    return response.data ?? {};
  }

  async function evaluate(state: BrowserState, script: string): Promise<unknown> {
    return (await command(state, ['eval', '--stdin'], { input: script })).result;
  }

  async function currentUrl(state: BrowserState): Promise<string> {
    const data = await command(state, ['get', 'url']);
    const url = String(data.url ?? data.value ?? '');
    await publicUrl(url);
    return url;
  }

  async function maskFields(state: BrowserState): Promise<void> {
    await evaluate(
      state,
      `(() => { const selectors=${JSON.stringify([...state.protectedSelectors])}; const nodes=new Set(document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"]')); for (const s of selectors) { try { for(const e of document.querySelectorAll(s)) nodes.add(e); } catch {} } for(const e of nodes) { e.style.setProperty('color','transparent','important'); e.style.setProperty('text-shadow','none','important'); e.style.setProperty('-webkit-text-security','disc','important'); } return {masked:true}; })()`,
    );
  }

  async function observe(state: BrowserState): Promise<BrowserObservation> {
    if (state.injecting) throw new BrowserLockedError();
    const url = await currentUrl(state);
    await maskFields(state);
    const visible = await evaluate(
      state,
      `(() => ({ text: String(document.body?.innerText ?? '').slice(0, 16000) }))()`,
    );
    const body =
      visible && typeof visible === 'object' && 'text' in visible ? String(visible.text) : '';
    const data = await command(state, ['snapshot', '-c']);
    const structure = redactBrowserText(
      String(data.snapshot ?? data.text ?? JSON.stringify(data)),
      state.secrets,
    ).slice(0, 16_000);
    const text = `${redactBrowserText(body, state.secrets)}\n\nPage structure:\n${structure}`;
    return {
      text,
      url: redactBrowserText(url, state.secrets),
      candidates: browserCandidates(structure),
    };
  }

  async function browserAction(
    id: string,
    input: BrowserAction,
    signal?: AbortSignal,
  ): Promise<BrowserObservation> {
    if (disposed) throw new Error('The browser service has stopped.');
    if (input.action === 'open' && browsers.get(id)?.closed) await closeBrowser(id);
    const state = stateFor(id);
    if (state.injecting) throw new BrowserLockedError();
    return serialize(state, async () => {
      if (state.injecting) throw new BrowserLockedError();
      signal?.throwIfAborted();
      if (input.action === 'open') {
        const { url } = await publicUrl(input.url ?? '');
        state.started = true;
        await command(state, ['open', url.href], { signal });
      } else {
        if (!state.started) throw new Error('Open a public browser URL first.');
        await currentUrl(state);
        if (input.action === 'click')
          await command(state, ['click', selector(input.selector)], { signal });
        if (input.action === 'fill') {
          const target = selector(input.selector);
          const type = await command(state, ['get', 'attr', target, 'type']);
          const autocomplete = await command(state, ['get', 'attr', target, 'autocomplete']);
          if (
            /password|one-time-code/i.test(JSON.stringify([type, autocomplete])) ||
            state.protectedSelectors.has(target)
          )
            throw new Error('Use the secure credential request tool for this field.');
          const text = input.text ?? '';
          if (
            text.length > 8000 ||
            [...state.secrets].some((secret) => secret && text.includes(secret))
          )
            throw new Error('This field must use the secure credential flow.');
          await command(state, ['fill', target, text], { signal });
        }
        if (input.action === 'scroll')
          await command(state, ['scroll', input.direction ?? 'down', '600'], { signal });
      }
      return observe(state);
    });
  }

  async function injectCredentials(input: CredentialInput): Promise<void> {
    const state = browsers.get(taskId(input.taskId));
    if (!state?.started) throw new Error('The browser session has expired. Reopen the login page.');
    if (state.injecting) throw new BrowserLockedError();
    const { url } = await publicUrl(input.origin);
    if (url.origin !== input.origin) throw new Error('An exact login origin is required.');
    const fields = credentialFields(input);
    for (const field of fields) {
      state.secrets.add(field.value);
      state.protectedSelectors.add(field.selector);
    }
    state.injecting = true;
    try {
      await serialize(state, async () => {
        try {
          if (new URL(await currentUrl(state)).origin !== input.origin)
            throw new Error('The login page origin changed. Request credentials again.');
          const result = await evaluate(
            state,
            credentialScript(input.origin, fields, input.submitSelector),
          );
          if (!(result && typeof result === 'object' && 'ok' in result && result.ok))
            throw new Error('The login fields changed. Request credentials again.');
        } catch {
          await evaluate(
            state,
            `(() => { if(location.origin!==${JSON.stringify(input.origin)}) return false; for(const s of ${JSON.stringify(fields.map((field) => field.selector))}) { for(const e of document.querySelectorAll(s)) { e.value=''; e.dispatchEvent(new Event('input',{bubbles:true})); } } return true; })()`,
          ).catch(() => {});
          throw new Error(
            'Secure entry could not be confirmed. Check the login page before continuing.',
          );
        }
      });
    } finally {
      state.injecting = false;
    }
  }

  async function getScreenshot(id: string, signal?: AbortSignal): Promise<Buffer | null> {
    const state = browsers.get(taskId(id));
    if (!state?.started) return null;
    if (state.injecting) throw new BrowserLockedError();
    return serialize(state, async () => {
      if (state.injecting) throw new BrowserLockedError();
      signal?.throwIfAborted();
      await currentUrl(state);
      await maskFields(state);
      const path = resolve(runtimeRoot, `screen-${state.id}.png`);
      await command(state, ['screenshot', path], { signal });
      const buffer = await readFile(path);
      if (buffer.length > 12 * 1024 * 1024) throw new Error('Browser screenshot is too large.');
      return buffer;
    });
  }

  async function closeBrowser(id: string, idleAt?: number): Promise<void> {
    const state = browsers.get(taskId(id));
    if (!state) return;
    const close = async () => {
      if (idleAt !== undefined && (state.lastUsed !== idleAt || state.injecting)) return;
      state.closed = true;
      if (state.started) await command(state, ['close']);
      state.started = false;
      state.secrets.clear();
      state.protectedSelectors.clear();
      if (browsers.get(id) === state) browsers.delete(id);
      await rm(resolve(runtimeRoot, `screen-${state.id}.png`), { force: true });
    };
    const pending = state.queue.then(close, close);
    state.queue = pending.then(
      () => undefined,
      () => undefined,
    );
    await pending;
  }

  function browserStatus(): string {
    return `${browsers.size} task browser session${browsers.size === 1 ? '' : 's'}; public web proxy enabled`;
  }
  const cleanup = setInterval(
    () => {
      for (const state of browsers.values()) {
        if (!state.busy && !state.injecting && Date.now() - state.lastUsed >= idleTimeoutMs)
          void closeBrowser(state.id, state.lastUsed).catch(() => {});
      }
    },
    Math.min(60_000, Math.max(10, idleTimeoutMs)),
  );
  cleanup.unref();
  return {
    act: browserAction,
    screenshot: getScreenshot,
    injectCredentials,
    close: closeBrowser,
    status: browserStatus,
    dispose: async () => {
      disposed = true;
      clearInterval(cleanup);
      try {
        await Promise.all([...browsers.keys()].map((id) => closeBrowser(id)));
      } finally {
        await proxy.dispose();
      }
    },
  };
}
