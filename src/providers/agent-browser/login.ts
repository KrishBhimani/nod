import { z } from 'zod';

export const loginInspectionSchema = z.object({
  origin: z.string().max(2048),
  url: z.string().max(8192),
  fields: z
    .array(
      z.object({
        kind: z.enum(['identifier', 'password', 'otp']),
        selector: z.string().min(1).max(500),
        label: z.string().max(100),
      }),
    )
    .max(20),
  methods: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        label: z.string().max(100),
        kind: z.enum(['credentials', 'oauth', 'passkey', 'manual']),
        supported: z.boolean(),
        reason: z.string().max(500).optional(),
        selector: z.string().max(500).optional(),
      }),
    )
    .max(20),
  submitSelector: z.string().max(500).optional(),
});

export function loginInspectionScript(): string {
  return `(() => {
    const visible=e=>e && e.isConnected && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden' && getComputedStyle(e).display!=='none' && !e.closest('[hidden],[aria-hidden="true"]');
    const inputs=[...document.querySelectorAll('input')].filter(e=>visible(e) && !e.disabled && !e.readOnly && !['hidden','submit','button','checkbox','radio','file'].includes(e.type));
    const fields=[];
    const labels={identifier:'Email, phone number or username',password:'Password',otp:'Verification code'};
    for(const e of inputs) {
      const hint=[e.name,e.autocomplete,e.getAttribute('aria-label'),e.getAttribute('placeholder'),e.getAttribute('inputmode')].join(' ').toLowerCase();
      let kind=/one-time-code|verification|authenticator|security.code|otp|challenge.response/.test(hint)?'otp':e.type==='password'?'password':e.type==='email'||/username|user.name|identifier|phone|email/.test(hint)?'identifier':null;
      if(!kind && inputs.length===1 && /log.?in|sign.?in|account/i.test(document.body?.innerText??'') && ['text','tel'].includes(e.type)) kind='identifier';
      if(!kind) continue;
      const marker=kind+'-'+fields.filter(f=>f.kind===kind).length;
      e.setAttribute('data-sidekick-login-field',marker);
      fields.push({kind,selector:'[data-sidekick-login-field="'+marker+'"]',label:labels[kind]});
    }
    const methods=[];
    const controls=[...document.querySelectorAll('button,a,[role="button"],input[type="submit"]')].filter(visible);
    let submitSelector;
    for(const e of controls) {
      const label=(e.innerText||e.getAttribute('aria-label')||e.getAttribute('value')||'').trim();
      const factor=/authenticator|authentication app/i.test(label)?{id:'authenticator',label:'Use an authenticator app'}:/backup.code|recovery.code/i.test(label)?{id:'backup',label:'Use a backup code'}:/sms|text message|send.*phone|phone.*code/i.test(label)?{id:'sms',label:'Get a code by text message'}:/email.*code|code.*email/i.test(label)?{id:'email',label:'Get a code by email'}:null;
      const provider=['Google','Apple','Microsoft','GitHub','Facebook'].find(name=>new RegExp('\\\\b'+name+'\\\\b','i').test(label));
      if(provider && /sign|log|continue|connect|use|with/i.test(label)) {
        const id='oauth-'+provider.toLowerCase()+'-'+methods.filter(m=>m.kind==='oauth').length;
        e.setAttribute('data-sidekick-login-method',id);
        const supported=e.getAttribute('target')!=='_blank' && !e.disabled && e.getAttribute('aria-disabled')!=='true';
        methods.push({id,label:'Continue with '+provider,kind:'oauth',supported,selector:'[data-sidekick-login-method="'+id+'"]',reason:supported?'Opens this website’s sign-in flow. Further secure steps may be required.':'This option requires a separate window or is currently unavailable.'});
      } else if(/passkey|security key|webauthn/i.test(label)) {
        methods.push({id:'passkey',label:'Use a passkey or security key',kind:'passkey',supported:false,reason:'Device passkeys and hardware security keys are not supported in this browser.'});
      } else if(factor) {
        const id='verification-'+factor.id+'-'+methods.filter(m=>m.kind==='credentials').length;
        e.setAttribute('data-sidekick-login-method',id);
        const supported=e.getAttribute('target')!=='_blank' && !e.disabled && e.getAttribute('aria-disabled')!=='true';
        methods.push({id,label:factor.label,kind:'credentials',supported,selector:'[data-sidekick-login-method="'+id+'"]',reason:supported?'Chooses this verification method on the website. Enter any resulting code only in the secure form.':'This method is currently unavailable in this browser.'});
      } else if(!submitSelector && (/^(next|continue|log in|sign in|login|verify|submit|confirm)(\\s|$)/i.test(label)||e.type==='submit')) {
        e.setAttribute('data-sidekick-login-submit','current');
        submitSelector='[data-sidekick-login-submit="current"]';
      }
    }
    if(fields.length) {
      const supported=['identifier','password','otp'].every(kind=>fields.filter(field=>field.kind===kind).length<=1);
      methods.unshift({id:'credentials',label:fields.some(field=>field.kind==='otp')?'Enter a verification code securely':'Use the secure form',kind:'credentials',supported,reason:supported?undefined:'This page uses multiple fields for one credential step and needs another method.'});
    }
    methods.push({id:'manual',label:'Use another browser or device',kind:'manual',supported:false,reason:'Signing in elsewhere does not sign in this task browser. Remote manual control is not available.'});
    return {origin:location.origin,url:location.href,fields,methods,submitSelector};
  })()`;
}

export function credentialSubmitScript(origin: string, selector: string): string {
  return `(async () => {
    const origin=${JSON.stringify(origin)},selector=${JSON.stringify(selector)};
    for(let attempt=0;attempt<30;attempt++) {
      if(location.origin!==origin) return {ok:false};
      const nodes=document.querySelectorAll(selector);
      if(nodes.length!==1) return {ok:false};
      const e=nodes[0];
      if(e.isConnected && !e.disabled && e.getAttribute('aria-disabled')!=='true' && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden' && getComputedStyle(e).display!=='none') { e.click(); return {ok:true}; }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    return {ok:false};
  })()`;
}
