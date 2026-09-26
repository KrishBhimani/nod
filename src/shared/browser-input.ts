import { z } from 'zod';

export const browserKeySchema = z.enum([
  'Enter',
  'Tab',
  'Shift+Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
  'ControlOrMeta+A',
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
  'x',
  'y',
  'z',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
]);

export const browserInputSchema = z
  .discriminatedUnion('action', [
    z
      .object({
        action: z.literal('click'),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      })
      .strict(),
    z
      .object({
        action: z.literal('type'),
        text: z
          .string()
          .min(1)
          .max(8192)
          .refine((value) => !value.includes('\0')),
      })
      .strict(),
    z
      .object({
        action: z.literal('press'),
        key: browserKeySchema,
        modifiers: z
          .array(z.enum(['Control', 'Alt', 'Shift']))
          .max(3)
          .refine((values) => new Set(values).size === values.length)
          .optional(),
      })
      .strict(),
    z.object({ action: z.literal('scroll'), direction: z.enum(['up', 'down']) }).strict(),
    z
      .object({
        action: z.literal('wheel'),
        deltaX: z.number().int().min(-2000).max(2000),
        deltaY: z.number().int().min(-2000).max(2000),
      })
      .strict(),
  ])
  .refine(
    (input) =>
      input.action !== 'press' ||
      !/^[a-z0-9]$/.test(input.key) ||
      input.modifiers?.some((value) => value === 'Control' || value === 'Alt'),
    { message: 'Printable keys require a shortcut modifier.' },
  );

export type BrowserInput = z.infer<typeof browserInputSchema>;
