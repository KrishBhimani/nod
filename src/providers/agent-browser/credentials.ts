import type { CredentialInput } from '../../ports/computer.ts';

export interface CredentialField {
  selector: string;
  value: string;
  password: boolean;
}

export function credentialFields(input: CredentialInput): CredentialField[] {
  const value = input.kind === 'otp' ? input.code : (input.password ?? input.code);
  if (!value || value.length > 8192 || (input.username?.length ?? 0) > 320)
    throw new Error('A valid credential value is required.');
  const fields = [
    ...(input.username
      ? [
          {
            selector:
              input.usernameSelector || 'input[autocomplete="username"],input[type="email"]',
            value: input.username,
            password: false,
          },
        ]
      : []),
    { selector: input.passwordSelector, value, password: input.kind !== 'otp' && !input.code },
  ];
  for (const target of [
    ...fields.map((field) => field.selector),
    ...(input.submitSelector ? [input.submitSelector] : []),
  ]) {
    if (!target || target.length > 500 || /^[\s@-]/.test(target) || target.includes('\0'))
      throw new Error('Secure entry requires a CSS selector, not a transient reference.');
  }
  return fields;
}

export function credentialScript(
  origin: string,
  fields: CredentialField[],
  submitSelector?: string,
): string {
  return `(() => {
    const origin=${JSON.stringify(origin)}, fields=${JSON.stringify(fields)}, submit=${JSON.stringify(submitSelector ?? null)};
    if(location.origin!==origin) return {ok:false};
    const usable=e=>e && e.isConnected && !e.disabled && !e.readOnly && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden' && getComputedStyle(e).display!=='none';
    const targets=fields.map(field=>({field,nodes:document.querySelectorAll(field.selector)}));
    if(targets.some(({field,nodes})=>nodes.length!==1 || !nodes[0].matches('input') || !usable(nodes[0]) || (field.password && nodes[0].type!=='password'))) return {ok:false};
    const submits=submit?document.querySelectorAll(submit):[];
    if(submit && (submits.length!==1 || !usable(submits[0]))) return {ok:false};
    for(const {field,nodes} of targets) {
      if(location.origin!==origin) return {ok:false};
      const e=nodes[0];
      e.style.setProperty('color','transparent','important');
      e.style.setProperty('text-shadow','none','important');
      e.style.setProperty('-webkit-text-security','disc','important');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,field.value);
      e.dispatchEvent(new Event('input',{bubbles:true}));
      e.dispatchEvent(new Event('change',{bubbles:true}));
    }
    if(submit) { if(location.origin!==origin) return {ok:false}; submits[0].click(); }
    return {ok:true};
  })()`;
}
