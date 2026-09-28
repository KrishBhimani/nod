import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Service } from './oauth.ts';
import { loadDirectPlugin } from './plugin.ts';

export async function withDirectMcp<T>(
  service: Service,
  accessToken: string,
  request: typeof fetch,
  operation: (client: Client) => Promise<T>,
) {
  const client = new Client({ name: 'Otto', version: '0.1.0' });
  const endpoint = await loadDirectPlugin(service);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    fetch: request,
  });
  try {
    await client.connect(transport);
    return await operation(client);
  } finally {
    await client.close().catch(() => {});
  }
}
