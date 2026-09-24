import type { CredentialInput } from '../../ports/computer.ts';

export interface CredentialField {
  selector: string;
  value: string;
  password: boolean;
  identifier?: boolean;
}

export function credentialFields(input: CredentialInput): CredentialField[] {
  const kind = input.kind ?? 'password';
  const value =
    kind === 'identifier' ? input.username : kind === 'otp' ? input.code : input.password;
  if (!value || value.length > (kind === 'otp' ? 100 : 8192) || (input.username?.length ?? 0) > 320)
    throw new Error('A valid credential value is required.');
  const fields = [
    ...(kind === 'password' && input.username && input.usernameSelector
      ? [
          {
            selector: input.usernameSelector,
            value: input.username,
            password: false,
          },
        ]
      : []),
    {
      selector: (kind === 'identifier' ? input.usernameSelector : input.passwordSelector) ?? '',
      value,
      password: kind === 'password',
      identifier: kind === 'identifier',
    },
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
    if(targets.some(({field,nodes})=>nodes.length!==1 || !nodes[0].matches('input') || !usable(nodes[0]) || (field.password && nodes[0].type!=='password') || (field.identifier && nodes[0].type==='password'))) return {ok:false};
    const submits=submit?document.querySelectorAll(submit):[];
    if(submit && (submits.length!==1 || !submits[0].isConnected || submits[0].getClientRects().length===0)) return {ok:false};
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
    if(submit) {
      if(location.origin!==origin) return {ok:false};
      const fresh=document.querySelectorAll(submit);
      if(fresh.length!==1) return {ok:false};
      if(!usable(fresh[0]) || fresh[0].getAttribute?.('aria-disabled')==='true') return {ok:true,submitPending:true};
      fresh[0].click();
    }
    return {ok:true};
  })()`;
}
