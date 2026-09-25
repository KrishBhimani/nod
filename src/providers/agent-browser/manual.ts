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
  const e=document.activeElement;
  if(!e || !e.isConnected || e.disabled || e.readOnly || e.getClientRects().length===0 || getComputedStyle(e).visibility==='hidden' || getComputedStyle(e).display==='none' || e.closest('[hidden],[aria-hidden="true"],[inert],[aria-disabled="true"]') || !(e.matches('input,textarea') && !['file','hidden','button','submit','reset','checkbox','radio','range','color','image'].includes(e.type) || e.isContentEditable)) return false;
  e.setAttribute('data-sidekick-manual-field','true');
  e.style.setProperty('color','transparent','important');
  e.style.setProperty('text-shadow','none','important');
  e.style.setProperty('-webkit-text-security','disc','important');
  return true;
})()`;
