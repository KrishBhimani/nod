export function createComputerShutdownConfirmation(options: {
  endpoint: string;
  generation: string;
  fetch?: typeof fetch;
}) {
  if (
    options.endpoint !== 'http://sidekick.computer/v1/stopped' ||
    !/^[1-9]\d{0,19}$/.test(options.generation)
  )
    throw new Error('The computer shutdown configuration is invalid.');
  const generation = options.generation;
  const request = options.fetch ?? fetch;
  return async () => {
    try {
      const response = await request('http://sidekick.computer/v1/stopped', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sidekick-generation': generation,
        },
        body: '{}',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error();
      }
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== 'object' ||
        Object.keys(result).length !== 1 ||
        !('ok' in result) ||
        result.ok !== true
      )
        throw new Error();
    } catch {
      throw new Error('The computer shutdown could not be confirmed.');
    }
  };
}
