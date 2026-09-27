import type { ComputerCheckpoint } from './computer-checkpoints.ts';
import type { DeploymentInput } from '../../../src/ports/deployment.ts';
import { cleanStoppedComputer, drainComputerForDeployment } from './computer-deployment.ts';
import { environmentName, generation, ownerIdentity, RuntimeControlError } from './protocol.ts';

export type ComputerIdentity = {
  ownerId: string;
  environment: string;
  generation: string;
  role: 'browser' | 'workspace';
};

export type ComputerState = ComputerIdentity & {
  phase: 'restoring' | 'ready' | 'dirty' | 'uncertain';
  stopped: boolean;
  commands?: string[];
  checkpoint?: ComputerCheckpoint;
  previousCheckpoint?: ComputerCheckpoint;
};

export function createComputerLifecycle(options: {
  role: ComputerIdentity['role'];
  environment: string;
  read(): Promise<ComputerState | undefined>;
  write(state: ComputerState): Promise<void>;
  claimCommand(identity: ComputerIdentity, id: string): Promise<boolean>;
  authorize(identity: ComputerIdentity, stopping: boolean): Promise<void>;
  running(): boolean;
  start(): Promise<void>;
  destroy(): Promise<void>;
  restore(state: ComputerState, assertCurrent: () => Promise<void>): Promise<void>;
  checkpoint(state: ComputerState, assertCurrent: () => Promise<void>): Promise<ComputerCheckpoint>;
  removeCheckpoint(
    checkpoint: ComputerCheckpoint,
    assertCurrent: () => Promise<void>,
  ): Promise<void>;
  quiesce(state: ComputerState, stopping: boolean): Promise<boolean>;
  launch(state: ComputerState, taskId?: string): Promise<ExecProcess>;
}) {
  const environment = environmentName(options.environment);
  const active = new Set<string>();
  let pending: Promise<unknown> = Promise.resolve();
  let loaded: ComputerState | undefined;
  let booted = false;
  let closing = false;
  let fenced = false;
  let draining = false;

  const unavailable = () => new RuntimeControlError(503);
  function exclusive<T>(operation: () => Promise<T>) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }
  function identity(owner: string, version: string): ComputerIdentity {
    return {
      ownerId: ownerIdentity(owner),
      environment,
      generation: generation(version),
      role: options.role,
    };
  }
  function matches(state: ComputerState, expected: ComputerIdentity) {
    return (
      state.ownerId === expected.ownerId &&
      state.environment === expected.environment &&
      state.role === expected.role &&
      state.generation === expected.generation
    );
  }
  async function write(state: ComputerState) {
    await options.write(state);
    loaded = state;
  }
  async function destroy() {
    await options.destroy();
    if (options.running()) throw unavailable();
    booted = false;
    active.clear();
  }
  async function assertCurrent(state: ComputerState, stopping = false) {
    if (fenced || (!stopping && closing)) throw unavailable();
    await options.authorize(state, stopping);
    if (fenced || (!stopping && closing)) throw unavailable();
  }
  async function uncertain() {
    fenced = true;
    const state = await options.read();
    if (loaded && (!state || !matches(state, loaded))) throw unavailable();
    try {
      if (state) await write({ ...state, phase: 'uncertain' });
    } finally {
      await destroy();
    }
  }
  async function checkpoint(
    state: ComputerState,
    stopping = false,
    authorize?: () => Promise<void>,
  ) {
    const assert = async () => {
      if (fenced) throw unavailable();
      if (authorize) await authorize();
      else await assertCurrent(state, stopping);
      if (fenced) throw unavailable();
    };
    await assert();
    const next = await options.checkpoint(state, assert);
    await assert();
    if (!loaded || !matches(loaded, state) || loaded.phase === 'uncertain') throw unavailable();
    const previous = state.previousCheckpoint;
    await write({
      ...loaded,
      phase: 'ready',
      checkpoint: next,
      previousCheckpoint: state.checkpoint,
    });
    await assert();
    if (previous) await options.removeCheckpoint(previous, assert).catch(() => {});
    await assert();
    return loaded!;
  }
  async function prepare(expected: ComputerIdentity) {
    await options.authorize(expected, false);
    if (fenced) throw unavailable();
    const previous = await options.read();
    if (
      previous &&
      (previous.ownerId !== expected.ownerId ||
        previous.environment !== expected.environment ||
        previous.role !== expected.role ||
        previous.phase === 'uncertain' ||
        (previous.generation !== expected.generation &&
          (!previous.stopped || BigInt(previous.generation) >= BigInt(expected.generation))) ||
        (previous.generation === expected.generation && previous.stopped))
    )
      throw unavailable();
    if (closing && (!previous?.stopped || previous.generation === expected.generation))
      throw unavailable();
    closing = false;
    if (previous?.phase === 'dirty' && (!booted || !options.running())) {
      loaded = previous;
      await uncertain();
      throw unavailable();
    }
    if (previous && matches(previous, expected) && booted && options.running()) return previous;
    loaded = previous;
    await destroy();
    const next: ComputerState = {
      ...expected,
      phase: 'restoring',
      stopped: false,
      ...(previous?.generation === expected.generation &&
        previous.commands && {
          commands: previous.commands,
        }),
      checkpoint: previous?.checkpoint,
      previousCheckpoint: previous?.previousCheckpoint,
    };
    await write(next);
    try {
      await assertCurrent(next);
      await options.start();
      await assertCurrent(next);
      await options.restore(next, () => assertCurrent(next));
      await assertCurrent(next);
      await write({ ...next, phase: 'ready' });
      await assertCurrent(next);
      booted = true;
      return loaded!;
    } catch {
      await destroy().catch(() => {});
      throw unavailable();
    }
  }

  return {
    async authorize(owner: string, version: string) {
      const expected = identity(owner, version);
      if (fenced || closing || draining) throw unavailable();
      await options.authorize(expected, false);
      if (loaded && (!matches(loaded, expected) || loaded.stopped || loaded.phase === 'uncertain'))
        throw unavailable();
      if (fenced || closing || draining) throw unavailable();
    },
    launch(owner: string, input: { id: string; generation: string; taskId?: string }) {
      return exclusive(async () => {
        if (draining) throw unavailable();
        const expected = identity(owner, input.generation);
        const id = ownerIdentity(input.id);
        const state = await prepare(expected);
        if (state.commands?.includes(id) || (options.role === 'workspace' && active.size))
          throw new RuntimeControlError(409);
        for (const previous of state.commands ?? [])
          await options.claimCommand(expected, ownerIdentity(previous));
        if (!(await options.claimCommand(expected, id))) throw new RuntimeControlError(409);
        await assertCurrent(state);
        const { commands: _commands, ...next } = state;
        await write({ ...next, phase: 'dirty' });
        active.add(id);
        try {
          await assertCurrent(loaded!);
          const process = await options.launch(loaded!, input.taskId);
          await assertCurrent(loaded!);
          return process;
        } catch {
          await uncertain();
          throw unavailable();
        }
      });
    },
    completed(owner: string, input: { id: string; generation: string; code: number }) {
      return exclusive(async () => {
        const expected = identity(owner, input.generation);
        if (!loaded || !matches(loaded, expected) || !active.has(input.id)) throw unavailable();
        try {
          if (input.code !== 0) throw unavailable();
          await assertCurrent(loaded);
          if (!options.running()) throw unavailable();
          if (options.role === 'workspace') await checkpoint(loaded);
          active.delete(input.id);
        } catch {
          await uncertain();
          throw unavailable();
        }
      });
    },
    uncertain(owner: string, version: string) {
      const expected = identity(owner, version);
      if (loaded && (!matches(loaded, expected) || loaded.stopped))
        return Promise.reject(unavailable());
      if (loaded) fenced = true;
      return exclusive(async () => {
        const state = await options.read();
        if (state && (!matches(state, expected) || state.stopped)) throw unavailable();
        loaded = state;
        await uncertain();
      });
    },
    idle() {
      return exclusive(async () => {
        if (!loaded) {
          const state = await options.read();
          if (state && !matches(state, identity(state.ownerId, state.generation)))
            throw unavailable();
          loaded = state;
        }
        if (!loaded || closing || fenced || active.size) return false;
        try {
          if (!booted && (loaded.phase === 'dirty' || loaded.phase === 'uncertain')) {
            await uncertain();
            return true;
          }
          if (loaded.stopped) {
            await destroy();
            return true;
          }
          await assertCurrent(loaded);
          if (loaded.phase === 'dirty') {
            if (options.role !== 'browser' || !(await options.quiesce(loaded, false))) return false;
            await checkpoint(loaded);
          }
          await destroy();
          return true;
        } catch {
          await uncertain();
          throw unavailable();
        }
      });
    },
    drain(
      owner: string,
      version: string,
      input: DeploymentInput,
      controls: {
        authorize(): Promise<void>;
        active(): number;
      },
    ) {
      return exclusive(async () => {
        const expected = identity(owner, version);
        const state = await options.read();
        return drainComputerForDeployment({
          identity: expected,
          ...input,
          state,
          active: active.size + controls.active(),
          observed: booted,
          fenced,
          running: options.running,
          authorize: controls.authorize,
          admission(closed) {
            draining = closed;
            if (closed) loaded = state;
          },
          quiesce: (current) => options.quiesce(current, false),
          checkpoint: (current) => checkpoint(current, false, controls.authorize),
          stop: destroy,
          write,
          quarantine: async (current) => {
            fenced = true;
            await write({ ...current, phase: 'uncertain' });
          },
        });
      });
    },
    inspectStopped(
      owner: string,
      version: string | null,
      controls: {
        authorize(): Promise<void>;
        active(): number;
        physicallyStopped(): Promise<boolean>;
      },
    ) {
      return exclusive(async () => {
        const ownerId = ownerIdentity(owner);
        const expected = version === null ? null : generation(version);
        await controls.authorize();
        if (!(await controls.physicallyStopped())) return false;
        const state = await options.read();
        await controls.authorize();
        if (!(await controls.physicallyStopped())) return false;
        return cleanStoppedComputer({
          state,
          ownerId,
          generation: expected,
          environment,
          role: options.role,
          active: active.size + controls.active(),
          fenced,
          running: options.running(),
        });
      });
    },
    stop(owner: string, version: string) {
      return exclusive(async () => {
        const expected = identity(owner, version);
        await options.authorize(expected, true);
        const state = await options.read();
        if (state && !matches(state, expected)) {
          if (
            state.ownerId === expected.ownerId &&
            state.environment === expected.environment &&
            state.role === expected.role &&
            BigInt(generation(state.generation)) < BigInt(expected.generation) &&
            state.phase === 'ready' &&
            state.stopped &&
            !fenced &&
            !active.size &&
            !options.running()
          )
            return;
          throw new RuntimeControlError(409);
        }
        closing = true;
        loaded = state;
        if (!state) {
          await destroy();
          return;
        }
        if (active.size || state.phase === 'uncertain' || (state.phase === 'dirty' && !booted)) {
          await uncertain();
        } else {
          try {
            if (state.phase === 'dirty') {
              if (options.role !== 'browser' || !(await options.quiesce(state, true)))
                throw unavailable();
              await checkpoint(state, true);
            }
            await destroy();
          } catch {
            await uncertain();
          }
        }
        await write({ ...loaded!, stopped: true });
      });
    },
    get active() {
      return active.size;
    },
  };
}
