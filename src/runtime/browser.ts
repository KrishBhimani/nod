import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserProxy, publicUrl } from './network.ts';
import { runProcess, serviceEnvironment } from './process.ts';
import { taskId } from './workspace.ts';
import { credentialFields, credentialScript, type CredentialInput } from './credentials.ts';
export type { CredentialInput } from './credentials.ts';

interface BrowserState {
  id: string;
  queue: Promise<unknown>;
  injecting: boolean;
  secrets: Set<string>;
  protectedSelectors: Set<string>;
  started: boolean;
}

export interface BrowserAction {
  action: 'open' | 'snapshot' | 'click' | 'fill' | 'scroll';
  url?: string;
  selector?: string;
  text?: string;
  direction?: 'up' | 'down';
}

export class BrowserLockedError extends Error {
  statusCode = 423;
  constructor() { super('Browser observations are paused during credential entry.'); }
}

const browsers = new Map<string, BrowserState>();
const runtimeRoot = resolve(process.cwd(), '.local/runtime');
const executable = resolve(process.cwd(), 'node_modules/.bin/agent-browser');

export function browserSessionId(id: string): string {
  return `sk-${createHash('sha256').update(taskId(id)).digest('hex').slice(0, 24)}`;
}

function stateFor(id: string): BrowserState {
  taskId(id);
  let state = browsers.get(id);
  if (!state) {
    state = { id, queue: Promise.resolve(), injecting: false, secrets: new Set(), protectedSelectors: new Set(), started: false };
    browsers.set(id, state);
  }
  return state;
}

function serialize<T>(state: BrowserState, operation: () => Promise<T>): Promise<T> {
  const pending = state.queue.then(operation, operation);
  state.queue = pending.then(() => undefined, () => undefined);
  return pending;
}

export function redactBrowserText(text: string, secrets: Iterable<string>): string {
  let result = text;
  for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]');
  return result.replace(/(password[^\n]*?)(?:value=|: )[^\n]*/gi, '$1 [redacted]');
}

function selector(value: string | undefined): string {
  if (!value || value.length > 500 || /^[\s-]/.test(value) || value.includes('\0')) throw new Error('A valid observed selector or element reference is required.');
  return value;
}

async function command(state: BrowserState, args: string[], options: { input?: string; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const config = resolve(runtimeRoot, 'browser-config.json');
  await writeFile(config, '{}', { mode: 0o600 });
  const proxy = await browserProxy();
  const profile = resolve(runtimeRoot, 'profiles', state.id);
  const result = await runProcess(executable, [
    '--config', config, '--namespace', 'sidekick', '--session', browserSessionId(state.id),
    '--profile', profile, '--json', '--proxy', proxy, '--proxy-bypass', '<-loopback>',
    '--args', '--disable-quic,--force-webrtc-ip-handling-policy=disable_non_proxied_udp,--disable-background-networking',
    '--download-path', resolve(runtimeRoot, 'downloads', state.id), '--idle-timeout', '30m', ...args,
  ], { cwd: runtimeRoot, env: serviceEnvironment(), input: options.input, signal: options.signal, timeoutMs: 45_000, maxBytes: 256 * 1024 });
  let response: { success?: boolean; data?: Record<string, unknown> };
  try { response = JSON.parse(result.stdout.trim()); } catch { throw new Error('Browser command failed. Confirm Chrome is installed and restart the browser.'); }
  if (result.exitCode || response.success === false) throw new Error('Browser action could not complete. Observe the page again before retrying.');
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
  await evaluate(state, `(() => { const selectors=${JSON.stringify([...state.protectedSelectors])}; const nodes=new Set(document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"]')); for (const s of selectors) { try { for(const e of document.querySelectorAll(s)) nodes.add(e); } catch {} } for(const e of nodes) { e.style.setProperty('color','transparent','important'); e.style.setProperty('text-shadow','none','important'); e.style.setProperty('-webkit-text-security','disc','important'); } return {masked:true}; })()`);
}

async function observe(state: BrowserState): Promise<{ text: string; url: string }> {
  if (state.injecting) throw new BrowserLockedError();
  const url = await currentUrl(state);
  await maskFields(state);
  const data = await command(state, ['snapshot', '-i', '-c']);
  return { text: redactBrowserText(String(data.snapshot ?? data.text ?? JSON.stringify(data)), state.secrets).slice(0, 24_000), url: redactBrowserText(url, state.secrets) };
}

export async function browserAction(id: string, input: BrowserAction, signal?: AbortSignal): Promise<{ text: string; url: string }> {
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
      if (input.action === 'click') await command(state, ['click', selector(input.selector)], { signal });
      if (input.action === 'fill') {
        const target = selector(input.selector);
        const type = await command(state, ['get', 'attr', target, 'type']);
        const autocomplete = await command(state, ['get', 'attr', target, 'autocomplete']);
        if (/password|one-time-code/i.test(JSON.stringify([type, autocomplete])) || state.protectedSelectors.has(target)) throw new Error('Use the secure credential request tool for this field.');
        const text = input.text ?? '';
        if (text.length > 8000 || [...state.secrets].some(secret => secret && text.includes(secret))) throw new Error('This field must use the secure credential flow.');
        await command(state, ['fill', target, text], { signal });
      }
      if (input.action === 'scroll') await command(state, ['scroll', input.direction ?? 'down', '600'], { signal });
    }
    return observe(state);
  });
}

export async function injectCredentials(input: CredentialInput): Promise<void> {
  const state = browsers.get(taskId(input.taskId));
  if (!state?.started) throw new Error('The browser session has expired. Reopen the login page.');
  if (state.injecting) throw new BrowserLockedError();
  const { url } = await publicUrl(input.origin);
  if (url.origin !== input.origin) throw new Error('An exact login origin is required.');
  const fields = credentialFields(input);
  for (const field of fields) { state.secrets.add(field.value); state.protectedSelectors.add(field.selector); }
  state.injecting = true;
  try {
    await serialize(state, async () => {
      if (new URL(await currentUrl(state)).origin !== input.origin) throw new Error('The login page origin changed. Request credentials again.');
      const result = await evaluate(state, credentialScript(input.origin, fields, input.submitSelector));
      if (!(result && typeof result === 'object' && 'ok' in result && result.ok)) throw new Error('The login fields changed. Request credentials again.');
    });
  } catch {
    await evaluate(state, `(() => { if(location.origin!==${JSON.stringify(input.origin)}) return false; for(const s of ${JSON.stringify(fields.map(field => field.selector))}) { for(const e of document.querySelectorAll(s)) { e.value=''; e.dispatchEvent(new Event('input',{bubbles:true})); } } return true; })()`).catch(() => {});
    throw new Error('Secure entry could not be confirmed. Check the login page before continuing.');
  } finally { state.injecting = false; }
}

export async function getScreenshot(id: string): Promise<Buffer | null> {
  const state = browsers.get(taskId(id));
  if (!state?.started) return null;
  if (state.injecting) throw new BrowserLockedError();
  return serialize(state, async () => {
    if (state.injecting) throw new BrowserLockedError();
    await currentUrl(state);
    await maskFields(state);
    const path = resolve(runtimeRoot, `screen-${state.id}.png`);
    await command(state, ['screenshot', path]);
    const buffer = await readFile(path);
    if (buffer.length > 12 * 1024 * 1024) throw new Error('Browser screenshot is too large.');
    return buffer;
  });
}

export async function closeBrowser(id: string): Promise<void> {
  const state = browsers.get(taskId(id));
  if (!state) return;
  await serialize(state, async () => { if (state.started) await command(state, ['close']).catch(() => {}); });
  browsers.delete(id);
}

export function browserStatus(): string {
  return `${browsers.size} task browser session${browsers.size === 1 ? '' : 's'}; public web proxy enabled`;
}
