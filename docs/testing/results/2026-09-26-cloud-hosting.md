# Hosted Sidekick implementation acceptance

Status date: **2026-09-26**. This records the implemented hosted stack after the [prototype review](2026-09-26-cloud-prototype.md). Live signup and deployment remain incomplete. Provider resources and pending account setup are tracked in [provider account preparation](../../research/provider-account-setup.md).

## Automated and local process evidence

| Boundary                  | Evidence                                                                                                                                                               | Scope                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Full regression suite     | 1,017 tests passed, zero failures/skips, with a separate disposable PostgreSQL 17 service                                                                              | Synthetic users, provider substitutes and real local subprocesses; no production credentials                  |
| Authentication            | Real Better Auth migrations, signed synthetic sessions, cookie tampering, unverified-email denial, logout revocation and rejected OAuth callbacks                      | Real SDK/database behavior; no Google network login                                                           |
| Tenant isolation          | Restricted SQL logins, private app/jobs schemas, cross-schema and `SET ROLE` denial, independent pg-boss queues, admission and generation leases                       | Real disposable PostgreSQL; two actual tenant processes retained separate preferences across graceful restart |
| HTTP boundary             | Verified-cookie routing, expected-account mismatch, exact Host/Origin, developer-only computer routes, response-header filtering and revoked SSE closure               | Gateway fixtures; raw webhook bytes and private control envelopes remain scoped                               |
| Latest gateway review     | Eight focused gateway tests passed after restoring artifact CSP and Range forwarding                                                                                   | Hosted downloads retain sandbox/nosniff and 206 range behavior                                                |
| Developer capture         | Ordinary users get `DEV_INSPECTOR=false`; capture requires both assigned developer identity and explicit operator opt-in                                               | Runtime configuration fixtures plus existing disabled-capture tests                                           |
| Integrations and channels | Owned consent return, callback cancellation/expiry, raw signatures, account/subscription ownership, deduplication, unique bot claims and lease-atomic registry writes  | Synthetic provider events; no live message delivery                                                           |
| Files and agent recovery  | PostgreSQL/HTTP/S3/filesystem stores, conditional writes, scoped artifacts, Pi pre-action checkpoints, uncertain-result fences and restarted transcript loading        | Real disposable SQL and local files, injected remote transports                                               |
| Remote computer adapter   | Separate browser/workspace allocations, bounded commands, TERM-resistant process drain, idle pause/same-resource resume, lifecycle leases and uncertain-state recovery | E2B SDK and command-transport fixtures; no live sandbox                                                       |
| Cloudflare package        | Type checks, 16 adapter/deployment fixtures, both environment deployment dry runs and a non-root amd64 Node image build                                                | Local packaging and protocol evidence; no resource creation or deployment                                     |
| Publishable files         | Gitleaks 8.30.1 found no leaks in the eligible repository-file snapshot                                                                                                | Ignored private environment files were excluded                                                               |

Two earlier full-suite runs exposed obsolete fixtures and a real duplicate state-file write during local runtime shutdown. Those were repaired before the passing full run. Tests use dedicated disposable databases and do not rotate the existing local application's database credentials.

## Actual frontend browser checks

The application frontend was exercised in native Chrome against a separate synthetic HTTP fixture on port 4346. Desktop checks passed for sign-in, direct integration consent navigation and same-screen Connected return, onboarding completion, the avatar menu, theme changes, Cmd+, and vertical settings keyboard navigation.

At 320×740, chat, the mobile menu, appearance previews, preferences save and sign-out were exercised. Quiet-hours controls now stack on narrow screens. A second synthetic user returned to fresh disconnected onboarding rather than seeing the first user's connection. These checks validate rendered UX and client account transitions; they do not establish live Google authentication or provider ownership.

## Live development provider checks

- Neon development authenticated over verified TLS. A separate temporary database successfully provisioned two restricted tenant logins, migrated their private object stores, dispatched independent pg-boss jobs and denied cross-user/control-schema access. The temporary database and its synthetic roles were removed successfully afterward. The real Sidekick application database was not migrated by this check.
- The scoped development Composio key authenticated an account-list read. Session/proxy requests reached schema validation and trigger types were readable. This proves those credential permissions, not connected-account execution or webhook delivery.
- No production key or production database was used for local acceptance.

## Remaining acceptance gates

1. Finish work-account Google Cloud verification and create separate local/production OAuth clients. Test first login, return login, cancellation, sign-out/revocation, avatar and account settings with the authorized personal Google account.
2. Finish E2B credential/billing setup, build environment-specific browser/workspace templates, then verify real commands, browser actions, profile persistence, pause/resume and restart locally.
3. Configure development Composio consent and signed HTTPS event delivery. Test Gmail and Calendar connection, account-bound reads, marked test events, durable processing and reconnect. Verify the remaining supported app consent returns.
4. Connect a dedicated development Telegram bot with an explicitly verified numeric sender ID; test webhook registration, inbound message, assistant reply and duplicate/restart handling. One-time sender pairing is not implemented.
5. Repeat two-account isolation across HTTP/SSE, data, files, integrations, approvals, schedules and computers using real provider resources.
6. Complete Cloudflare credentials/resources, private R2, production secrets and repository CI/CD configuration. Deploy only after local acceptance, then repeat the live journey and restart checks in production.
7. Invite Albert and Johan after their addresses are supplied and verify membership in the relevant projects.

The passing tests do not yet justify a public production-ready claim. A successful deployment health check alone will not complete this acceptance record.
