import type { Pool, PoolClient } from 'pg';

export function currentConversationSql(alias: 't' | 'tasks' | 'target' | 'current' = 't') {
  return `${alias}.conversation_revision=COALESCE((SELECT c.revision FROM conversations c WHERE c.owner_id=${alias}.owner_id AND c.channel=${alias}.channel),0)`;
}

export async function conversationRevision(
  database: Pool | PoolClient,
  ownerId: string,
  channel = 'web',
) {
  const result = await database.query(
    'SELECT revision FROM conversations WHERE owner_id=$1 AND channel=$2',
    [ownerId, channel],
  );
  return (result.rows[0]?.revision ?? 0) as number;
}

export async function lockConversation(client: PoolClient, ownerId: string, channel = 'web') {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `message:${ownerId}:${channel}`,
  ]);
  return conversationRevision(client, ownerId, channel);
}
