import type { CredentialInput } from '../../ports/computer.ts';

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
  for (const target of [...fields.map((field) => field.selector)]) {
    if (
      !target ||
      target.length > 500 ||
      (/^[\s@-]/.test(target) && !/^@e\d+$/.test(target)) ||
      target.includes('\0')
    )
      throw new Error('Secure entry requires a page field selector or browser reference.');
  }
  return fields;
}

export function credentialScript(origin: string, fields: CredentialField[], marker = ''): string {
  const safeFields = fields.map(({ value, ...field }) => ({
    ...field,
    length: value.length,
    numeric: /^\d+$/.test(value),
  }));
  return `(() => {
    const origin=${JSON.stringify(origin)}, fields=${JSON.stringify(safeFields)}, marker=${JSON.stringify(marker)};
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
    for(const {nodes} of targets) for(const e of nodes) if(e.readOnly) {
      if(changed()||targets.some(target=>invalid(target,true))) return {ok:false};
      e.focus({preventScroll:true});
      if(changed()) return {ok:false};
    }
    if(changed()||targets.some(target=>invalid(target))) return {ok:false};
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
    return {ok:true,counts:targets.map(target=>target.nodes.length)};
  })()`;
}
