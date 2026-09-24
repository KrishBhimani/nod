import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  BrowserAction,
  BrowserObservation,
  Computer,
  CredentialInput,
  LoginInspection,
} from '../../ports/computer.ts';
import { taskId } from '../../ports/task-identity.ts';
import { runProcess, serviceEnvironment } from '../process.ts';
import { createBrowserProxy, publicUrl } from './network.ts';
import { credentialFields, credentialScript } from './credentials.ts';
import { credentialSubmitScript, loginInspectionSchema, loginInspectionScript } from './login.ts';
import { createScreenStore, existingDaemonCommand, type StoredScreen } from './screens.ts';

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
  heldUntil: number;
  socket?: string;
  saved: StoredScreen;
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

export function redactBrowserUrl(value: string, secrets: Iterable<string>): string {
  const url = new URL(value);
  const sensitive =
    /^(?:code|state|token|access_token|id_token|refresh_token|password|otp|session|session_id|ticket|assertion|authorization|email|username|identifier|phone)$/i;
  for (const name of url.searchParams.keys())
    if (sensitive.test(name)) url.searchParams.set(name, '[redacted]');
  if (url.hash.includes('=')) url.hash = '[redacted]';
  return redactBrowserText(url.href, secrets);
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
  const screens = createScreenStore(runtimeRoot);
  const screenStatuses = new Map<string, ReturnType<NonNullable<Computer['screenStatus']>>>();
  const namespace = `sk-${createHash('sha256').update(runtimeRoot).digest('hex').slice(0, 12)}`;
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
        heldUntil: 0,
        saved: { version: 1, url: '', sensitive: false, active: false },
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
    if (state.socket) {
      const request =
        args[0] === 'eval'
          ? { action: 'evaluate', script: options.input }
          : args[0] === 'get' && args[1] === 'url'
            ? { action: 'url' }
            : args[0] === 'screenshot'
              ? { action: 'screenshot', path: args[1], fullPage: false, annotate: false }
              : args[0] === 'snapshot'
                ? { action: 'snapshot', compact: true }
                : args[0] === 'close'
                  ? { action: 'close' }
                  : null;
      if (!request) throw new Error('Reopen this page before continuing browser actions.');
      return existingDaemonCommand(state.socket, request, options.signal);
    }
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
        namespace,
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
        `${Math.ceil((Math.max(idleTimeoutMs, 30 * 60_000) + 15 * 60_000) / 1000)}s`,
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
    const storedUrl = new URL(url);
    storedUrl.search = '';
    storedUrl.hash = '';
    if (
      [...state.secrets].some(
        (secret) =>
          secret &&
          (storedUrl.pathname.includes(secret) ||
            storedUrl.pathname.includes(encodeURIComponent(secret))),
      )
    )
      storedUrl.pathname = '/';
    state.saved.url = storedUrl.href;
    return url;
  }

  async function saveState(state: BrowserState) {
    state.saved.sensitive ||= state.secrets.size > 0;
    state.saved.active = state.started && !state.closed;
    await screens.save(state.id, state.saved);
  }

  async function recoverBrowser(
    id: string,
    allowSensitive = false,
  ): Promise<BrowserState | undefined> {
    taskId(id);
    const existing = browsers.get(id);
    if (existing) return existing;
    if (disposed) return undefined;
    const saved = await screens.load(id);
    if (!saved?.active || (saved.sensitive && !allowSensitive)) return undefined;
    try {
      const result = await run(
        executable,
        ['--namespace', namespace, '--session', browserSessionId(id), 'session', 'info', '--json'],
        {
          env: serviceEnvironment(),
          timeoutMs: 5000,
          maxBytes: 16_384,
        },
      );
      const response = JSON.parse(result.stdout);
      const info = response.data;
      if (
        result.exitCode ||
        !response.success ||
        !info?.active ||
        info.namespace !== namespace ||
        info.session !== browserSessionId(id) ||
        typeof info.socketDir !== 'string'
      )
        return undefined;
      const state = stateFor(id);
      state.saved = saved;
      state.socket = resolve(info.socketDir, `${browserSessionId(id)}.sock`);
      state.started = true;
      return state;
    } catch {
      return undefined;
    }
  }

  async function maskFields(state: BrowserState): Promise<void> {
    const result = await evaluate(
      state,
      `(() => { const selectors=${JSON.stringify([...state.protectedSelectors])},secrets=${JSON.stringify([...state.secrets])}; const nodes=new Set(document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete="username"],input[data-sidekick-login-field^="identifier"]')); for (const s of selectors) { try { for(const e of document.querySelectorAll(s)) nodes.add(e); } catch {} } for(const e of document.querySelectorAll('input,textarea')) if(secrets.some(s=>s && String(e.value??'').includes(s))) nodes.add(e); if(nodes.size>40) throw new Error('Too many protected fields'); const values=[...nodes].map(e=>String(e.value??'')).filter(Boolean); if(values.some(value=>value.length>8192)) throw new Error('Protected field exceeds limit'); for(const value of values) if(!secrets.includes(value)) secrets.push(value); for(const e of nodes) { e.style.setProperty('color','transparent','important'); e.style.setProperty('text-shadow','none','important'); e.style.setProperty('-webkit-text-security','disc','important'); } if(document.body && secrets.length) { const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT); while(walker.nextNode()) { const node=walker.currentNode,parent=node.parentElement; if(parent && !['SCRIPT','STYLE'].includes(parent.tagName) && secrets.some(s=>s && node.textContent.includes(s))) { parent.style.setProperty('color','transparent','important'); parent.style.setProperty('text-shadow','none','important'); } } } return {masked:true,values}; })()`,
    );
    if (
      result &&
      typeof result === 'object' &&
      'values' in result &&
      Array.isArray(result.values)
    ) {
      for (const value of result.values) {
        if (typeof value !== 'string' || value.length > 8192)
          throw new Error('This protected field cannot be observed.');
        if (value) state.secrets.add(value);
      }
    }
    await saveState(state);
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
      url: redactBrowserUrl(url, state.secrets),
      candidates: browserCandidates(structure),
    };
  }

  async function browserAction(
    id: string,
    input: BrowserAction,
    signal?: AbortSignal,
  ): Promise<BrowserObservation> {
    if (disposed) throw new Error('The browser service has stopped.');
    if (input.action === 'open' && !browsers.has(id)) await recoverBrowser(id, true);
    if (input.action === 'open' && browsers.get(id)?.socket) await closeBrowser(id);
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
          const loginField = await command(state, [
            'get',
            'attr',
            target,
            'data-sidekick-login-field',
          ]);
          if (
            /password|one-time-code|username/i.test(JSON.stringify([type, autocomplete])) ||
            /identifier|password|otp/.test(JSON.stringify(loginField)) ||
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
          await saveState(state);
          if (new URL(await currentUrl(state)).origin !== input.origin)
            throw new Error('The login page origin changed. Request credentials again.');
          const result = await evaluate(
            state,
            credentialScript(input.origin, fields, input.submitSelector),
          );
          if (!(result && typeof result === 'object' && 'ok' in result && result.ok))
            throw new Error('The login fields changed. Request credentials again.');
          if ('submitPending' in result && result.submitPending && input.submitSelector) {
            const submitted = await evaluate(
              state,
              credentialSubmitScript(input.origin, input.submitSelector),
            );
            if (!(submitted && typeof submitted === 'object' && 'ok' in submitted && submitted.ok))
              throw new Error('The login form could not advance.');
          }
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

  async function inspectPage(state: BrowserState): Promise<LoginInspection> {
    const url = await currentUrl(state);
    await maskFields(state);
    const inspection = loginInspectionSchema.parse(await evaluate(state, loginInspectionScript()));
    if (inspection.origin !== new URL(url).origin)
      throw new Error('The login page changed. Inspect it again.');
    await publicUrl(inspection.url);
    return { ...inspection, url: redactBrowserUrl(inspection.url, state.secrets) };
  }

  async function inspectLogin(id: string): Promise<LoginInspection> {
    const state = await recoverBrowser(id);
    if (!state?.started) throw new Error('Open the login page in this task browser first.');
    if (state.injecting) throw new BrowserLockedError();
    return serialize(state, () => inspectPage(state));
  }

  async function selectLoginMethod(id: string, origin: string, methodId: string): Promise<void> {
    const state = browsers.get(taskId(id));
    if (!state?.started) throw new Error('Open the login page in this task browser first.');
    if (state.injecting) throw new BrowserLockedError();
    await serialize(state, async () => {
      const current = await inspectPage(state);
      const method = current.methods.find((item) => item.id === methodId);
      if (
        current.origin !== origin ||
        !method?.supported ||
        !(['oauth', 'credentials'].includes(method.kind) && method.id !== 'credentials') ||
        !method.selector
      )
        throw new Error('This sign-in method is no longer available on the current page.');
      const result = await evaluate(state, credentialSubmitScript(origin, method.selector));
      if (!(result && typeof result === 'object' && 'ok' in result && result.ok))
        throw new Error('The sign-in method could not be opened.');
    });
  }

  async function hold(id: string, until: number | null): Promise<void> {
    const state = browsers.get(taskId(id));
    if (!state?.started) return;
    await serialize(state, async () => {
      if (until !== null && !Number.isFinite(until))
        throw new Error('A valid browser hold expiry is required.');
      state.heldUntil = until === null ? 0 : Math.min(until, Date.now() + 30 * 60_000);
      if (state.heldUntil > Date.now()) await currentUrl(state);
      if (state.heldUntil > Date.now()) await captureScreen(state);
    });
  }

  async function captureScreen(state: BrowserState, signal?: AbortSignal): Promise<Buffer> {
    if (state.socket && state.saved.sensitive && !state.secrets.size)
      throw new Error('Reopen the login page before continuing this browser session.');
    await currentUrl(state);
    await maskFields(state);
    const path = resolve(runtimeRoot, `screen-${state.id}.capture.png`);
    await command(state, ['screenshot', path], { signal });
    const buffer = await screens.accept(state.id, path);
    state.saved.capturedAt = new Date().toISOString();
    await saveState(state);
    screenStatuses.set(state.id, { state: 'live', capturedAt: state.saved.capturedAt });
    return buffer;
  }

  async function lastKnownScreen(id: string): Promise<Buffer | null> {
    const saved = await screens.load(id);
    const buffer = saved?.capturedAt ? await screens.read(id) : null;
    screenStatuses.set(
      id,
      buffer ? { state: 'last_known', capturedAt: saved?.capturedAt } : { state: 'unavailable' },
    );
    return buffer;
  }

  async function getScreenshot(id: string, signal?: AbortSignal): Promise<Buffer | null> {
    const state = await recoverBrowser(id);
    if (!state?.started) return lastKnownScreen(id);
    if (state.injecting) throw new BrowserLockedError();
    return serialize(state, async () => {
      if (state.injecting) throw new BrowserLockedError();
      signal?.throwIfAborted();
      try {
        return await captureScreen(state, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (!state.socket) throw error;
        return lastKnownScreen(id);
      }
    });
  }

  async function closeBrowser(id: string, idleAt?: number): Promise<void> {
    const state = browsers.get(taskId(id));
    if (!state) return;
    const close = async () => {
      if (
        idleAt !== undefined &&
        (state.lastUsed !== idleAt || state.injecting || state.heldUntil > Date.now())
      )
        return;
      if (state.started && !state.closed && !state.injecting)
        await captureScreen(state).catch(() => {});
      state.closed = true;
      if (state.started) await command(state, ['close']);
      state.started = false;
      await saveState(state);
      state.secrets.clear();
      state.protectedSelectors.clear();
      if (browsers.get(id) === state) browsers.delete(id);
      screenStatuses.set(
        id,
        state.saved.capturedAt
          ? { state: 'last_known', capturedAt: state.saved.capturedAt }
          : { state: 'unavailable' },
      );
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
        if (
          !state.busy &&
          !state.injecting &&
          state.heldUntil <= Date.now() &&
          Date.now() - state.lastUsed >= idleTimeoutMs
        )
          void closeBrowser(state.id, state.lastUsed).catch(() => {});
      }
    },
    Math.min(60_000, Math.max(10, idleTimeoutMs)),
  );
  cleanup.unref();
  return {
    act: browserAction,
    screenshot: getScreenshot,
    screenStatus: (id) => screenStatuses.get(taskId(id)) ?? { state: 'unavailable' },
    injectCredentials,
    inspectLogin,
    selectLoginMethod,
    hold,
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
