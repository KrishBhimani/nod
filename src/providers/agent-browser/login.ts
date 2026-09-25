import { z } from 'zod';

export const loginInspectionSchema = z.object({
  origin: z.string().max(2048),
  url: z.string().max(8192),
  issue: z.literal('browser_not_supported').optional(),
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
    const visible=e=>e && e.isConnected && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden' && getComputedStyle(e).display!=='none' && !e.closest('[hidden],[aria-hidden="true"],[inert]');
    const enabled=e=>!e.disabled && !e.closest('[aria-disabled="true"]');
    const inside=(scope,e)=>scope===document||scope.contains(e);
    const marked=document.querySelectorAll('[data-sidekick-login-field],[data-sidekick-login-method],[data-sidekick-login-submit]');
    for(const e of marked) for(const name of ['data-sidekick-login-field','data-sidekick-login-method','data-sidekick-login-submit']) e.removeAttribute(name);
    const dialogs=[...document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"]')].filter(visible);
    const front=dialogs.filter(e=>!dialogs.some(other=>other!==e&&e.contains(other)));
    const focused=front.filter(e=>e.contains(document.activeElement));
    const ambiguousDialogs=front.length>1&&focused.length!==1;
    const scope=focused.length===1?focused[0]:front.length===1?front[0]:document;
    const textRoot=scope===document?document.body:scope;
    const walker=textRoot&&document.createTreeWalker(textRoot,NodeFilter.SHOW_TEXT);
    let visibleText='',visited=0;
    while(walker&&visited++<10000&&visibleText.length<20000&&walker.nextNode()) {
      const node=walker.currentNode,parent=node.parentElement;
      if(visible(parent)&&!parent.closest('script,style,noscript,textarea')) visibleText+=' '+(node.textContent||'').slice(0,20000-visibleText.length);
    }
    const pageText=visibleText.replace(/\\s+/g,' ').trim();
    const browserWarning=/this browser or app may not be secure/i.test(pageText);
    const rejectedSignIn=/(?:could not|couldn't|couldn’t|cannot|can't|can’t|unable to) sign (?:you )?in/i.test(pageText);
    const unsupportedBrowser=/(?:this|your) browser(?: or app)? (?:is not|isn't|isn’t|is no longer) supported|(?:try |using |use |a )(?:supported|different|another) browser/i.test(pageText);
    if(!ambiguousDialogs&&(browserWarning||(rejectedSignIn&&unsupportedBrowser))) return {origin:location.origin,url:location.href,issue:'browser_not_supported',fields:[],methods:[]};
    const candidates=[...document.querySelectorAll('input')].filter(e=>inside(scope,e)&&visible(e)&&enabled(e)&&!e.readOnly&&['text','email','tel','password','number'].includes(e.type));
    const hint=e=>[e.id,e.name,e.autocomplete,e.getAttribute('aria-label'),e.getAttribute('placeholder'),e.getAttribute('inputmode'),...[...(e.labels||[])].map(label=>label.innerText),...(e.getAttribute('aria-labelledby')||'').split(' ').map(id=>document.getElementById?.(id)?.innerText||'')].join(' ').toLowerCase();
    const kindOf=e=>/one-time-code|verification.?code|authentication.?code|security.?code|authenticator|(?:^|[^a-z])(?:otp|totp)(?:[^a-z]|$)/.test(hint(e))?'otp':e.type==='password'?'password':e.type==='email'||/username|user.?name|identifier|phone|email/.test(hint(e))?'identifier':null;
    const forms=[...document.querySelectorAll('form')].filter(e=>inside(scope,e)&&visible(e)&&candidates.some(input=>e.contains(input)&&kindOf(input)));
    const activeForms=forms.filter(e=>e.contains(document.activeElement));
    const ambiguousForms=forms.length>1&&activeForms.length!==1;
    const fieldScope=activeForms.length===1?activeForms[0]:forms.length===1?forms[0]:scope;
    const inputs=candidates.filter(e=>inside(fieldScope,e));
    const fields=[];
    const labels={identifier:'Email, phone number or username',password:'Password',otp:'Verification code'};
    for(const e of inputs) {
      let kind=kindOf(e);
      if(!kind&&inputs.length===1&&/log.?in|sign.?in|account/i.test(fieldScope.innerText||scope.innerText||document.body?.innerText||'')&&['text','tel'].includes(e.type)) kind='identifier';
      if(!kind) continue;
      const marker=kind+'-'+fields.filter(f=>f.kind===kind).length;
      e.setAttribute('data-sidekick-login-field',marker);
      fields.push({kind,selector:'[data-sidekick-login-field="'+marker+'"]',label:labels[kind]});
    }
    const candidatesByMethod=new Map();
    const controls=[...document.querySelectorAll('button,a,[role="button"],input[type="submit"]')].filter(e=>inside(scope,e)&&visible(e));
    let submit;
    const add=(id,method,e)=>{
      const current=candidatesByMethod.get(id);
      const supported=!ambiguousDialogs&&e.getAttribute('target')!=='_blank'&&enabled(e);
      const native=['BUTTON','A','INPUT'].includes(e.tagName);
      const nestedNative=current&&native&&!current.native&&current.element?.contains(e);
      if(!current||nestedNative||(supported&&!current.method.supported)||(supported===current.method.supported&&native&&!current.native)) candidatesByMethod.set(id,{method:{id,...method,supported},element:e,native});
    };
    for(const e of controls) {
      const label=(e.innerText||e.getAttribute('aria-label')||e.getAttribute('value')||'').trim();
      const factor=/authenticator|authentication app/i.test(label)?{id:'authenticator',label:'Use an authenticator app'}:/backup.code|recovery.code/i.test(label)?{id:'backup',label:'Use a backup code'}:/sms|text message|send.*phone|phone.*code/i.test(label)?{id:'sms',label:'Get a code by text message'}:/email.*code|code.*email/i.test(label)?{id:'email',label:'Get a code by email'}:null;
      const provider=['Google','Apple','Microsoft','GitHub','Facebook'].find(name=>new RegExp('\\\\b'+name+'\\\\b','i').test(label));
      if(provider&&/sign|log|continue|connect|use|with/i.test(label)) {
        add('oauth-'+provider.toLowerCase(),{label:'Continue with '+provider,kind:'oauth'},e);
      } else if(/passkey|security key|webauthn/i.test(label)) {
        if(!candidatesByMethod.has('passkey')) candidatesByMethod.set('passkey',{method:{id:'passkey',label:'Use a passkey or security key',kind:'passkey',supported:false,reason:'Device passkeys and hardware security keys are not supported in this browser.'}});
      } else if(factor) {
        add('verification-'+factor.id,{label:factor.label,kind:'credentials'},e);
      } else if(!submit&&inside(fieldScope,e)&&(/^(next|continue|log in|sign in|login|verify|submit|confirm)(\\s|$)/i.test(label)||e.type==='submit')) {
        submit=e;
      }
    }
    const methods=[...candidatesByMethod.values()].map(({method,element})=>{
      if(!element) return method;
      element.setAttribute('data-sidekick-login-method',method.id);
      return {...method,selector:'[data-sidekick-login-method="'+method.id+'"]',reason:method.supported?(method.kind==='oauth'?'Opens this website’s sign-in flow. Further secure steps may be required.':'Chooses this verification method on the website. Enter any resulting code only in the secure form.'):'This option is unavailable, ambiguous, or requires a separate window.'};
    });
    const unambiguous=!ambiguousDialogs&&!ambiguousForms&&['identifier','password','otp'].every(kind=>fields.filter(field=>field.kind===kind).length<=1);
    let submitSelector;
    if(submit&&unambiguous) {
      submit.setAttribute('data-sidekick-login-submit','current');
      submitSelector='[data-sidekick-login-submit="current"]';
    }
    if(fields.length) methods.unshift({id:'credentials',label:fields.some(field=>field.kind==='otp')?'Enter a verification code securely':'Use the secure form',kind:'credentials',supported:unambiguous,reason:unambiguous?undefined:'More than one credential field or active form matches this step. Choose another method or take over the browser.'});
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
