export interface MessagingChannel {
  id: string;
  status: 'disabled' | 'setup_required' | 'configured';
  missing: string[];
  accountId?: string;
  allowedSenderIds: string[];
  replyWindowMs?: number;
}

export interface InboundMessage {
  channelId: string;
  accountId: string;
  senderId: string;
  messageId: string;
  threadId: string;
  text: string;
  sentAt: Date;
}

export interface MessagingWebhook {
  channelId: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: unknown;
  body: Uint8Array;
}

export interface MessagingWebhookResult {
  status: number;
  body: string | Record<string, unknown>;
  contentType?: string;
  messages?: InboundMessage[];
}

export interface MessagingTransport {
  channels: MessagingChannel[];
  receive(request: MessagingWebhook): Promise<MessagingWebhookResult>;
  post(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    text: string;
  }): Promise<{ id: string }>;
  close(): Promise<void>;
}
