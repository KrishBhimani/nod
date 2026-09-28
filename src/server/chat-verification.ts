import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { SubmitMessageResponse, VerificationRequest } from '../shared/contracts.ts';
import { currentConversationSql, lockConversation } from './conversations.ts';

interface VerificationInput {
  clientMessageId: string;
  channel?: string;
  conversationRevision?: number;
  taskId?: string;
  replyToMessageId?: string;
  verificationRequestId?: string;
  forceNew?: boolean;
  attachmentIds?: string[];
  persistOrdinary?: (client: PoolClient) => Promise<void>;
}

type VerificationStatus = 'submitted' | 'rejected' | 'invalid' | 'unavailable';
const maskedMessage = 'Verification code sent securely.';
const pendingMessage = 'Verification code received securely.';
const unavailableMessage =
  'This verification request is no longer available. Continue the sign-in task to request a new code.';

function conflict(message: string) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

export async function createChatVerification(
  pool: Pool,
  options: {
    ownerId: string;
    keyStore: Pick<CredentialKeyStore, 'getKey'>;
    submitCode: (
      ownerId: string,
      taskId: string,
      code: string,
      requestId: string,
    ) => Promise<{ status: VerificationStatus }>;
    refresh: () => void;
  },
) {
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_verification_submissions (
    message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    request_id text NOT NULL, status text NOT NULL DEFAULT 'pending'
  );
  ALTER TABLE chat_verification_submissions ADD COLUMN IF NOT EXISTS code_fingerprint text`);
  let fingerprintKey: Promise<Buffer> | undefined;
  async function fingerprint(code: string, input: VerificationInput) {
    fingerprintKey ??= options.keyStore
      .getKey()
      .then((key) => {
        if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error();
        return createHmac('sha256', key).update('otto:chat-verification:fingerprint:v1').digest();
      })
      .catch(() => {
        fingerprintKey = undefined;
        throw Object.assign(new Error('Verification is temporarily unavailable. Try again.'), {
          statusCode: 503,
        });
      });
    return createHmac('sha256', await fingerprintKey)
      .update(
        JSON.stringify([options.ownerId, input.channel ?? 'web', input.clientMessageId, code]),
      )
      .digest('hex');
  }

  async function pending(channel = 'web'): Promise<VerificationRequest[]> {
    const result = await pool.query<VerificationRequest>(
      `SELECT r.id,t.id AS "taskId",r.expires_at AS "expiresAt"
       FROM credential_requests r JOIN tasks t ON t.id::text=r.task_id
       WHERE r.owner_id=$1 AND t.owner_id=$1 AND t.channel=$2
         AND r.kind='otp' AND r.status='pending' AND r.expires_at>now()
         AND t.status IN ('running','waiting_credentials') AND t.revision=r.task_revision
         AND ${currentConversationSql()} ORDER BY r.expires_at,r.id LIMIT 50`,
      [options.ownerId, channel],
    );
    return result.rows;
  }

  async function accept(
    text: string,
    input: VerificationInput,
  ): Promise<SubmitMessageResponse | undefined> {
    const code = text.trim();
    const exactCode = /^\d{4,8}$/.test(code);
    if (!exactCode && !input.verificationRequestId) return;
    if (!exactCode) throw conflict('Enter the verification code using 4 to 8 digits.');
    const incompatible = Boolean(input.attachmentIds?.length || input.forceNew);
    if (incompatible && input.verificationRequestId)
      throw conflict('Send the verification code by itself in the sign-in conversation.');
    const channel = input.channel ?? 'web';
    const client = await pool.connect();
    let reserved: { taskId: string; requestId: string; revision: number } | undefined;
    try {
      await client.query('BEGIN');
      const revision = await lockConversation(client, options.ownerId, channel);
      if (input.conversationRevision !== undefined && input.conversationRevision !== revision)
        throw conflict('This conversation has been reset. Reload it before continuing.');
      await client.query(
        `SELECT t.id FROM tasks t WHERE t.owner_id=$1 AND t.channel=$2
         AND t.status IN ('queued','running','waiting_credentials','waiting_user') AND ${currentConversationSql()}
         ORDER BY t.id FOR NO KEY UPDATE`,
        [options.ownerId, channel],
      );
      const previous = (
        await client.query(
          `SELECT m.owner_id,m.task_id,m.reply_to_message_id,t.owner_id AS task_owner_id,
           t.channel,t.conversation_revision,v.request_id,v.status,v.code_fingerprint
           FROM messages m LEFT JOIN tasks t ON t.id=m.task_id
           LEFT JOIN chat_verification_submissions v ON v.message_id=m.id WHERE m.id=$1`,
          [input.clientMessageId],
        )
      ).rows[0];
      if (previous) {
        if (!previous.request_id) {
          await input.persistOrdinary?.(client);
          await client.query('COMMIT');
          return;
        }
        const codeFingerprint = await fingerprint(code, input);
        if (
          previous.owner_id !== options.ownerId ||
          previous.task_owner_id !== options.ownerId ||
          previous.channel !== channel ||
          previous.conversation_revision !== revision ||
          previous.reply_to_message_id !== (input.replyToMessageId ?? null) ||
          (input.taskId && previous.task_id !== input.taskId) ||
          (input.verificationRequestId && previous.request_id !== input.verificationRequestId) ||
          incompatible ||
          typeof previous.code_fingerprint !== 'string' ||
          previous.code_fingerprint.length !== codeFingerprint.length ||
          !timingSafeEqual(Buffer.from(previous.code_fingerprint), Buffer.from(codeFingerprint))
        )
          throw conflict('This message ID is already in use. Send this as a new message.');
        await client.query('COMMIT');
        return {
          taskId: previous.task_id,
          continued: true,
          messageId: input.clientMessageId,
          messageText: previous.status === 'pending' ? pendingMessage : maskedMessage,
          verificationStatus: previous.status,
        };
      }
      let taskId = input.taskId;
      if (input.replyToMessageId) {
        const target = (
          await client.query(
            `SELECT t.id FROM messages m JOIN tasks t ON t.id=m.task_id
             WHERE m.id=$1 AND m.owner_id=$2 AND t.owner_id=$2 AND t.channel=$3
               AND ${currentConversationSql()}`,
            [input.replyToMessageId, options.ownerId, channel],
          )
        ).rows[0];
        if (!target || (taskId && taskId !== target.id))
          throw conflict('The reply is unavailable in this conversation.');
        taskId = target.id;
      }
      const requests = await client.query<{ id: string; task_id: string; revision: number }>(
        `SELECT r.id,t.id AS task_id,t.revision FROM credential_requests r JOIN tasks t ON t.id::text=r.task_id
         WHERE r.owner_id=$1 AND t.owner_id=$1 AND t.channel=$2
           AND r.kind='otp' AND r.status='pending' AND r.expires_at>now()
           AND t.status='waiting_credentials' AND t.revision=r.task_revision
           AND ($3::uuid IS NULL OR t.id=$3) AND ($4::text IS NULL OR r.id=$4)
           AND ${currentConversationSql()} ORDER BY r.expires_at,r.id LIMIT 2 FOR UPDATE OF t`,
        [options.ownerId, channel, taskId ?? null, input.verificationRequestId ?? null],
      );
      if (!requests.rowCount) {
        if (input.verificationRequestId) throw conflict(unavailableMessage);
        const waiting = await client.query(
          `SELECT r.expires_at<=now() AS expired FROM credential_requests r JOIN tasks t ON t.id::text=r.task_id
           WHERE r.owner_id=$1 AND t.owner_id=$1 AND t.channel=$2 AND r.kind='otp' AND r.status='pending'
             AND t.status IN ('running','waiting_credentials') AND t.revision=r.task_revision
             AND ($3::uuid IS NULL OR t.id=$3) AND ${currentConversationSql()} LIMIT 1`,
          [options.ownerId, channel, taskId ?? null],
        );
        if (waiting.rows[0])
          throw conflict(
            waiting.rows[0].expired
              ? unavailableMessage
              : 'The sign-in step is getting ready. Send the code again in a moment.',
          );
        await input.persistOrdinary?.(client);
        await client.query('COMMIT');
        return;
      }
      if (incompatible)
        throw conflict('Send the verification code by itself in the sign-in conversation.');
      if (requests.rowCount !== 1)
        throw conflict(
          'More than one sign-in needs a code. Reply to the verification request you want to complete.',
        );
      const request = requests.rows[0]!;
      const codeFingerprint = await fingerprint(code, input);
      await client.query(
        `INSERT INTO messages(id,owner_id,role,text,task_id,reply_to_message_id)
         VALUES($1,$2,'user',$3,$4,$5)`,
        [
          input.clientMessageId,
          options.ownerId,
          pendingMessage,
          request.task_id,
          input.replyToMessageId ?? null,
        ],
      );
      await client.query(
        'INSERT INTO chat_verification_submissions(message_id,request_id,code_fingerprint) VALUES($1,$2,$3)',
        [input.clientMessageId, request.id, codeFingerprint],
      );
      await client.query('COMMIT');
      reserved = { taskId: request.task_id, requestId: request.id, revision: request.revision };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    options.refresh();
    let status: 'submitted' | 'rejected' | 'unavailable';
    try {
      const result = await options.submitCode(
        options.ownerId,
        reserved.taskId,
        code,
        reserved.requestId,
      );
      status =
        result.status === 'submitted' || result.status === 'rejected'
          ? result.status
          : 'unavailable';
    } catch {
      status = 'unavailable';
    }
    await pool.query(
      `WITH changed AS (
       UPDATE chat_verification_submissions SET status=$2 WHERE message_id=$1 RETURNING message_id
       ) UPDATE messages SET text=$3 WHERE id IN (SELECT message_id FROM changed)`,
      [input.clientMessageId, status, maskedMessage],
    );
    if (status !== 'submitted') {
      const message =
        status === 'rejected'
          ? 'That code did not work. Reply with a fresh verification code to try again.'
          : 'The code could not be applied. Check the sign-in step, then send a fresh code when it is ready.';
      await pool.query(
        `INSERT INTO messages(id,owner_id,role,text,task_id)
         SELECT $1,$2,'assistant',$3,t.id FROM tasks t
         WHERE t.id=$4 AND t.owner_id=$2 AND t.revision=$5 AND t.status='waiting_credentials'
           AND ${currentConversationSql()}`,
        [randomUUID(), options.ownerId, message, reserved.taskId, reserved.revision],
      );
    }
    options.refresh();
    return {
      taskId: reserved.taskId,
      continued: true,
      messageId: input.clientMessageId,
      messageText: maskedMessage,
      verificationStatus: status,
    };
  }

  return { pending, accept };
}
