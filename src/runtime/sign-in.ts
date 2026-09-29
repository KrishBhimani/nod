import type { RuntimeContext } from '../ports/agent.ts';
import type { LoginInspection, LoginMethod } from '../ports/computer.ts';
import { vaultInvitation } from './communication.ts';
import type { Turn } from './turn.ts';

export function publicLoginInspection({ emailCode: _emailCode, ...inspection }: LoginInspection) {
  return inspection;
}

function assertOrigin(login: LoginInspection, origin: string) {
  const site = new URL(origin);
  if (
    !['https:', 'http:'].includes(site.protocol) ||
    site.username ||
    site.password ||
    site.origin !== origin ||
    login.origin !== origin
  )
    throw new Error('This sign-in page changed. Inspect it before continuing.');
}

function manualSignIn(login: LoginInspection, method: LoginMethod) {
  return {
    outcome: 'manual_sign_in_required',
    origin: login.origin,
    method: { id: method.id, label: method.label, kind: method.kind, reason: method.reason },
    message:
      'This method needs the user or their device. Offer browser_session connect, or ask them to choose Take control, complete this method, then Resume agent. Never ask for credentials in chat.',
  };
}

export function createSignIn({ context, computer, pause }: Turn) {
  const { threadId, signal } = context;
  const selections = new Map<string, string>();
  const selectionKey = (login: LoginInspection, method: LoginMethod) =>
    JSON.stringify([
      login.origin,
      method.group ?? (method.id === 'continue' ? 'continue' : ''),
      method.id === 'continue' ? login.url : '',
    ]);
  const selectionValue = (login: LoginInspection, method: LoginMethod) =>
    JSON.stringify([
      method.id,
      login.methods
        .filter((item) => item.group === method.group && item.id !== 'continue')
        .map((item) => item.id)
        .sort(),
    ]);
  const chosen = (login: LoginInspection, method: LoginMethod) =>
    selections.get(selectionKey(login, method)) === selectionValue(login, method);
  const inspect = async () => {
    const login = await computer.inspectLogin(threadId);
    signal.throwIfAborted();
    return login;
  };
  async function selectMethod(origin: string, methodId: string) {
    const login = await inspect();
    assertOrigin(login, origin);
    const method = login.methods.find((item) => item.id === methodId);
    if (login.issue || !method)
      throw new Error('This sign-in method is no longer available on the current page.');
    const manual = !method.supported && ['manual', 'passkey'].includes(method.kind);
    if (
      !manual &&
      (!method.supported ||
        !['credentials', 'oauth'].includes(method.kind) ||
        (method.id === 'credentials' ? !login.fields.length : !method.selector))
    )
      throw new Error('This sign-in method is no longer available on the current page.');
    if (!manual && method.id !== 'credentials' && !method.selected) {
      await computer.selectLoginMethod(threadId, origin, methodId);
      signal.throwIfAborted();
    }
    selections.set(selectionKey(login, method), selectionValue(login, method));
    if (manual) return manualSignIn(login, method);
    return {
      outcome: 'login_method_selected',
      inspection: publicLoginInspection(method.id === 'credentials' ? login : await inspect()),
      message: 'Sign-in method selected. Continue from this inspection.',
    };
  }
  async function requestCredentials(
    input: Parameters<RuntimeContext['requestCredential']>[0],
    login: LoginInspection,
  ) {
    const kind =
      (['otp', 'password', 'identifier'] as const).find((value) =>
        login.fields.some((field) => field.kind === value),
      ) ?? input.kind;
    const identifiers = login.fields.filter((field) => field.kind === 'identifier');
    const secrets = login.fields.filter((field) => field.kind === kind);
    const resolved = {
      origin: login.origin,
      label: input.label,
      kind,
      usernameSelector: identifiers.length === 1 ? identifiers[0].selector : undefined,
      passwordSelector:
        kind !== 'identifier' && secrets.length === 1 ? secrets[0].selector : undefined,
      submitSelector: login.submitSelector,
    };
    const result = await context.requestCredential(resolved);
    if (result.filled) return 'Saved login entered. Check the page to confirm the sign-in worked.';
    if (!result.url && result.invitation?.kind !== 'otp')
      throw new Error('The secure sign-in request could not be created.');
    await context.reply(vaultInvitation(result.invitation ?? resolved, result.url));
    await pause('credentials', undefined, { post: false });
    return 'Waiting for the user to sign in.';
  }
  async function request(input: Parameters<RuntimeContext['requestCredential']>[0]) {
    const login = await inspect();
    assertOrigin(login, input.origin);
    if (login.issue === 'browser_not_supported')
      return {
        outcome: 'sign_in_blocked',
        issue: login.issue,
        message:
          'This site blocks automated sign-in. Offer browser_session connect, or ask the user to choose Take control in the browser controls, sign in, then choose Resume agent.',
      };
    if (login.fields.length === 0 && login.methods.length === 0) {
      const observation = await computer.act(threadId, { action: 'snapshot' }, signal);
      signal.throwIfAborted();
      return {
        outcome: 'no_sign_in_step',
        message: 'This page has no sign-in fields or methods.',
        observation,
      };
    }
    if (
      login.fields.some((field) => field.kind === 'otp') &&
      login.methods.some((method) => method.id === 'credentials' && method.supported)
    )
      return requestCredentials(input, login);
    const grouped = login.methods.some((method) => method.group);
    const groups = new Map<string, LoginMethod[]>();
    for (const method of login.methods) {
      if (method.id === 'continue' || (grouped && method.id === 'credentials')) continue;
      const key = method.group ?? '';
      groups.set(key, [...(groups.get(key) ?? []), method]);
    }
    for (const [group, methods] of groups) {
      const selected = methods.find((method) => chosen(login, method));
      if (methods.length > 1 && !selected)
        return {
          outcome: 'choose_sign_in_method',
          origin: login.origin,
          ...(group ? { group } : {}),
          methods: methods.map(({ id, label, kind, supported, reason }) => ({
            id,
            label,
            kind,
            supported,
            reason,
          })),
          message:
            'Ask the user which method unless they already chose, then call sign_in select_method. Site defaults are not user choices. Some methods need the user or their device.',
        };
      const method = selected ?? methods[0];
      if (!method.supported && ['manual', 'passkey'].includes(method.kind))
        return manualSignIn(login, method);
      if (methods.length === 1 && !selected && method.id !== 'credentials' && method.supported)
        return selectMethod(login.origin, method.id);
    }
    if (login.fields.length === 0) {
      const next = login.methods.find((method) => method.id === 'continue' && method.supported);
      if (next && !chosen(login, next)) return selectMethod(login.origin, next.id);
      return {
        outcome: 'no_supported_sign_in_method',
        message: 'No supported sign-in method is available on this page.',
      };
    }
    return requestCredentials(input, login);
  }
  return { inspect: async () => publicLoginInspection(await inspect()), selectMethod, request };
}
