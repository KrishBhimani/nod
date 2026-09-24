# Composio connections

Checked against the official documentation and installed `@composio/core` 0.21.0 on 2026-09-24. The implementation uses Composio Platform sessions. It does not use the legacy `composio-core` package or build its own Google token refresh service. The TypeScript SDK requires ESM and Node.js 22.22.3 or later. [Quickstart](https://docs.composio.dev/docs/quickstart), [TypeScript sessions](https://docs.composio.dev/reference/sdk-reference/typescript/sessions).

## Setup

1. Use a Composio project for this app. Put its project key in the server environment as `COMPOSIO_API_KEY`. Existing provider accounts and connected accounts in another Composio project are not automatically Sidekick connections.
2. Open Connections and add the required accounts. Gmail, Calendar, Drive, Sheets, and Docs use separate hosted consent flows in this version, with multiple accounts per service. Each saved connection belongs to Sidekick's current local user ID, `local-development`. A future hosted release must replace this with a verified, stable application user ID.
3. For each service, Composio provides a Google OAuth app by default. A custom app can be selected with `COMPOSIO_GMAIL_AUTH_CONFIG_ID`, `COMPOSIO_CALENDAR_AUTH_CONFIG_ID`, `COMPOSIO_DRIVE_AUTH_CONFIG_ID`, `COMPOSIO_SHEETS_AUTH_CONFIG_ID`, or `COMPOSIO_DOCS_AUTH_CONFIG_ID`. Its Google APIs, scopes, consent configuration, and any required verification remain the app owner's responsibility. An active connection does not prove that the user granted every requested scope.

All five toolkits list managed OAuth support: [Gmail](https://docs.composio.dev/toolkits/gmail), [Calendar](https://docs.composio.dev/toolkits/googlecalendar), [Drive](https://docs.composio.dev/toolkits/googledrive), [Sheets](https://docs.composio.dev/toolkits/googlesheets), [Docs](https://docs.composio.dev/toolkits/googledocs). Composio also documents [Google Super](https://docs.composio.dev/kb/guide/toolkits-googlesuper) for one consent flow across services. Its tools and trigger compatibility need separate validation before replacing these connections.

## Runtime boundary

`src/providers/composio/integrations.ts` implements the provider-neutral interface in `src/ports/integrations.ts`. It owns the SDK, hosted consent URL validation, callback decoding, account status mapping, trigger configuration, and raw webhook verification. `src/server/integrations.ts` owns account intent, user checks, the action approval policy, durable event delivery, and HTTP routes. `src/server/composition.ts` selects the adapter and supplies its credentials. Feature tests can replace the adapter without mocking the Composio SDK.

The backend creates or restores one task-execution session per application user with an explicit five-toolkit allowlist and multiple-account support. Account selection is explicit. Remote sandboxes, premium tools, and in-chat connection management are disabled. The model gets tool schemas, owned account references, and results through the application broker, without a Composio project key or hosted MCP credential. Identity checks use separate short-lived sessions restricted to one account and one read tool.

`session.authorize(slug, {callbackUrl})` returns a hosted `redirectUrl` and an account ID. Sidekick stores that attempt with a random, expiring callback state. It verifies the returned account against the attempt and asks Composio to confirm an active connection. Query parameters alone never establish ownership. [Manual authentication](https://docs.composio.dev/docs/authentication/manually-authenticating).

The runtime calls `execute(ownerId, 'SEARCH_TOOLS', {query})` for current Google action schemas and available account references. A small reviewed list of reads executes directly. With several accounts, the caller must select a local `connectionId`; a single account can be selected automatically before review. Other Google actions return an approval containing the exact action, arguments, and selected connection ID. Preflight and execution recheck the binding. Old approvals without an account ID cannot fall back to a replacement account.

Only the server's approved-action path calls `executeApproved()`. Non-Google tool prefixes and Composio meta execution are rejected. Do not give the agent direct access to this method or the project key. The adapter treats a non-null error or `successful:false` envelope as failure even when the SDK promise resolves. Execution failures stay uncertain and do not produce a success continuation containing raw provider errors. Google consent scopes and API availability still limit actions. [Session search and execution](https://docs.composio.dev/reference/sdk-reference/typescript/session).

## Verified account labels

Account names and email addresses come from authenticated provider responses, not guesses or credential metadata. Gmail uses `GMAIL_GET_PROFILE`, Calendar uses `GOOGLECALENDAR_GET_CURRENT_USER`, and Drive uses `GOOGLEDRIVE_GET_ABOUT` with only `user(displayName,emailAddress)` requested. Calendar returns a calendar identity label, which is not necessarily a full Google Account name. [Gmail tools](https://docs.composio.dev/toolkits/gmail), [Calendar tools](https://docs.composio.dev/toolkits/googlecalendar), [Drive identity guidance](https://docs.composio.dev/kb/guide/toolkits-googledrive).

The identity session binds the server-supplied owner, toolkit, account, and read action. It is deleted after inspection. Successful labels are cached for 15 minutes, failed checks for one minute, and concurrent checks share one request. Only validated name/email fields leave the adapter; aggregate mailbox counts, history IDs, provider log IDs, and response URLs are discarded.

Direct proxy requests remain a fallback. The current local API key denied direct proxy and direct-tool requests with 403 while Tool Router identity tools worked for the same active Gmail, Calendar, and Drive accounts. This was not a revoked Google grant and did not require reconnecting. If neither supported identity path works, the UI reports unavailable details. Sheets/Docs identity depends on the permitted profile/about proxy path and is not live-verified.

## Credential ownership and migration

Composio owns the connected-account tokens in its default cloud deployment, refreshes them, and injects them into provider API requests. Provider tokens are redacted from account responses by default. Composio can still use those tokens, and tool results can contain private user data. Its execution logs retain tool payloads by default; review the project's retention controls. This service is not the browser password vault. [Token custody](https://docs.composio.dev/docs/security/token-custody).

Account and session references are tagged with their provider. Additive migrations preserve existing connections and pending consent while assigning stable local connection IDs. A legacy row containing an active account and a second pending account becomes separate records. The session configuration is upgraded for multiple accounts without deleting OAuth accounts. The older table migration also retains session and event rows.

Disconnect and revoke connections with the old provider before replacing its adapter. A replacement provider cannot reuse another provider's account or session IDs. New authorization and webhook setup are required; changing adapters does not transfer Google OAuth credentials. Browser-vault and saved-channel ciphertext are unaffected.

## Notifications

Gmail and Calendar watches are requested by default for each account. The UI separates that preference from an active subscription: it reports unavailable delivery when signed webhook configuration is missing and pending status until creation succeeds. Disable or retry each account's watch independently in Connections. Existing saved watch choices survive restart.

Set up a signed project webhook and put its secret in `COMPOSIO_WEBHOOK_SECRET`. The handler is `/api/webhooks/composio`. This local app does not automatically overwrite a project's existing webhook destination. An enabled watch is not permission to notify on every event; Sidekick's relevance check, user preferences, quiet hours, and dispatch limits still apply.

For development, forward real events to the local handler with:

```sh
composio dev triggers listen --forward http://localhost:4310/api/webhooks/composio
```

Use the same `COMPOSIO_WEBHOOK_SECRET` in the CLI and app. For a hosted ingress, register its public HTTPS URL in the dedicated Composio project. Expose only the signed webhook endpoint, not the local web application. Composio's API also supports `composio.triggers.setWebhookSubscription({webhookUrl})`; this updates an existing project subscription, so use it deliberately. [Receiving events](https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events).

The enabled trigger is `GMAIL_NEW_GMAIL_MESSAGE` or `GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER`, pinned to the selected account. Gmail watches the inbox; Calendar watches the primary calendar. Both use a 15-minute interval. These are polling integrations; do not promise immediate delivery or exact reminder timing. Shared managed OAuth can add about 15 minutes of latency. [Trigger setup](https://docs.composio.dev/docs/setting-up-triggers/creating-triggers), [Trigger latency](https://docs.composio.dev/docs/triggers).

The adapter verifies the signature over the raw body with the SDK's default five-minute timestamp tolerance. The application checks the user, provider, account, trigger, and enabled state, then stores a unique event receipt. A retryable outbox passes a bounded summary to Sidekick's notification filter before the main agent runs. It excludes message bodies and provider credential fields. Event subjects remain untrusted private content. Queued events and interrupted processing events are discarded if their connection or trigger is no longer enabled. Every claim rechecks those conditions before delivery. Downstream work must also deduplicate by event ID because delivery across a process crash is at least once.

## Cost and limits

As published on 2026-09-24, managed OAuth includes 20,000 calls and 10,000 delivered trigger events per month; paid overages are $0.0005/call and $0.005/event. The free plan stops at its limits. Scale is $29/month with $29 in monthly usage credit. Using your own OAuth apps provides larger allowances and lower usage rates. Model, browser, hosting, and messaging-provider charges are separate. Customers signed up before 2026-08-15 retain their previous pricing through 2026-12-31; check the existing account's dashboard. [Pricing](https://composio.dev/pricing).

## Validation

Feature tests inject a replacement provider and use real disposable PostgreSQL schemas. They check consent ownership, multiple accounts, scoped tools/approvals/watches, duplicate events, revocation during recovery, and migrations that preserve saved connections. Adapter tests cover SDK validation, signed webhooks, failure envelopes, verified identity fields, and cleanup of account-scoped identity sessions. Run them with `TEST_DATABASE_URL` pointing at a local test database.

Live local checks on 2026-09-24 verified existing Gmail, Calendar, and Drive consent state and their read-only identity tools. Gmail label listing was also verified. These checks did not read email bodies, send messages, alter grants, or prove Calendar/Drive writes, Sheets/Docs account flows, trigger arrival, or production delivery. See [verification](verification.md) for the broader application record.
