export type ChannelProvider = 'telegram' | 'whatsapp';
export interface ChannelSetupSummary {
  provider: ChannelProvider;
  enabled: boolean;
  accountName?: string;
  accountHandle?: string;
  mode?: 'polling' | 'webhook';
  webhookStatus?: 'registered' | 'manual_setup';
  webhookUrl?: string;
}
export interface ChannelSetupVerifier {
  verify(
    provider: ChannelProvider,
    input: unknown,
  ): Promise<{
    environment: Record<string, string>;
    summary: ChannelSetupSummary;
  }>;
}
export class ChannelSetupFailure extends Error {
  constructor(
    readonly reason:
      'invalid_input' | 'verification_failed' | 'existing_webhook' | 'webhook_failed',
  ) {
    super(reason);
  }
}
