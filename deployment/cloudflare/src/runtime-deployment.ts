import { z } from 'zod';
import type { DeploymentInput } from '../../../src/ports/deployment.ts';
import { deploymentBodyLimit, deploymentInputSchema } from '../../../src/server/deployment-auth.ts';
import { boundedBody, generation, RuntimeControlError } from './protocol.ts';

const proofSchema = deploymentInputSchema.extend({
  generation: z.string().regex(/^[1-9]\d{0,18}$/),
  computerPaused: z.literal(true).optional(),
});

export type RuntimeDeploymentProof = z.infer<typeof proofSchema>;

export function deploymentProof(value: unknown, input: DeploymentInput, version: string) {
  const parsed = proofSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.nonce === input.nonce &&
    parsed.data.targetRelease === input.targetRelease &&
    parsed.data.deadline === input.deadline &&
    parsed.data.generation === generation(version)
  );
}

export async function runtimeDeploymentBody(request: Request) {
  const bytes = await boundedBody(request, deploymentBodyLimit);
  try {
    const input = deploymentInputSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)),
    );
    return { bytes, input };
  } catch {
    throw new RuntimeControlError(400);
  }
}

export async function runtimeDeploymentAcknowledgement(
  response: Response,
  input: DeploymentInput,
  version: string,
  action: 'drain' | 'resume',
  requireComputerPaused = false,
) {
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new RuntimeControlError(503);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > deploymentBodyLimit) throw new Error();
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    if (action === 'drain') {
      z.object({
        ok: z.literal(true),
        nonce: z.literal(input.nonce),
        targetRelease: z.literal(input.targetRelease),
        generation: z.literal(generation(version)),
        drained: z.literal(true),
        computerPaused: requireComputerPaused ? z.literal(true) : z.literal(true).optional(),
      })
        .strict()
        .parse(value);
    } else
      z.object({ ok: z.literal(true) })
        .strict()
        .parse(value);
    return new Response(bytes, { status: response.status, headers: response.headers });
  } catch {
    throw new RuntimeControlError(503);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
