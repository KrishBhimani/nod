# Connected apps through Composio

Checked against the official documentation and installed `@composio/core` 0.21.0 on 2026-09-25. The implementation uses Composio Platform sessions. It does not use the legacy `composio-core` package or build its own Google token refresh service. The TypeScript SDK requires ESM and Node.js 22.22.3 or later. [Quickstart](https://docs.composio.dev/docs/quickstart), [TypeScript sessions](https://docs.composio.dev/reference/sdk-reference/typescript/sessions).

## Setup

1. Use a Composio project for this app. Put its project key in the server environment as `COMPOSIO_API_KEY`. Existing provider accounts and connected accounts in another Composio project are not automatically Sidekick connections.
2. Open Apps at `/apps` and use Connect or Add account on the required service. Gmail, Calendar, Drive, Sheets, Docs, Slack, and Notion use separate hosted consent flows in this version, with multiple accounts per service. Each saved connection belongs to Sidekick's current local user ID, `local-development`. A future hosted release must replace this with a verified, stable application user ID.
3. For Google services, Composio provides a managed OAuth app by default. A custom app can be selected with `COMPOSIO_GMAIL_AUTH_CONFIG_ID`, `COMPOSIO_CALENDAR_AUTH_CONFIG_ID`, `COMPOSIO_DRIVE_AUTH_CONFIG_ID`, `COMPOSIO_SHEETS_AUTH_CONFIG_ID`, or `COMPOSIO_DOCS_AUTH_CONFIG_ID`. Slack and Notion can use `COMPOSIO_SLACK_AUTH_CONFIG_ID` and `COMPOSIO_NOTION_AUTH_CONFIG_ID`. The provider APIs, granted permissions, consent configuration, and required verification remain the app owner's responsibility. An active connection does not prove that the user granted every requested scope.

The five Google toolkits list managed OAuth support: [Gmail](https://docs.composio.dev/toolkits/gmail), [Calendar](https://docs.composio.dev/toolkits/googlecalendar), [Drive](https://docs.composio.dev/toolkits/googledrive), [Sheets](https://docs.composio.dev/toolkits/googlesheets), [Docs](https://docs.composio.dev/toolkits/googledocs). Composio also documents [Google Super](https://docs.composio.dev/kb/guide/toolkits-googlesuper) for one consent flow across services. Its tools and trigger compatibility need separate validation before replacing these connections.

Slack and Notion also offer managed OAuth. Sidekick uses the Slack user toolkit, so actions run with the connected user's permissions; this does not install a Sidekick chat bot. Slack distinguishes user and bot scopes, and workspace policy can restrict installation or access. Custom Slack auth must use `user_scopes` for user-token operations. Notion exposes only the pages and databases granted to its integration, further limited by its read/insert/update capabilities. A second auth configuration is not necessarily a separate Notion page-access grant. [Slack toolkit](https://docs.composio.dev/toolkits/slack), [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth/), [Notion authorization](https://developers.notion.com/guides/get-started/authorization), [Notion capabilities](https://developers.notion.com/reference/capabilities), [Composio Notion access](https://docs.composio.dev/kb/guide/toolkits-notion).

## Runtime boundary

`src/providers/composio/integrations.ts` implements the provider-neutral interface in `src/ports/integrations.ts`. It owns the SDK, hosted consent URL validation, callback decoding, account status mapping, trigger configuration, and raw webhook verification. `src/server/integrations.ts` owns account intent, user checks, the action approval policy, durable event delivery, and HTTP routes. `src/server/composition.ts` selects the adapter and supplies its credentials. Feature tests can replace the adapter without mocking the Composio SDK.

The backend creates or restores one task-execution session per application user with an explicit seven-toolkit allowlist and multiple-account support. Account selection is explicit. Remote sandboxes, premium tools, and in-chat connection management are disabled. The model gets tool schemas, owned account references, and results through the application broker, without a Composio project key or hosted MCP credential. Identity checks use separate short-lived sessions restricted to one account and one read tool.

`session.authorize(slug, {callbackUrl})` returns a hosted `redirectUrl` and an account ID. Sidekick stores that attempt with a random, expiring callback state. It verifies the returned account against the attempt and asks Composio to confirm an active connection. The application callback is `/api/apps/callback` and returns to `/apps`; there are no Connections URL aliases. Query parameters alone never establish ownership. [Manual authentication](https://docs.composio.dev/docs/authentication/manually-authenticating).

The runtime calls `execute(ownerId, 'SEARCH_TOOLS', {query})` for current connected-app action schemas and available account references. The exact read list in `src/server/integration-policy.ts` executes directly. Tool-name prefixes do not establish read safety. With several accounts, the caller must select a local `connectionId`; a single account can be selected automatically before review. Other actions in the supported toolkits return an approval containing the exact action, arguments, and selected connection ID. Preflight and execution recheck the binding. Old approvals without an account ID cannot fall back to a replacement account.

The broker calls `executeApproved()` only for its reviewed reads or an accepted action review. Tool prefixes outside the seven allowed apps and Composio meta execution are rejected. Do not give the agent direct access to this method or the project key. The adapter treats a non-null error or `successful:false` envelope as failure even when the SDK promise resolves. Execution failures stay uncertain and do not produce a success continuation containing raw provider errors. Provider permissions and API availability still limit actions. [Session search and execution](https://docs.composio.dev/reference/sdk-reference/typescript/session).

## File retrieval

`GMAIL_GET_ATTACHMENT`, `GOOGLEDRIVE_DOWNLOAD_FILE`, and `GOOGLEDRIVE_DOWNLOAD_FILE_OPERATION` are retrieval operations. They do not ask for a write review. The runtime routes them from either `apps` or `download_app_file` through the owned artifact delivery path. The integration service also blocks ordinary execution from returning a signed provider URL and supplies a fixed download instruction instead. Fetch a full Gmail message first to obtain its actual `message_id`, `attachment_id`, and file name. Downloading a sent attachment does not forward or send another email. [Gmail attachment tool](https://docs.composio.dev/toolkits/gmail), [Drive download tools](https://docs.composio.dev/toolkits/googledrive).

`IntegrationSession.download` and the server's `integrations.download` return `{name,mimeType,bytes}` only to trusted application code. The adapter validates exact arguments and the selected account, executes the reviewed operation, and accepts only the provider's completed file descriptor. HTTPS downloads have a 15 MB limit, a 30-second deadline, public-IP validation with the connection pinned to that address, and at most three checked redirects. No arbitrary model URL, local path, provider cookie or credential header is used. Pending Drive operations and missing/oversized files return a fixed failure instead of a fabricated attachment. The feature has a 35-second overall wait bound and rechecks account ownership/revocation before returning. The task layer separately fences artifact storage and delivery by its current revision.

`SLACK_DOWNLOAD_SLACK_FILE` remains outside the direct-read list: its current description says it converts a file to a publicly accessible URL. Slack file listing and metadata are direct reads; public sharing, upload, messages and unknown operations retain review. Native Slack/Notion file delivery through this download tool is not implemented. [Slack download behavior](https://docs.composio.dev/toolkits/slack).

## Verified account labels

Account names and email addresses come from authenticated provider responses, not guesses or credential metadata. Gmail uses `GMAIL_GET_PROFILE`, Calendar uses `GOOGLECALENDAR_GET_CURRENT_USER`, and Drive uses `GOOGLEDRIVE_GET_ABOUT` with only `user(displayName,emailAddress)` requested. Calendar returns a calendar identity label, which is not necessarily a full Google Account name. [Gmail tools](https://docs.composio.dev/toolkits/gmail), [Calendar tools](https://docs.composio.dev/toolkits/googlecalendar), [Drive identity guidance](https://docs.composio.dev/kb/guide/toolkits-googledrive).

Slack uses `SLACK_WHO_AM_I` for its user/workspace label. Notion uses `NOTION_WHO_AM_I` for its workspace and owner email when present; an integration name is not proof of a human identity. These are account-bound reads, and failed identity lookups do not invent labels. [Slack identity](https://docs.composio.dev/toolkits/slack), [Notion identity](https://docs.composio.dev/toolkits/notion).

The identity session binds the server-supplied owner, toolkit, account, and read action. It is deleted after inspection. Successful labels are cached for 15 minutes, failed checks for one minute, and concurrent checks share one request. Only validated name/email fields leave the adapter; aggregate mailbox counts, history IDs, provider log IDs, and response URLs are discarded.

Direct Google profile proxy requests remain a fallback for Google services only. The current local API key denied direct proxy and direct-tool requests with 403 while Tool Router identity tools worked for the same active Gmail, Calendar, and Drive accounts. This was not a revoked Google grant and did not require reconnecting. If neither supported identity path works, the UI reports unavailable details. Sheets/Docs identity depends on the permitted profile/about proxy path and is not live-verified.

## Credential ownership and migration

Composio owns the connected-account tokens in its default cloud deployment, refreshes them, and injects them into provider API requests. Provider tokens are redacted from account responses by default. Composio can still use those tokens, and tool results can contain private user data. Its execution logs retain tool payloads by default; review the project's retention controls. This service is not the browser password vault. [Token custody](https://docs.composio.dev/docs/security/token-custody).

Account and session references are tagged with their provider. Additive migrations preserve existing connections and pending consent while assigning stable local connection IDs. A legacy row containing an active account and a second pending account becomes separate records. Session configuration version 3 recreates the execution session with all seven toolkits without deleting OAuth accounts. The older table migration also retains session and event rows.

Disconnect and revoke connections with the old provider before replacing its adapter. A replacement provider cannot reuse another provider's account or session IDs. New authorization and webhook setup are required; changing adapters does not transfer OAuth credentials. Browser-vault and saved-channel ciphertext are unaffected.

## Notifications

Supported watches are requested automatically for each account. The API reports unavailable when signed webhook configuration is missing and pending when provider subscription creation has not succeeded. The Apps page has no watch switch. Disconnecting an account removes its watch; an active subscription is not proof that an event has arrived.

Set up a signed project webhook and put its secret in `COMPOSIO_WEBHOOK_SECRET`. The handler is `/api/webhooks/composio`. This local app does not automatically overwrite a project's existing webhook destination. An enabled watch is not permission to notify on every event; Sidekick's relevance check, user preferences, quiet hours, and dispatch limits still apply.

For development, forward real events to the local handler with:

```sh
composio dev triggers listen --forward http://localhost:4310/api/webhooks/composio
```

Use the same `COMPOSIO_WEBHOOK_SECRET` in the CLI and app. For a hosted ingress, register its public HTTPS URL in the dedicated Composio project. Expose only the signed webhook endpoint, not the local web application. Composio's API also supports `composio.triggers.setWebhookSubscription({webhookUrl})`; this updates an existing project subscription, so use it deliberately. [Receiving events](https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events).

Google watches use `GMAIL_NEW_GMAIL_MESSAGE` or `GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER`, pinned to the selected account. Gmail watches the inbox; Calendar watches the primary calendar. Both use a 15-minute interval. These are polling integrations; do not promise immediate delivery or exact reminder timing. Shared managed OAuth can add about 15 minutes of latency. [Trigger setup](https://docs.composio.dev/docs/setting-up-triggers/creating-triggers), [Trigger latency](https://docs.composio.dev/docs/triggers).

Slack watches use `SLACK_DIRECT_MESSAGE_RECEIVED`; they cover DMs, not channel messages. This V2 trigger requires a Composio webhook ingress configured on the Slack OAuth app, including its signing secret and an app-level token for per-user private-event authorization. Sidekick does not create or overwrite that provider ingress. Missing ingress or permissions leave subscription creation pending. [Slack trigger setup](https://docs.composio.dev/reference/changelog), [Slack trigger guidance](https://docs.composio.dev/kb/guide/toolkits-slack).

Notion watches use `NOTION_PAGE_CONTENT_UPDATED` for content edits on pages available to the integration. They do not cover page creation, property changes, or every Notion event. Provider webhook configuration and page permissions still apply; edits may be aggregated before arrival. [Notion trigger catalog](https://docs.composio.dev/toolkits/notion), [Event delivery](https://docs.composio.dev/docs/triggers).

The adapter verifies the signature over the raw body with the SDK's default five-minute timestamp tolerance. The application checks the user, provider, account, trigger, and enabled state, then stores a unique event receipt. A retryable outbox passes a bounded summary to Sidekick's notification filter before the main agent runs. It excludes message bodies and provider credential fields. Event subjects remain untrusted private content. Queued events and interrupted processing events are discarded if their connection or trigger is no longer enabled. Every claim rechecks those conditions before delivery. Downstream work must also deduplicate by event ID because delivery across a process crash is at least once.

## Cost and limits

As published on 2026-09-24, managed OAuth includes 20,000 calls and 10,000 delivered trigger events per month; paid overages are $0.0005/call and $0.005/event. The free plan stops at its limits. Scale is $29/month with $29 in monthly usage credit. Using your own OAuth apps provides larger allowances and lower usage rates. Model, browser, hosting, and messaging-provider charges are separate. Customers signed up before 2026-08-15 retain their previous pricing through 2026-12-31; check the existing account's dashboard. [Pricing](https://composio.dev/pricing).

## Validation

Feature tests inject a replacement provider and use real disposable PostgreSQL schemas. They check consent ownership, multiple accounts, exact read/review boundaries, scoped watches, duplicate events, revocation during recovery and session upgrades. `integration-apps` covers Slack/Notion and file-account binding; `integration-files` covers returned descriptors, network pinning, redirects, streamed size limits and cancellation. `connections-ui` covers visible per-app actions and cache/focus behavior. Adapter tests cover SDK validation, signed webhooks, failure envelopes, verified identity fields, and cleanup of account-scoped identity sessions. Run them with `TEST_DATABASE_URL` pointing at a local test database.

Live local checks on 2026-09-24 verified existing Gmail, Calendar, and Drive consent state and their read-only identity tools. Gmail label listing was also verified. These checks did not read email bodies, send messages, alter grants, or prove Calendar/Drive writes, Sheets/Docs account flows, trigger arrival, or production delivery. See [verification](verification.md) for the broader application record.

The 2026-09-25 Slack/Notion addition is fixture-tested only. Official current catalogs and attachment response schemas were read without executing an account tool. No real Slack/Notion consent, action, webhook, private-file download or external message delivery was performed in this change.
