import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const pluginSchema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const mcpSchema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const roots = {
  notion: 'https://mcp.notion.com/mcp',
  linear: 'https://mcp.linear.app/mcp/readonly',
} as const;
type Service = keyof typeof roots;

const manifest = z
  .object({
    $schema: z.literal(pluginSchema),
    name: z
      .string()
      .regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
      .max(64),
  })
  .passthrough();
const remote = z.object({ type: z.literal('streamable-http'), url: z.url() }).strict();
const config = z
  .object({
    $schema: z.literal(mcpSchema),
    mcpServers: z.record(z.string(), remote),
  })
  .strict();

export async function loadDirectPlugin(service: Service) {
  const root = await realpath(
    fileURLToPath(new URL(`../../../plugins/${service}/`, import.meta.url)),
  );
  async function read(name: string) {
    const path = await realpath(join(root, name));
    if (!path.startsWith(`${root}${sep}`) || dirname(path) !== root)
      throw new Error('The connection package is outside its directory.');
    return JSON.parse(await readFile(path, 'utf8'));
  }
  const selected = manifest.parse(await read('plugin.json'));
  if (selected.name !== `otto-${service}`) throw new Error('The connection package name changed.');
  const servers = config.parse(await read('mcp.json')).mcpServers;
  const entry = servers[service];
  if (Object.keys(servers).length !== 1 || entry?.url !== roots[service])
    throw new Error('The connection endpoint changed.');
  return new URL(entry.url);
}
