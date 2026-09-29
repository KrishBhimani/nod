import type { CredentialInput, CredentialKind } from '../../ports/computer.ts';

export interface CredentialFeedback {
  advanced: boolean;
  rejected: boolean;
  fingerprint: string;
  sameDocument: boolean;
}

export function credentialFeedbackScript(
  origin: string,
  kind: CredentialKind,
  attempt: string,
  mark = false,
): string {
  return `(() => {
    const origin=${JSON.stringify(origin)},kind=${JSON.stringify(kind)},attempt=${JSON.stringify(attempt)},mark=${JSON.stringify(mark)};
    const root=document.documentElement;
    if(location.origin!==origin) return {advanced:true,rejected:false,fingerprint:'',sameDocument:false};
    const visible=e=>e && e.isConnected && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden' && getComputedStyle(e).display!=='none' && !e.closest('[hidden],[aria-hidden="true"],[inert]');
    const hint=e=>[e.id,e.name,e.autocomplete,e.getAttribute('aria-label'),e.getAttribute('placeholder'),...[...(e.labels||[])].map(label=>label.innerText||label.textContent||''),...(e.getAttribute('aria-labelledby')||'').split(' ').map(id=>document.getElementById?.(id)?.textContent||'')].join(' ');
    const fields=[...document.querySelectorAll('input')].filter(e=>visible(e)&&!e.disabled&&(
      kind==='password'?e.type==='password':kind==='otp'?/one-time-code|verification.?code|authentication.?code|security.?code|authenticator|(?:^|[^a-z])(?:otp|totp)(?:[^a-z]|$)/i.test(hint(e))||e.getAttribute('data-otto-login-field')?.startsWith('otp-'):
      e.type==='email'||/username|user.?name|identifier|phone|email/i.test(hint(e))||e.getAttribute('data-otto-login-field')?.startsWith('identifier-')));
    const errors=[...document.querySelectorAll('[role="alert"],[aria-live="assertive"],[data-error],.error,.invalid-feedback')].filter(visible).map(e=>(e.innerText||e.textContent||'').slice(0,2000)).filter(text=>/incorrect|invalid|wrong|rejected|not recognized|not recognised|not match|try again|inválid|incorret|incorrecto|invalide|ungültig|falsch/i.test(text));
    const invalid=fields.some(e=>e.getAttribute('aria-invalid')==='true');
    const text=JSON.stringify([errors,invalid]);
    let hash=2166136261;
    for(let index=0;index<text.length;index++) hash=Math.imul(hash^text.charCodeAt(index),16777619);
    if(mark) root?.setAttribute('data-otto-entry-attempt',attempt);
    return {advanced:fields.length===0,rejected:fields.length>0&&(errors.length>0||invalid),fingerprint:(hash>>>0).toString(16),sameDocument:root?.getAttribute('data-otto-entry-attempt')===attempt};
  })()`;
}

export function credentialFeedback(value: unknown): CredentialFeedback | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = value as Record<string, unknown>;
  if (
    typeof result.advanced !== 'boolean' ||
    typeof result.rejected !== 'boolean' ||
    typeof result.sameDocument !== 'boolean' ||
    typeof result.fingerprint !== 'string' ||
    !/^[a-f0-9]{0,8}$/.test(result.fingerprint)
  )
    return undefined;
  return result as unknown as CredentialFeedback;
}

export interface CredentialField {
  selector: string;
  value: string;
  password: boolean;
  identifier?: boolean;
  code?: boolean;
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
      code: kind === 'otp',
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
  submitSelector: string | undefined,
  marker = '',
): string {
  const safeFields = fields.map(({ value, ...field }) => ({
    ...field,
    length: value.length,
    numeric: /^\d+$/.test(value),
  }));
  return `(() => {
    const origin=${JSON.stringify(origin)}, fields=${JSON.stringify(safeFields)}, submit=${JSON.stringify(submitSelector ?? null)}, marker=${JSON.stringify(marker)};
    if(location.origin!==origin) return {ok:false};
    const visible=e=>e && e.isConnected && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden' && getComputedStyle(e).display!=='none' && !e.closest('[hidden],[aria-hidden="true"],[inert]');
    const available=e=>visible(e) && !e.disabled && !e.closest('[aria-disabled="true"]');
    const usable=e=>available(e) && !e.readOnly;
    const targets=fields.map(field=>({field,nodes:[...document.querySelectorAll(field.selector)]}));
    const split=({field,nodes},allowReadonly)=>field.code&&nodes.length>=4&&nodes.length<=8&&nodes.length===field.length&&field.numeric&&nodes.every(e=>e.maxLength===1&&['text','tel','number'].includes(e.type)&&e.parentElement===nodes[0].parentElement)&&[...nodes[0].parentElement.querySelectorAll('input')].filter(allowReadonly?available:usable).length===nodes.length;
    const invalid=(target,allowReadonly=false)=>{
      const {field,nodes}=target;
      return (nodes.length!==1&&!split(target,allowReadonly))||nodes.some(e=>!e.matches('input')||!(allowReadonly?available(e):usable(e))||(field.password&&e.type!=='password')||(!field.password&&e.type==='password')||(field.code&&nodes.length===1&&e.maxLength>0&&e.maxLength<field.length));
    };
    const changed=()=>location.origin!==origin||targets.some(({field,nodes})=>{
      const fresh=[...document.querySelectorAll(field.selector)];
      return fresh.length!==nodes.length||fresh.some((e,index)=>e!==nodes[index]);
    });
    if(targets.some(target=>invalid(target,true))) return {ok:false};
    const submits=submit?document.querySelectorAll(submit):[];
    if(submit && (submits.length!==1 || !visible(submits[0]))) return {ok:false};
    for(const {nodes} of targets) for(const e of nodes) if(e.readOnly) {
      if(changed()||targets.some(target=>invalid(target,true))) return {ok:false};
      e.focus({preventScroll:true});
      if(changed()) return {ok:false};
    }
    if(changed()||targets.some(target=>invalid(target))) return {ok:false};
    if(submit) {
      const fresh=document.querySelectorAll(submit);
      if(fresh.length!==1||fresh[0]!==submits[0]||!visible(fresh[0])) return {ok:false};
    }
    for(const [fieldIndex,{field,nodes}] of targets.entries()) {
      if(location.origin!==origin) return {ok:false};
      for(let index=0;index<nodes.length;index++) {
        const fresh=[...document.querySelectorAll(field.selector)];
        if(location.origin!==origin||fresh.length!==nodes.length||fresh.some((e,index)=>e!==nodes[index])||invalid({field,nodes:fresh})) return {ok:false};
        const e=nodes[index];
        e.style.setProperty('color','transparent','important');
        e.style.setProperty('text-shadow','none','important');
        e.style.setProperty('-webkit-text-security','disc','important');
        e.setAttribute('data-otto-entry-target',marker+'-'+fieldIndex+'-'+index);
      }
    }
    if(submit) {
      if(location.origin!==origin) return {ok:false};
      const fresh=document.querySelectorAll(submit);
      if(fresh.length!==1) return {ok:false};
      if(!usable(fresh[0]) || fresh[0].getAttribute?.('aria-disabled')==='true') return {ok:true,submitPending:true};
    }
    return {ok:true,counts:targets.map(target=>target.nodes.length)};
  })()`;
}
