import { z } from 'zod';

export const manualInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('click'),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .strict(),
  z.object({ action: z.literal('type'), text: z.string().min(1).max(8192) }).strict(),
  z
    .object({
      action: z.literal('press'),
      key: z.enum([
        'Enter',
        'Tab',
        'Shift+Tab',
        'Escape',
        'Backspace',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'ControlOrMeta+A',
      ]),
    })
    .strict(),
  z.object({ action: z.literal('scroll'), direction: z.enum(['up', 'down']) }).strict(),
]);

export const protectFocusedField = `(() => {
  const visible=e=>e&&e.isConnected&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none'&&!e.closest('[hidden],[aria-hidden="true"],[inert],[aria-disabled="true"]');
  let e=document.activeElement,depth=0;
  while(e?.matches('iframe,frame')) {
    if(!visible(e)) return false;
    if(++depth>8) return 'unsupported_frame';
    try { if(!e.contentDocument) return 'unsupported_frame'; e=e.contentDocument.activeElement; } catch { return 'unsupported_frame'; }
  }
  if(!visible(e) || e.disabled || e.readOnly || !(e.matches('input,textarea') && !['file','hidden','button','submit','reset','checkbox','radio','range','color','image'].includes(e.type) || e.isContentEditable)) return false;
  e.setAttribute('data-sidekick-manual-field','true');
  e.style.setProperty('color','transparent','important');
  e.style.setProperty('text-shadow','none','important');
  e.style.setProperty('-webkit-text-security','disc','important');
  return true;
})()`;

export function maskPageScript(selectors: string[], secrets: string[]): string {
  return `(() => {
    const selectors=${JSON.stringify(selectors)},secrets=${JSON.stringify(secrets)},documents=[document],nodes=new Set(),unreadableFrames=[];
    for(let index=0;index<documents.length;index++) {
      const page=documents[index];
      for(const frame of page.querySelectorAll('iframe,frame')) {
        let child;
        try { child=frame.contentDocument; } catch {}
        if(child&&!documents.includes(child)) {
          if(documents.length<16) documents.push(child);
          else frame.style.setProperty('visibility','hidden','important');
        }
        else if(!child) unreadableFrames.push(frame);
      }
      for(const e of page.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete="username"],input[data-sidekick-login-field^="identifier"]')) nodes.add(e);
      for(const selector of selectors) { try { for(const e of page.querySelectorAll(selector)) nodes.add(e); } catch {} }
      for(const e of page.querySelectorAll('input,textarea')) if(secrets.some(secret=>secret&&String(e.value??e.textContent??'').includes(secret))) nodes.add(e);
    }
    if(nodes.size>40) throw new Error('Too many protected fields');
    const values=[...nodes].map(e=>String(e.value??e.textContent??'')).filter(Boolean);
    if(values.some(value=>value.length>8192)) throw new Error('Protected field exceeds limit');
    for(const value of values) if(!secrets.includes(value)) secrets.push(value);
    if(secrets.length) for(const frame of unreadableFrames) frame.style.setProperty('visibility','hidden','important');
    for(const e of nodes) {
      e.style.setProperty('color','transparent','important');
      e.style.setProperty('text-shadow','none','important');
      e.style.setProperty('-webkit-text-security','disc','important');
    }
    for(const page of documents) if(page.body&&secrets.length) {
      const walker=page.createTreeWalker(page.body,NodeFilter.SHOW_TEXT);
      while(walker.nextNode()) {
        const node=walker.currentNode,parent=node.parentElement;
        if(parent&&!['SCRIPT','STYLE'].includes(parent.tagName)&&secrets.some(secret=>secret&&node.textContent.includes(secret))) {
          parent.style.setProperty('color','transparent','important');
          parent.style.setProperty('text-shadow','none','important');
        }
      }
    }
    return {masked:true,values};
  })()`;
}
