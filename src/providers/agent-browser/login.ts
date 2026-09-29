import { z } from 'zod';

const currentContextScript = `e=>{
  const form=e.tagName==='A'?null:e.form||e.closest('form');
  const target=(e.getAttribute('formtarget')??e.getAttribute('target')??form?.getAttribute('target')??document.querySelector?.('base[target]')?.getAttribute('target')??'').trim().toLowerCase();
  return !target||target==='_self';
}`;

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
        group: z.string().max(100).optional(),
        selected: z.boolean().optional(),
      }),
    )
    .max(20),
  submitSelector: z.string().max(500).optional(),
  emailCode: z
    .object({
      recipient: z.email().max(320).optional(),
      recipientHint: z.string().min(3).max(320).optional(),
      length: z.number().int().min(4).max(8).optional(),
    })
    .optional(),
});

export function loginInspectionScript(): string {
  return `(() => {
    const visible=e=>e && e.isConnected && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden' && getComputedStyle(e).display!=='none' && !e.closest('[hidden],[aria-hidden="true"],[inert]');
    const enabled=e=>!e.disabled && !e.closest('[aria-disabled="true"]');
    const inside=(scope,e)=>scope===document||scope.contains(e);
    const marked=document.querySelectorAll('[data-otto-login-field],[data-otto-login-method],[data-otto-login-submit]');
    for(const e of marked) for(const name of ['data-otto-login-field','data-otto-login-method','data-otto-login-submit']) e.removeAttribute(name);
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
    const candidates=[...document.querySelectorAll('input')].filter(e=>inside(scope,e)&&visible(e)&&enabled(e)&&(!e.readOnly||e.getAttribute('onfocus')?.trim())&&['text','email','tel','password','number'].includes(e.type));
    const labelText=e=>e?.innerText||e?.textContent||'';
    const normalized=text=>text.normalize('NFD').replace(/\\p{M}/gu,'').toLowerCase();
    const nearbyLabel=e=>{
      if(e.tagName!=='INPUT') return undefined;
      let container=e.parentElement;
      for(let depth=0;container&&depth<3;depth++,container=container.parentElement) {
        if(['BODY','FORM','HTML'].includes(container.tagName)||candidates.filter(input=>container.contains(input)).length!==1) break;
        const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT);
        const labels=new Set();
        let visited=0;
        while(visited++<100&&walker.nextNode()) {
          const node=walker.currentNode,parent=node.parentElement;
          if(!visible(parent)||parent.closest('script,style,noscript,textarea,button,select,option')) continue;
          const text=(node.textContent||'').replace(/\\s+/g,' ').trim();
          if(!text||text.length>100||candidates.some(input=>input.value&&text.includes(input.value))) continue;
          if(/^(?:(?:o seu|seu|your|inserir|introduza|enter(?: your)?) )?(?:(?:numero (?:de )?)?(?:telemovel|telefone)|phone(?: number)?|e.?mail(?: address)?|username|nome de utilizador|palavra.passe|password|pin(?: de autenticacao)?|nif|eori|codigo (?:de )?(?:seguranca|confirmacao|verificacao|autenticacao|sms))(?: *[:*])?$/.test(normalized(text))) labels.add(text);
        }
        if(labels.size===1) return [...labels][0];
        if(labels.size>1) return undefined;
      }
      return undefined;
    };
    const observedLabel=e=>[...[...(e.labels||[])].filter(visible).map(labelText),...(e.getAttribute('aria-labelledby')||'').split(' ').map(id=>document.getElementById?.(id)).filter(visible).map(labelText),e.getAttribute('aria-label'),e.getAttribute('placeholder'),nearbyLabel(e)].map(text=>(text||'').replace(/\\s+/g,' ').trim()).find(Boolean);
    const hint=e=>normalized([e.id,e.name,e.autocomplete,e.getAttribute('inputmode'),observedLabel(e)].join(' '));
    const identifierLabel=e=>(observedLabel(e)||(e.type==='email'||/email/.test(hint(e))?'Email':e.type==='tel'||/phone/.test(hint(e))?'Phone':'Username')).slice(0,80);
    const otpHint=text=>/one-time-code|verification.?code|authentication.?code|security.?code|authenticator|(?:^|[^a-z])(?:otp|totp)(?:[^a-z]|$)|codigo.{0,20}(?:verificacao|seguranca|confirmacao|autenticacao|sms|temporario)|(?:pin|codigo).{0,20}(?:uso unico|utilizacao unica|temporario)/.test(text);
    const secretHint=text=>/password|passphrase|passcode|palavra.passe|senha|(?:^|[^a-z])pin(?:[^a-z]|$)/.test(text);
    const identifierLabelHint=text=>/^(?:(?:o seu|seu|your|inserir|introduza|enter(?: your)?) )?(?:(?:numero (?:de )?)?(?:telemovel|telefone)|(?:mobile )?phone(?: number)?|e.?mail(?: address)?|username|nome de utilizador|nif|eori)(?: *[:*])?$/.test(text);
    const kindOf=e=>e.type!=='password'&&identifierLabelHint(normalized(observedLabel(e)||''))?'identifier':otpHint(hint(e))?'otp':e.type==='password'?'password':secretHint(hint(e))?null:['email','tel'].includes(e.type)||/username|user.?name|identifier|phone|email|telemovel|telefone|utilizador|contribuinte|tax.?id|document.?number|numero.{0,20}(?:fiscal|documento|identificacao)|(?:^|[^a-z])(?:nif|eori|tel)(?:[^a-z]|$)/.test(hint(e))?'identifier':null;
    const forms=[...document.querySelectorAll('form')].filter(e=>inside(scope,e)&&visible(e)&&candidates.some(input=>e.contains(input)));
    const activeForms=forms.filter(e=>e.contains(document.activeElement));
    const ambiguousForms=forms.length>1&&activeForms.length!==1;
    const fieldScope=activeForms.length===1?activeForms[0]:forms.length===1?forms[0]:scope;
    const inputs=candidates.filter(e=>inside(fieldScope,e));
    const fields=[];
    const labels={identifier:'Email, phone number or username',password:'Password',otp:'Verification code'};
    const digitGroup=inputs.length>=4&&inputs.length<=8&&inputs.every(e=>e.maxLength===1&&['text','tel','number'].includes(e.type)&&e.parentElement===inputs[0].parentElement)&&inputs.some(e=>/one-time-code|otp|totp|verification|verifica|authenticat|autentica|security.?code/.test([hint(e),e.className,e.parentElement?.id,e.parentElement?.className].join(' ').toLowerCase()));
    if(digitGroup) {
      for(const e of inputs) e.setAttribute('data-otto-login-field','otp-0');
      fields.push({kind:'otp',selector:'[data-otto-login-field="otp-0"]',label:labels.otp});
    }
    for(const e of inputs) {
      if(digitGroup) break;
      let kind=kindOf(e);
      if(!kind&&!secretHint(hint(e))&&inputs.length===1&&/log.?in|sign.?in|account|autenticacao|iniciar sessao/.test(normalized(fieldScope.innerText||scope.innerText||document.body?.innerText||''))&&['text','tel'].includes(e.type)) kind='identifier';
      if(!kind) continue;
      const marker=kind+'-'+fields.filter(f=>f.kind===kind).length;
      e.setAttribute('data-otto-login-field',marker);
      fields.push({kind,selector:'[data-otto-login-field="'+marker+'"]',label:kind==='identifier'?identifierLabel(e):(observedLabel(e)||labels[kind]).slice(0,80)});
    }
    const unsupportedSecrets=inputs.filter(e=>e.type!=='password'&&secretHint(hint(e))&&!otpHint(hint(e)));
    for(const [index,e] of unsupportedSecrets.entries()) e.setAttribute('data-otto-login-field','password-unsupported-'+index);
    const candidatesByMethod=new Map();
    const controls=[...document.querySelectorAll('button,a,[role="button"],input[type="submit"],input[type="radio"],[role="radio"],[role="tab"]')].filter(e=>inside(scope,e)&&visible(e));
    let submit;
    const currentContext=${currentContextScript};
    const authentication=text=>/log.?in|sign.?in|authentication|autenticacao|iniciar sessao|identidade/.test(normalized(text));
    const controlLabel=e=>(observedLabel(e)||e.innerText||(e.tagName==='INPUT'&&['submit','button'].includes(e.type)?e.getAttribute('value'):'')||[...(e.querySelectorAll?.('img[alt]')||[])].filter(visible).map(image=>image.getAttribute('alt')).join(' ')||'').replace(/\\s+/g,' ').trim().slice(0,100);
    const groupOf=e=>{
      const container=e.closest('fieldset,[role="radiogroup"],[role="tablist"]');
      if(!container) return undefined;
      const legend=[...container.children].find(child=>child.tagName==='LEGEND');
      return (observedLabel(container)||labelText(legend)||'').replace(/\\s+/g,' ').trim().slice(0,100)||undefined;
    };
    const methodId=(label,group)=>{
      let hash=2166136261;
      for(const character of (group||'')+'|'+label) hash=Math.imul(hash^character.charCodeAt(0),16777619);
      return 'choice-'+(hash>>>0).toString(16);
    };
    const add=(id,method,e)=>{
      const current=candidatesByMethod.get(id);
      if(current?.ambiguous) return;
      if(current&&id.startsWith('choice-')&&current.element!==e&&!current.element.contains(e)&&!e.contains(current.element)) {
        current.method.supported=false;
        current.ambiguous=true;
        return;
      }
      const supported=!ambiguousDialogs&&currentContext(e)&&enabled(e);
      const native=['BUTTON','A','INPUT'].includes(e.tagName);
      const nestedNative=current&&native&&!current.native&&current.element?.contains(e);
      if(!current||nestedNative||(supported&&!current.method.supported)||(supported===current.method.supported&&native&&!current.native)) candidatesByMethod.set(id,{method:{id,...method,supported},element:e,native});
    };
    for(const e of controls) {
      const label=controlLabel(e);
      if(!label) continue;
      const group=groupOf(e);
      const choice=['tab','radio'].includes(e.getAttribute('role'))||e.type==='radio';
      const semantic=/chave movel digital|cartao de cidadao|codigo qr|qr code|telemovel|(?:^|[^a-z])(?:cc|cmd|nif|eori|sso)(?:[^a-z]|$)/.test(normalized(label));
      if(choice&&(authentication(group||'')||(authentication(pageText)&&semantic))) {
        const selected=e.type==='radio'?e.checked:e.getAttribute('aria-selected')==='true'||e.getAttribute('aria-checked')==='true';
        add(methodId(label,group),{label,kind:'credentials',...(group?{group}:{}),selected},e);
        continue;
      }
      const factor=/authenticator|authentication app/i.test(label)?{id:'authenticator',label:'Use an authenticator app'}:/backup.code|recovery.code/i.test(label)?{id:'backup',label:'Use a backup code'}:/sms|text message|send.*phone|phone.*code/i.test(label)?{id:'sms',label:'Get a code by text message'}:/email.*code|code.*email/i.test(label)?{id:'email',label:'Get a code by email'}:null;
      const provider=['Google','Apple','Microsoft','GitHub','Facebook'].find(name=>new RegExp('\\\\b'+name+'\\\\b','i').test(label));
      if(provider&&/sign|log|continue|connect|use|with/i.test(label)) {
        add('oauth-'+provider.toLowerCase(),{label:'Continue with '+provider,kind:'oauth'},e);
      } else if(/passkey|security key|webauthn/i.test(label)) {
        if(!candidatesByMethod.has('passkey')) candidatesByMethod.set('passkey',{method:{id:'passkey',label:'Use a passkey or security key',kind:'passkey',supported:false,reason:'Device passkeys and hardware security keys are not supported in this browser.'}});
      } else if(factor) {
        add('verification-'+factor.id,{label:factor.label,kind:'credentials'},e);
      } else if(!choice&&!fields.length&&authentication(pageText)&&(semantic||authentication(label))) {
        add(methodId(label,group),{label,kind:'credentials',...(group?{group}:{})},e);
      } else if(!submit&&!choice&&inside(fieldScope,e)&&(/^(next|continue|log in|sign in|login|verify|submit|confirm|entrar|iniciar sess[aã]o|continuar|seguinte|verificar|confirmar|autenticar)(\\s|$)/i.test(label)||e.type==='submit')) {
        submit=e;
      }
    }
    if(!fields.length&&submit&&candidatesByMethod.size) add('continue',{label:controlLabel(submit),kind:'credentials'},submit);
    const methods=[...candidatesByMethod.values()].map(({method,element})=>{
      if(!element) return method;
      element.setAttribute('data-otto-login-method',method.id);
      return {...method,selector:'[data-otto-login-method="'+method.id+'"]',reason:method.supported?(method.kind==='oauth'?'Opens this website’s sign-in flow. Further secure steps may be required.':/cartao de cidadao|codigo qr|qr code/.test(normalized(method.label))?'Selects this sign-in option. The user may need to finish with a card reader or their own device.':'Continues this sign-in step on the website. Secrets stay in the secure credential flow.'):'This option is unavailable, ambiguous, or requires a separate window.'};
    });
    const unambiguous=!ambiguousDialogs&&!ambiguousForms&&!unsupportedSecrets.length&&(!submit||currentContext(submit))&&['identifier','password','otp'].every(kind=>fields.filter(field=>field.kind===kind).length<=1);
    let submitSelector;
    if(submit&&unambiguous) {
      submit.setAttribute('data-otto-login-submit','current');
      submitSelector='[data-otto-login-submit="current"]';
    }
    if(fields.length) methods.unshift({id:'credentials',label:(fields.find(field=>field.kind==='identifier')||fields.find(field=>field.kind==='otp')||fields[0]).label,kind:'credentials',supported:unambiguous,reason:unambiguous?undefined:'More than one credential field or active form matches this step. Choose another method or take over the browser.'});
    if(unsupportedSecrets.length) methods.push({id:'private-entry',label:(observedLabel(unsupportedSecrets[0])||'Private sign-in').slice(0,100),kind:'manual',supported:false,reason:'This secret field is not a password input. Finish privately in the browser.'});
    let emailCode;
    if(unambiguous&&fields.length===1&&fields[0].kind==='otp') {
      const root=fieldScope===document?document.body:fieldScope;
      const nodes=root&&document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
      let text='',count=0;
      while(nodes&&count++<1000&&text.length<4000&&nodes.nextNode()) {
        const node=nodes.currentNode,parent=node.parentElement;
        if(visible(parent)&&!parent.closest('script,style,noscript,textarea')) text+=' '+(node.textContent||'').slice(0,4000-text.length);
      }
      text=text.replace(/\\s+/g,' ');
      const recipients=[...new Set(text.match(/[a-z0-9._%+*•-]+@[a-z0-9.*•-]+\\.[a-z*•]{2,}/gi)||[])];
      const delivery=normalized(text);
      const sent=/(?:code|codigo).{0,100}(?:sent|enviad[oa]|enviamos|emailed)|(?:sent|enviad[oa]|enviamos|emailed).{0,100}(?:code|codigo)/.test(delivery);
      const emailDelivery=/e.?mail|correio eletronico|caixa de entrada/.test(delivery);
      const smsDelivery=/sms|text message|mensagem de texto/.test(delivery);
      const recipient=recipients[0];
      const masked=recipient&&/[*•]/.test(recipient);
      if(sent&&!smsDelivery&&recipients.length<=1&&(!recipient?emailDelivery:recipient.length<=320&&(!masked||emailDelivery))) {
        const length=digitGroup?inputs.length:inputs[0]?.maxLength;
        emailCode={...(recipient?masked?{recipientHint:recipient}:{recipient}:{}),...(length>=4&&length<=8?{length}:{})};
      }
    }
    return {origin:location.origin,url:location.href,fields,methods,submitSelector,...(emailCode?{emailCode}:{})};
  })()`;
}

export function credentialSubmitScript(origin: string, selector: string): string {
  return `(async () => {
    const origin=${JSON.stringify(origin)},selector=${JSON.stringify(selector)};
    const currentContext=${currentContextScript};
    for(let attempt=0;attempt<30;attempt++) {
      if(location.origin!==origin) return {ok:false};
      const nodes=document.querySelectorAll(selector);
      if(nodes.length!==1) return {ok:false};
      const e=nodes[0];
      if(!currentContext(e)) return {ok:false};
      if(e.isConnected && !e.disabled && !e.closest('[hidden],[aria-hidden="true"],[inert],[aria-disabled="true"]') && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden' && getComputedStyle(e).display!=='none') { e.click(); return {ok:true}; }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    return {ok:false};
  })()`;
}
