import type { CredentialInput } from '../../ports/computer.ts';
import { loginTargetScript } from './login.ts';

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

export function credentialEntryScript(origin: string, fields: CredentialField[]): string {
  const entries = fields.map(({ value, ...field }) => ({
    ...field,
    length: value.length,
    numeric: /^\d+$/.test(value),
    value,
  }));
  return `(() => {
    if(location.origin!==${JSON.stringify(origin)}) return {ok:false};
    ${loginTargetScript}
    const origin=${JSON.stringify(origin)},fields=${JSON.stringify(entries)};
    const targets=fields.map(field=>({field,nodes:resolve(field.selector)}));
    const kind=field=>field.password?'password':field.code?'otp':'identifier';
    const invalid=({field,nodes},readonly)=>!valid(nodes,kind(field))||nodes.some(e=>!readonly&&e.readOnly)||(nodes.length>1&&(!field.numeric||nodes.length!==field.length))||(field.code&&nodes.length===1&&nodes[0].maxLength>0&&nodes[0].maxLength<field.length);
    const changed=()=>location.origin!==origin||targets.some(({field,nodes})=>{
      const fresh=resolve(field.selector);
      return fresh.length!==nodes.length||fresh.some((e,i)=>e!==nodes[i]);
    });
    const nodes=targets.flatMap(target=>target.nodes),entryDocument=document;
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    const clear=()=>{
      for(const e of nodes) {
        if(e.ownerDocument!==entryDocument) continue;
        try {setter.call(e,'');} catch {continue;}
        for(const type of ['input','change']) if(e.ownerDocument===entryDocument) {
          try {e.dispatchEvent(new Event(type,{bubbles:true}));} catch {}
        }
      }
    };
    try {
      if(changed()||targets.some(target=>invalid(target,true))||new Set(nodes).size!==nodes.length||!sameForm(nodes)) return {ok:false};
      for(const e of nodes) {
        e.focus({preventScroll:true});
        if(changed()||targets.some(target=>invalid(target,true))) return {ok:false};
      }
      if(changed()||targets.some(target=>invalid(target,false))) return {ok:false};
      for(const e of nodes) {
        e.style.setProperty('color','transparent','important');
        e.style.setProperty('text-shadow','none','important');
        e.style.setProperty('-webkit-text-security','disc','important');
      }
      for(const {field,nodes:parts} of targets) for(const [index,e] of parts.entries()) {
        if(changed()||targets.some(target=>invalid(target,false))) {clear();return {ok:false};}
        setter.call(e,parts.length===1?field.value:field.value[index]);
        e.dispatchEvent(new Event('input',{bubbles:true}));
        if(changed()||targets.some(target=>invalid(target,false))) {clear();return {ok:false};}
        e.dispatchEvent(new Event('change',{bubbles:true}));
        if(changed()||targets.some(target=>invalid(target,false))) {clear();return {ok:false};}
      }
      return {ok:true,counts:targets.map(target=>target.nodes.length)};
    } catch { clear();return {ok:false}; }
  })()`;
}
