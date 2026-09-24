# Composio connections

Checked against the official documentation and installed `@composio/core` 0.21.0 on 2026-09-24. The implementation uses Composio Platform sessions. It does not use the legacy `composio-core` package or build its own Google token refresh service. The TypeScript SDK requires ESM and Node.js 22.22.3 or later. [Quickstart](https://docs.composio.dev/docs/quickstart), [TypeScript sessions](https://docs.composio.dev/reference/sdk-reference/typescript/sessions).

## Setup

1. Use a Composio project for this app. Put its project key in the server environment as `COMPOSIO_API_KEY`. Existing provider accounts and connected accounts in another Composio project are not automatically Sidekick connections.
2. Open Connections and connect the required services. Gmail, Calendar, Drive, Sheets, and Docs use separate hosted consent flows in this version. Each account belongs to Sidekick's current local user ID, `local-development`. A future hosted release must replace this with a verified, stable application user ID.
3. For each service, Composio provides a Google OAuth app by default. A custom app can be selected with `COMPOSIO_GMAIL_AUTH_CONFIG_ID`, `COMPOSIO_CALENDAR_AUTH_CONFIG_ID`, `COMPOSIO_DRIVE_AUTH_CONFIG_ID`, `COMPOSIO_SHEETS_AUTH_CONFIG_ID`, or `COMPOSIO_DOCS_AUTH_CONFIG_ID`. Its Google APIs, scopes, consent configuration, and any required verification remain the app owner's responsibility. An active connection does not prove that the user granted every requested scope.

All five toolkits list managed OAuth support: [Gmail](https://docs.composio.dev/toolkits/gmail), [Calendar](https://docs.composio.dev/toolkits/googlecalendar), [Drive](https://docs.composio.dev/toolkits/googledrive), [Sheets](https://docs.composio.dev/toolkits/googlesheets), [Docs](https://docs.composio.dev/toolkits/googledocs). Composio also documents [Google Super](https://docs.composio.dev/kb/guide/toolkits-googlesuper) for one consent flow across services. Its tools and trigger compatibility need separate validation before replacing these connections.

## Runtime boundary

`src/providers/composio/integrations.ts` implements the provider-neutral interface in `src/ports/integrations.ts`. It owns the SDK, hosted consent URL validation, callback decoding, account status mapping, trigger configuration, and raw webhook verification. `src/server/integrations.ts` owns account intent, user checks, the action approval policy, durable event delivery, and HTTP routes. `src/server/composition.ts` selects the adapter and supplies its credentials. Feature tests can replace the adapter without mocking the Composio SDK.

The backend creates or restores one session per application user with an explicit five-toolkit allowlist. Remote sandboxes, premium tools, and in-chat connection management are disabled. The model gets tool schemas and results through the application broker, without a Composio project key or hosted MCP credential.

`session.authorize(slug, {callbackUrl})` returns a hosted `redirectUrl` and an account ID. Sidekick stores that attempt with a random, expiring callback state. It verifies the returned account against the attempt and asks Composio to confirm an active connection. Query parameters alone never establish ownership. [Manual authentication](https://docs.composio.dev/docs/authentication/manually-authenticating).

The runtime calls `execute(ownerId, 'SEARCH_TOOLS', {query})` for current Google action schemas. A small reviewed list of reads executes directly. Other Google actions return an approval request containing the exact action and arguments. Only the server's approved-action path calls `executeApproved()`. Non-Google tool prefixes and Composio meta execution are rejected. Do not give the agent direct access to `executeApproved()` or the project key. Google consent scopes and API availability still limit actions. [Session search and execution](https://docs.composio.dev/reference/sdk-reference/typescript/session).

Composio owns the connected-account tokens in its default cloud deployment, refreshes them, and injects them into provider API requests. Provider tokens are redacted from account responses by default. Composio can still use those tokens, and tool results can contain private user data. Its execution logs retain tool payloads by default; review the project's retention controls. This service is not the browser password vault. [Token custody](https://docs.composio.dev/docs/security/token-custody).

Account and session references are tagged with their provider. The migration renames `composio_sessions` and `composio_events` to `integration_sessions` and `integration_events`, retaining existing rows and event IDs. Disconnect and revoke connections with the old provider before replacing its adapter. A replacement provider cannot reuse another provider's account or session IDs. New authorization and webhook setup are required; changing adapters does not transfer Google OAuth credentials. Browser-vault ciphertext is unaffected.

## Notifications

Gmail and Calendar notifications are off until the user enables them. Set up a signed project webhook and put its secret in `COMPOSIO_WEBHOOK_SECRET`. The handler is `/api/webhooks/composio`. This local app does not automatically overwrite a project's existing webhook destination.

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

Feature tests inject a replacement provider and use real disposable PostgreSQL schemas. They check callback ownership, provider status, account isolation, duplicate events, revocation during recovery, read access, approval gates, and legacy-reference migration. Separate adapter tests exercise Composio's real signature parser with synthetic signed payloads and verify normalized session output. They do not prove live Google consent, provider scopes, trigger arrival, or production delivery. Run them with `TEST_DATABASE_URL` pointing at a local test database.
