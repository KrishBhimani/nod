import { z } from 'zod';
import { manualInputSchema } from '../agent-browser/manual.ts';

export const browserSocketPath = '/data/control.sock';
export const requestBytes = 128 * 1024;
export const responseBytes = 17 * 1024 * 1024;
export const imageBytes = 12 * 1024 * 1024;

const identity = {
  id: z.uuid(),
  namespace: z.string().regex(/^sk-[a-f0-9]{24}$/),
};
const task = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const selector = z.string().min(1).max(500);
export const browserDownloadInput = z
  .object({
    selector: selector.optional(),
    url: z.string().min(1).max(8192).optional(),
    name: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^/\\\u0000-\u001f\u007f]+$/)
      .optional(),
  })
  .strict()
  .refine((input) => !(input.selector && input.url));
const browserAction = z
  .object({
    action: z.enum(['open', 'snapshot', 'click', 'fill', 'scroll']),
    url: z.string().max(8192).optional(),
    selector: selector.optional(),
    text: z.string().max(20_000).optional(),
    direction: z.enum(['up', 'down']).optional(),
  })
  .strict();
const credential = z
  .object({
    taskId: task,
    origin: z.string().max(2048),
    kind: z.enum(['identifier', 'password', 'otp']).optional(),
    username: z.string().max(8192).optional(),
    password: z.string().max(8192).optional(),
    code: z.string().max(8192).optional(),
    usernameSelector: selector.optional(),
    passwordSelector: selector.optional(),
    submitSelector: selector.optional(),
  })
  .strict();

export const browserRequest = z.discriminatedUnion('method', [
  z.object({ ...identity, method: z.literal('act'), taskId: task, input: browserAction }).strict(),
  z
    .object({
      ...identity,
      method: z.literal('download'),
      taskId: task,
      input: browserDownloadInput,
    })
    .strict(),
  z.object({ ...identity, method: z.literal('screenshot'), taskId: task }).strict(),
  z.object({ ...identity, method: z.literal('signInScreenshot'), taskId: task }).strict(),
  z.object({ ...identity, method: z.literal('takeControl'), taskId: task }).strict(),
  z.object({ ...identity, method: z.literal('openSignIn'), taskId: task }).strict(),
  z.object({ ...identity, method: z.literal('finishSignIn'), taskId: task }).strict(),
  z
    .object({ ...identity, method: z.literal('control'), taskId: task, input: manualInputSchema })
    .strict(),
  z
    .object({
      ...identity,
      method: z.literal('signInControl'),
      taskId: task,
      input: manualInputSchema,
    })
    .strict(),
  z.object({ ...identity, method: z.literal('releaseControl'), taskId: task }).strict(),
  z.object({ ...identity, method: z.literal('inspectLogin'), taskId: task }).strict(),
  z
    .object({
      ...identity,
      method: z.literal('selectLoginMethod'),
      taskId: task,
      origin: z.string().max(2048),
      methodId: z.string().max(100),
    })
    .strict(),
  z.object({ ...identity, method: z.literal('injectCredentials'), input: credential }).strict(),
  z
    .object({
      ...identity,
      method: z.literal('hold'),
      taskId: task,
      until: z.number().finite().nullable(),
    })
    .strict(),
  z.object({ ...identity, method: z.literal('close'), taskId: task }).strict(),
  z.object({ ...identity, method: z.literal('dispose') }).strict(),
  z.object({ ...identity, method: z.literal('quiesce') }).strict(),
  z.object({ ...identity, method: z.literal('status') }).strict(),
]);

export type BrowserRequest = z.infer<typeof browserRequest>;
export type BrowserCall = BrowserRequest extends infer R
  ? R extends BrowserRequest
    ? Omit<R, 'id' | 'namespace'>
    : never
  : never;
export const browserFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request'), request: browserRequest }).strict(),
  z.object({ type: z.literal('cancel'), id: z.uuid() }).strict(),
]);
export const browserMetadata = z
  .object({
    status: z.string().max(256),
    currentSession: z
      .object({ taskId: task, lastActivityAt: z.iso.datetime() })
      .strict()
      .nullable(),
    screen: z
      .object({
        taskId: task,
        state: z.enum(['live', 'last_known', 'unavailable']),
        capturedAt: z.iso.datetime().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BrowserMetadata = z.infer<typeof browserMetadata>;
export const browserResponse = z.discriminatedUnion('ok', [
  z
    .object({ id: z.uuid(), ok: z.literal(true), result: z.unknown(), metadata: browserMetadata })
    .strict(),
  z
    .object({
      id: z.uuid(),
      ok: z.literal(false),
      error: z.enum(['cancelled', 'locked', 'navigation', 'unavailable']),
      metadata: browserMetadata,
    })
    .strict(),
]);
export type BrowserResponse = z.infer<typeof browserResponse>;
