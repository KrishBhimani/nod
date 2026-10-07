import type { Composio } from '@composio/core';
import { z } from 'zod';
import type { SentEmail } from '../../ports/integrations.ts';
import { mailbox, messageSchema, messageText } from './verification-email.ts';

export async function readSentEmails(
  client: Pick<Composio['tools'], 'proxyExecute'>,
  accountId: string,
  signal: AbortSignal,
): Promise<SentEmail[]> {
  const get = async (path: string, parameters: Array<[string, string | number]>) => {
    signal.throwIfAborted();
    const response = await client.proxyExecute(
      {
        connectedAccountId: accountId,
        endpoint: `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
        method: 'GET',
        parameters: parameters.map(([name, value]) => ({ in: 'query', name, value })),
      },
      { signal },
    );
    signal.throwIfAborted();
    if (response.status !== 200 || JSON.stringify(response.data).length > 1_000_000)
      throw new Error('Gmail did not return sent mail.');
    return response.data;
  };
  const list = z
    .object({
      messages: z
        .array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/) }))
        .max(30)
        .default([]),
    })
    .parse(
      await get('messages', [
        ['q', 'in:sent'],
        ['maxResults', 30],
        ['fields', 'messages/id'],
      ]),
    );
  const emails: SentEmail[] = [];
  for (const { id } of list.messages) {
    const message = messageSchema.safeParse(await get(`messages/${id}`, [['format', 'full']]));
    if (!message.success || message.data.labelIds?.includes('DRAFT')) continue;
    const headers = (name: string) =>
      message.data.payload.headers
        .filter((header) => header.name.toLowerCase() === name)
        .map((header) => header.value);
    const text = messageText(message.data.payload);
    if (!text) continue;
    emails.push({
      from: mailbox(headers('from')[0] ?? '') ?? '',
      to: [...headers('to'), ...headers('cc')]
        .flatMap((value) => value.split(','))
        .flatMap((value) => mailbox(value) ?? []),
      automated:
        headers('auto-submitted').some((value) => !/^\s*no\b/i.test(value)) ||
        headers('precedence').some((value) => /bulk|list|junk/i.test(value)) ||
        headers('list-unsubscribe').length > 0,
      text,
    });
  }
  return emails;
}
