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

## Secure setup and saved settings

Open **Channels** in the local app. Setup forms send credentials directly to the trusted local server, outside the conversation and model. The server verifies the selected account and stores the settings encrypted with AES-256-GCM in PostgreSQL. The key comes from the same injected Keychain or environment key store as the vault, with a separate authenticated binding for the owner and channel. Status endpoints return account labels and setup state, never tokens or webhook secrets.

The saved settings override existing environment settings for that provider on startup. Disconnect disables the channel and removes its stored ciphertext; it does not revoke the provider token or change an existing remote webhook. Transport replacement waits for an active delivery before installing the new owner binding. Failed account verification does not replace the current local settings. A provider setup request and a database commit are separate systems; after an uncertain registration error, check the provider before retrying.

`src/server/channel-settings.ts` owns storage and routes. `src/ports/channel-settings.ts` defines verification, `src/providers/chat-sdk/settings.ts` calls provider APIs, and composition injects the verifier and transport factory. The settings service does not expose a raw environment editor.

## Telegram setup

Create a bot with [BotFather](https://t.me/BotFather). In Channels, enter its token and your numeric Telegram user ID. The server checks `getMe` before saving. With no public webhook URL, Sidekick polls for messages locally; no tunnel is needed. Open the verified bot in Telegram, press Start, and send a short message.

Local polling uses `getUpdates` every two seconds while the app runs, with a bounded request timeout. Each accepted message reaches the durable inbox before its offset advances in PostgreSQL. A failed inbox write leaves the update eligible for retry; duplicate updates cannot create duplicate tasks. Parsing and sending still use the official Chat SDK adapter. Sidekick does not start the SDK's automatic polling dispatcher, which would bypass the durable inbox.

If the bot already has a webhook, local polling setup is rejected. Sidekick never deletes an existing webhook automatically. You can enter a public HTTPS URL ending in `/api/webhooks/telegram` instead. Saving that URL registers it with a generated secret and only `message` updates. The URL must expose only the webhook route, not the application. [Telegram Bot API](https://core.telegram.org/bots/api#getupdates), [webhook setup](https://core.telegram.org/bots/api#setwebhook).

Legacy environment configuration remains supported:

```dotenv
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET_TOKEN=
TELEGRAM_ALLOWED_USER_ID=
TELEGRAM_MODE=polling
```

Omit `TELEGRAM_MODE` for the existing webhook mode. The webhook secret must have 16–256 characters from letters, digits, `_`, and `-`. Configure the same secret through `setWebhook` when managing a webhook outside the form.

The configured sender ID and private chat ID must both match the owner. Groups, channels, edits, callbacks, other senders, and messages without text do not start tasks. Voice, uploads, credentials, and approvals remain in the web app. [Chat SDK Telegram adapter](https://chat-sdk.dev/adapters/official/telegram).

## WhatsApp setup and eligibility

The Channels form accepts the business access token, app secret, business phone number ID, your allowed number, and a verification token you choose. It checks the selected business phone through the Graph API before saving. Register the callback and verification token in Meta, and subscribe to `messages`; the UI reports that this manual setup is still required. Saving credentials does not verify message delivery.

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

The Mac must be awake and Sidekick and PostgreSQL must be running. Telegram local polling needs outbound access only. For webhook mode, the provider must reach the exact HTTPS webhook path. A tunnel or small authenticated forwarding gateway must expose only the required webhook routes. Do not expose the entire app, `/api/channels`, the vault, screenshots, or credential forms. The rest of this prototype has no public user authentication. A forwarding gateway must preserve raw bytes and verification headers.

The app permits external requests only to the registered provider webhook paths. Their handlers validate provider secrets and owner identity independently. A tunnel URL does not configure the provider webhook or make the rest of the app safe to publish.

Credential and approval links are replaced in outbound replies with an instruction to open Sidekick on the Mac. Credentials and approvals cannot be completed by messaging the bot. Messages use a conversation identity bound to the provider, business/bot account, and allowed sender. A short answer can continue that conversation’s single task waiting for a question; it cannot resume a task from another channel. Secure forms and write approvals still require the web app. Schedules and unrelated web tasks have no channel mapping and do not send messages to the owner automatically.

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

Without `TEST_DATABASE_URL`, the database fixture is skipped. `tests/channel-settings.test.ts` and `tests/channel-application.test.ts` also cover encrypted settings, verification failures, ciphertext binding, secret-free responses, polling offset recovery, transport replacement, and channel-specific continuation. No provider account, webhook registration, recipient delivery, or Meta approval was tested live by these fixtures.
