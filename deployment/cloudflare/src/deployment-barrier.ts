import { z } from 'zod';
import type {
  DeploymentInput,
  DeploymentReceipt,
  DeploymentRequest,
} from '../../../src/ports/deployment.ts';
import {
  DeploymentControlError,
  deploymentMaximumDuration,
  deploymentRequestSchema,
} from '../../../src/server/deployment-auth.ts';

const receiptSchema = z
  .object({ ownerId: z.uuid(), generation: z.string().regex(/^[1-9]\d{0,19}$/) })
  .strict();
const stateSchema = deploymentRequestSchema.omit({ action: true }).extend({
  phase: z.enum([
    'draining',
    'prepared',
    'activating',
    'aborting',
    'failed',
    'complete',
    'aborted',
  ]),
  receipts: z.array(receiptSchema).max(1024),
});

export type DeploymentState = z.infer<typeof stateSchema>;

export function createDeploymentBarrier(options: {
  read(): Promise<unknown>;
  write(state: DeploymentState): Promise<void>;
  currentRelease: string;
  requireInitialization?: boolean;
  prepare(input: DeploymentInput, request: Request): Promise<DeploymentReceipt[]>;
  abort(input: DeploymentInput, request: Request): Promise<void>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let serial: Promise<unknown> = Promise.resolve();
  let preparing:
    { nonce: string; result: Promise<{ ok: true; state: DeploymentState }> } | undefined;
  let working = false;

  function exclusive<T>(operation: () => Promise<T>) {
    const result = serial.then(operation);
    serial = result.catch(() => {});
    return result;
  }
  async function read() {
    const value = await options.read();
    if (value === undefined || value === null) return null;
    const parsed = stateSchema.safeParse(value);
    if (!parsed.success) throw new DeploymentControlError();
    return parsed.data;
  }
  function matches(state: DeploymentState | null, input: DeploymentRequest) {
    return (
      state?.nonce === input.nonce &&
      state.targetRelease === input.targetRelease &&
      state.previousRelease === input.previousRelease &&
      state.deadline === input.deadline
    );
  }
  function timely(input: DeploymentInput) {
    const remaining = input.deadline - now();
    if (remaining <= 0 || remaining > deploymentMaximumDuration)
      throw new DeploymentControlError(409);
  }
  async function failed(input: DeploymentRequest, phase: DeploymentState['phase']) {
    await exclusive(async () => {
      const state = await read();
      if (matches(state, input) && state!.phase === phase)
        await options.write({ ...state!, phase: 'failed' });
    });
  }
  async function prepare(input: DeploymentRequest, request: Request) {
    const state = await exclusive(async () => {
      const state = await read();
      if (matches(state, input)) {
        if (state!.phase === 'prepared' || state!.phase === 'activating') return state!;
        if (!['draining', 'failed'].includes(state!.phase)) throw new DeploymentControlError(409);
      } else if (state && !['complete', 'aborted'].includes(state.phase)) {
        throw new DeploymentControlError(409);
      }
      timely(input);
      if (options.currentRelease !== input.previousRelease) throw new DeploymentControlError(409);
      const next: DeploymentState = {
        nonce: input.nonce,
        previousRelease: input.previousRelease,
        targetRelease: input.targetRelease,
        deadline: input.deadline,
        phase: 'draining',
        receipts: matches(state, input) ? state!.receipts : [],
      };
      await options.write(next);
      return next;
    });
    if (state.phase !== 'draining') return { ok: true as const, state };
    if (preparing) {
      if (preparing.nonce !== input.nonce) throw new DeploymentControlError(409);
      return preparing.result;
    }
    working = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = Promise.resolve()
      .then(() => options.prepare(input, request))
      .finally(() => {
        working = false;
      });
    const result = (async () => {
      try {
        const receipts = z
          .array(receiptSchema)
          .max(1024)
          .parse(
            await Promise.race([
              operation,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new DeploymentControlError()),
                  Math.max(1, input.deadline - now()),
                );
              }),
            ]),
          );
        if (new Set(receipts.map((receipt) => receipt.ownerId)).size !== receipts.length)
          throw new DeploymentControlError();
        return await exclusive(async () => {
          const latest = await read();
          timely(input);
          if (!matches(latest, input) || latest!.phase !== 'draining')
            throw new DeploymentControlError(409);
          const prepared: DeploymentState = { ...latest!, phase: 'prepared', receipts };
          await options.write(prepared);
          return { ok: true as const, state: prepared };
        });
      } catch {
        await failed(input, 'draining');
        throw new DeploymentControlError();
      } finally {
        clearTimeout(timer);
      }
    })();
    preparing = { nonce: input.nonce, result };
    void Promise.allSettled([operation, result])
      .then(() => {
        if (preparing?.result === result) preparing = undefined;
      })
      .catch(() => {});
    return result;
  }

  return {
    async closed() {
      const state = await read();
      if (!state) return options.requireInitialization ?? false;
      return !!state && !['complete', 'aborted'].includes(state.phase);
    },
    async handle(raw: DeploymentRequest, request: Request) {
      const parsed = deploymentRequestSchema.safeParse(raw);
      if (!parsed.success) throw new DeploymentControlError(400);
      const input = parsed.data;
      if (input.action === 'status') return { ok: true as const, state: await read() };
      if (input.action === 'prepare') return prepare(input, request);
      if (input.action === 'abort') {
        const state = await exclusive(async () => {
          const state = await read();
          if (!matches(state, input)) throw new DeploymentControlError(409);
          if (state!.phase === 'aborted') return state!;
          if (
            working ||
            options.currentRelease !== input.previousRelease ||
            !['draining', 'prepared', 'failed', 'aborting'].includes(state!.phase)
          )
            throw new DeploymentControlError(409);
          const next: DeploymentState = { ...state!, phase: 'aborting' };
          await options.write(next);
          return next;
        });
        if (state.phase === 'aborted') return { ok: true as const, state };
        try {
          await options.abort(input, request);
          return await exclusive(async () => {
            const state = await read();
            if (!matches(state, input) || !['aborting', 'aborted'].includes(state!.phase))
              throw new DeploymentControlError(409);
            const next: DeploymentState = { ...state!, phase: 'aborted' };
            await options.write(next);
            return { ok: true as const, state: next };
          });
        } catch {
          await failed(input, 'aborting');
          throw new DeploymentControlError();
        }
      }
      return exclusive(async () => {
        const state = await read();
        if (!matches(state, input)) throw new DeploymentControlError(409);
        if (input.action === 'activate') {
          if (state!.phase === 'activating') return { ok: true as const, state: state! };
          timely(input);
          if (state!.phase !== 'prepared' || options.currentRelease !== input.previousRelease)
            throw new DeploymentControlError(409);
          const next: DeploymentState = { ...state!, phase: 'activating' };
          await options.write(next);
          return { ok: true as const, state: next };
        }
        if (
          options.currentRelease !== input.targetRelease ||
          !['activating', 'complete'].includes(state!.phase)
        )
          throw new DeploymentControlError(409);
        const next: DeploymentState = { ...state!, phase: 'complete' };
        await options.write(next);
        return { ok: true as const, state: next };
      });
    },
  };
}
