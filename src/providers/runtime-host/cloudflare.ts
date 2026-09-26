import { z } from 'zod';
import type { RuntimeTransport } from '../../ports/runtime-transport.ts';

export function createCloudflareRuntimeTransport(
  options: { fetch?: typeof fetch } = {},
): RuntimeTransport {
  const request = options.fetch ?? fetch;
  async function control(path: string, body: unknown) {
    try {
      const response = await request(`http://sidekick.runtime/runtime/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(path === 'start' ? 45_000 : 15_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      return (await response.json()) as unknown;
    } catch {
      throw new Error('The account computer service is unavailable.');
    }
  }
  return {
    async status(ownerId) {
      return z
        .object({
          generation: z
            .string()
            .regex(/^[1-9]\d*$/)
            .nullable(),
          stopped: z.boolean(),
        })
        .parse(await control('status', { ownerId }));
    },
    async start({ ownerId, generation, environment }) {
      const result = z
        .object({ ok: z.literal(true), generation: z.literal(generation) })
        .parse(await control('start', { ownerId, env: environment }));
      if (!result.ok) throw new Error('The account computer service is unavailable.');
    },
    async stop(ownerId, generation) {
      const deadline = Date.now() + 20_000;
      while (true) {
        try {
          z.object({ stopped: z.literal(true) }).parse(
            await control('stop', { ownerId, generation }),
          );
          return;
        } catch {
          if (Date.now() >= deadline) throw new Error('The account runtime could not be stopped.');
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    },
    fetch(ownerId, input) {
      z.uuid().parse(ownerId);
      const url = new URL(input.url);
      return request(
        new Request(`http://sidekick.runtime/${ownerId}${url.pathname}${url.search}`, input),
        { redirect: 'manual' },
      );
    },
    async close() {},
  };
}
