# Optional messaging channels

Sidekick works in the local web app without a messaging provider. Telegram and WhatsApp Business Cloud are optional text channels for the same local owner. They use Vercel Chat SDK 4.41.0: `chat`, `@chat-adapter/telegram`, `@chat-adapter/whatsapp`, and `@chat-adapter/state-pg`. This is not a public bot service or account signup system.

The implementation uses the official adapters to normalize inbound messages and send replies. Sidekick verifies the raw webhook before it saves an inbox row. It then creates the task and queue job in the same PostgreSQL transaction as the inbox mapping. This avoids an acceptance gap between SDK webhook deduplication and task persistence. The adapters' direct webhook dispatchers are not used. [Chat SDK adapters](https://chat-sdk.dev/docs/platform-adapters), [PostgreSQL adapter source](https://github.com/vercel/chat/tree/main/packages/state-pg).

```mermaid
flowchart LR
  P[Provider webhook] --> V[Verify signature and owner]
  V --> A[Chat SDK message parser]
  A --> I[PostgreSQL inbox]
  I --> T[Task and queue transaction]
  T --> M[Assistant message]
  M --> O[PostgreSQL outbox]
  O --> S[Chat SDK thread.post]
```

## Telegram setup

Create a bot with BotFather. Use a numeric Telegram user ID for the owner, not a username. Set these values in the ignored local `.env`, then restart Sidekick:

```dotenv
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET_TOKEN=
TELEGRAM_ALLOWED_USER_ID=
```

The webhook secret must have 16–256 characters from letters, digits, `_`, and `-`. Generate a random value. The Bot API `setWebhook` call must set the same `secret_token`, the public HTTPS URL ending in `/api/webhooks/telegram`, and `allowed_updates` containing `message`. Setup does not happen automatically. The owner must start the bot conversation first. [Telegram Bot API webhook setup](https://core.telegram.org/bots/api#setwebhook), [official Chat SDK Telegram adapter](https://chat-sdk.dev/adapters/official/telegram).

The configured sender ID and private chat ID must both match the owner. Groups, channels, edits, callbacks, other senders, and messages without text do not start tasks. Sidekick fixes the adapter to webhook mode. It does not start polling or delete an existing webhook. Images, uploads, voice, approvals, and credentials remain available in the web app.

## WhatsApp setup and eligibility

Use the official WhatsApp Business Cloud API, not personal-account QR automation. Before enabling it, check the current WhatsApp Business terms, AI-provider eligibility for the relevant market, account requirements, and charges. The flag below records that operator decision. It is not an eligibility check, approval from Meta, or permission to operate a general assistant worldwide. A transport SDK cannot bypass platform policy. [WhatsApp Business terms](https://www.whatsapp.com/legal/business-solution-terms), [Meta WhatsApp documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview).

```dotenv
WHATSAPP_ENABLED=true
WHATSAPP_POLICY_CONFIRMED=true
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_ALLOWED_NUMBER=
```

The allowed number contains 7–15 international digits without `+`. The phone number ID is Meta's business sender ID. These are different identifiers. Configure the Meta callback URL ending in `/api/webhooks/whatsapp`, its verify token, and the `messages` webhook subscription. Use an appropriate system-user access token for continued use. Sidekick verifies GET challenges and the raw POST body's `X-Hub-Signature-256` HMAC. It also requires the expected business phone ID and exact owner number. Phone-hidden or BSUID-only users are not supported by this one-owner binding. [Official Chat SDK WhatsApp adapter](https://chat-sdk.dev/adapters/official/whatsapp).

Replies are free-form text only. Sidekick blocks a send if the latest accepted owner message is at least 24 hours old. It does not send templates, proactive campaigns, or delayed replies outside that window. A blocked reply remains in the web app. This prototype does not implement delivery receipts or channel audio/media. Check current provider prices before live use; SDK installation is not a messaging-cost quote.

## Reachability and local access

The Mac must be awake, Sidekick and PostgreSQL must be running, and the provider must reach the exact HTTPS webhook path. A tunnel or small authenticated forwarding gateway must expose only the required webhook routes. Do not expose the entire app, `/api/channels`, the vault, screenshots, or credential forms. The rest of this prototype has no public user authentication. A forwarding gateway must preserve raw bytes and verification headers.

The app permits external requests only to the registered provider webhook paths. Their handlers validate provider secrets and owner identity independently. A tunnel URL does not configure the provider webhook or make the rest of the app safe to publish.

Credential and approval links are replaced in outbound replies with an instruction to open Sidekick on the Mac. Credentials and approvals cannot be completed by messaging the bot. Each inbound message starts its own task; use the web app to continue a specific waiting task. Schedules and unrelated web tasks have no channel mapping and do not send messages to the owner automatically.

## Persistence and recovery

`channel_inbox` retains a unique provider/account/message identity, normalized text, sender, destination, provider timestamp, task ID, and acceptance state. Creating a task, creating its queue job, and recording its mapping use one transaction. A database or queue failure leaves the inbox pending for retry. Duplicated webhooks do not create another task.

An event listener and a two-second fallback scan find assistant messages for mapped tasks. `channel_outbox` records one delivery per assistant message. Access is checked again before sending. Changing the owner binding or disabling the channel blocks old pending deliveries. Both channel tables and Chat SDK state use local PostgreSQL; content is not covered by vault encryption or automatically deleted. Messaging providers also process messages under their own policies.

The outbox records `sending` before the provider request. A provider acceptance becomes `sent`; this means the API accepted the message, not that the owner received it. A failed or interrupted send becomes `uncertain`. It is not automatically retried because the provider may already have accepted it. On restart, leftover `sending` rows become `uncertain`. Inspect the local conversation and provider before deciding whether to send again. There is no exactly-once guarantee for an external send, no automatic backoff/retry for rate limits, and no operator resend UI yet.

`GET /api/channels` is a local diagnostic endpoint. `disabled`, `setup_required`, and `configured` describe local setup only. `configured` does not claim that tokens, webhook registration, policy eligibility, or live delivery have been verified. The endpoint also reports inbox/outbox counts and a fixed processing error. SDK logging is silent to keep tokens and message payloads out of logs. Run only one Sidekick server process for this local prototype.

## Validation

`tests/channels.test.ts` uses the real SDK adapters and an isolated PostgreSQL schema. Every provider request is mocked. It covers invalid secrets/signatures, owner/group/business rejection, task-transaction rollback, duplicate events, destination routing, unrelated web replies, secure-link replacement, closed WhatsApp windows, uncertain sends, restart recovery, and changed owner bindings.

```sh
TEST_DATABASE_URL=postgresql://sidekick:sidekick-local@127.0.0.1:54329/sidekick npx tsx --test tests/channels.test.ts
```

Without `TEST_DATABASE_URL`, the database fixture is skipped. No provider account, webhook registration, recipient delivery, or Meta approval was tested live.
