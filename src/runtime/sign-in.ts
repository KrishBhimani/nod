import type { RuntimeContext } from '../ports/agent.ts';
import type { LoginInspection } from '../ports/computer.ts';
import { vaultInvitation } from './communication.ts';
import type { Turn } from './turn.ts';

export function publicLoginInspection({ emailCode: _emailCode, ...inspection }: LoginInspection) {
  return inspection;
}

function supportedMethods(login: LoginInspection) {
  return login.methods.filter(
    (method) =>
      method.supported &&
      ['credentials', 'oauth'].includes(method.kind) &&
      (method.id === 'credentials' ? login.fields.length > 0 : Boolean(method.selector)),
  );
}

export function createSignIn({ context, computer, pause }: Turn) {
  const { threadId, signal } = context;
  let selected: { origin: string; id: string } | undefined;
  const inspect = async () => {
    const login = await computer.inspectLogin(threadId);
    signal.throwIfAborted();
    return login;
  };
  async function selectMethod(origin: string, methodId: string) {
    const login = await inspect();
    const site = new URL(origin);
    const method = supportedMethods(login).find((item) => item.id === methodId);
    if (
      !['https:', 'http:'].includes(site.protocol) ||
      site.username ||
      site.password ||
      site.origin !== origin ||
      login.origin !== origin ||
      login.issue ||
      !method
    )
      throw new Error('This sign-in method is no longer available on the current page.');
    if (method.id !== 'credentials') {
      await computer.selectLoginMethod(threadId, origin, methodId);
      signal.throwIfAborted();
    }
    selected = { origin, id: methodId };
    return {
      outcome: 'login_method_selected',
      inspection: publicLoginInspection(method.id === 'credentials' ? login : await inspect()),
      message: 'Sign-in method selected. Continue from this inspection.',
    };
  }
  async function request(input: Parameters<RuntimeContext['requestCredential']>[0]) {
    const login = await inspect();
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
    const methods = supportedMethods(login);
    const chosen =
      selected?.origin === login.origin && methods.some((method) => method.id === selected?.id);
    if (methods.length > 1 && !chosen)
      return {
        outcome: 'choose_sign_in_method',
        origin: login.origin,
        methods: methods.map(({ id, label, kind }) => ({ id, label, kind })),
        message:
          'Several sign-in methods are available. Ask the user which one unless they already chose, then call sign_in select_method.',
      };
    if (methods.length === 1 && methods[0].id !== 'credentials')
      return selectMethod(login.origin, methods[0].id);
    if (login.fields.length === 0)
      return {
        outcome: 'no_supported_sign_in_method',
        message: 'No supported sign-in method is available on this page.',
      };
    const result = await context.requestCredential(input);
    if (result.filled) return 'Saved login entered. Check the page to confirm the sign-in worked.';
    if (!result.url && result.invitation?.kind !== 'otp')
      throw new Error('The secure sign-in request could not be created.');
    await context.reply(vaultInvitation(result.invitation ?? input, result.url));
    await pause('credentials', undefined, { post: false });
    return 'Waiting for the user to sign in.';
  }
  return { inspect: async () => publicLoginInspection(await inspect()), selectMethod, request };
}
