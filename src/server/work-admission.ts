const unavailable = () =>
  Object.assign(new Error('Work admission is paused.'), { statusCode: 503 });

export function createWorkAdmission() {
  let paused = false;
  let closed = false;
  let pending = 0;
  const listeners = new Set<() => void>();

  function enter() {
    if (paused || closed) return undefined;
    pending++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pending--;
      if (!pending) for (const listener of listeners) listener();
    };
  }
  function pause() {
    paused = true;
  }
  function run<T>(operation: () => Promise<T>): Promise<T> | undefined {
    const release = enter();
    if (!release) return undefined;
    return Promise.resolve().then(operation).finally(release);
  }
  function drain(deadline: number) {
    if ((!paused && !closed) || !Number.isSafeInteger(deadline) || deadline <= Date.now())
      return Promise.reject(unavailable());
    if (!pending) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        listeners.delete(finish);
        if ((!paused && !closed) || Date.now() >= deadline) reject(unavailable());
        else resolve();
      };
      const timer = setTimeout(
        () => {
          listeners.delete(finish);
          reject(unavailable());
        },
        Math.min(deadline - Date.now(), 2_147_483_647),
      );
      listeners.add(finish);
    });
  }
  return {
    enter,
    run,
    pause,
    drain,
    resume() {
      if (closed) throw unavailable();
      paused = false;
      for (const listener of listeners) listener();
    },
    close() {
      closed = true;
      pause();
    },
    get paused() {
      return paused;
    },
    get closed() {
      return closed;
    },
    get pending() {
      return pending;
    },
  };
}

export type WorkAdmission = ReturnType<typeof createWorkAdmission>;

export function createWorkConsumers() {
  type Instance = { ready: Promise<string>; stopping?: Promise<void>; failed?: boolean };
  type Consumer = {
    start(): Promise<string>;
    stop(id: string): Promise<void>;
    instances: Set<Instance>;
  };
  const consumers = new Set<Consumer>();
  let paused = false;
  let closed = false;

  function start(consumer: Consumer) {
    if (paused || closed) return Promise.resolve();
    if ([...consumer.instances].some((instance) => instance.failed))
      return Promise.reject(unavailable());
    const existing = [...consumer.instances].find((instance) => !instance.stopping);
    if (existing) return existing.ready.then(() => {});
    const instance: Instance = { ready: Promise.resolve().then(() => consumer.start()) };
    consumer.instances.add(instance);
    return instance.ready.then(() => {});
  }
  function stop(consumer: Consumer, instance: Instance) {
    instance.stopping ??= instance.ready
      .then((id) => consumer.stop(id))
      .then(() => {
        consumer.instances.delete(instance);
      })
      .catch((error) => {
        instance.failed = true;
        throw error;
      });
    return instance.stopping;
  }
  function pause() {
    paused = true;
    return Promise.all(
      [...consumers].flatMap((consumer) =>
        [...consumer.instances].map((instance) => stop(consumer, instance)),
      ),
    ).then(() => {});
  }
  return {
    async register(input: { start(): Promise<string>; stop(id: string): Promise<void> }) {
      if (closed) throw unavailable();
      const consumer: Consumer = { ...input, instances: new Set() };
      consumers.add(consumer);
      await start(consumer);
    },
    pause,
    async resume() {
      if (closed) throw unavailable();
      paused = false;
      await Promise.all([...consumers].map(start));
    },
    close() {
      closed = true;
      return pause();
    },
  };
}

export type WorkConsumers = ReturnType<typeof createWorkConsumers>;
