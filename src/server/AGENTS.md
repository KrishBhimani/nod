# Server features

`composition.ts` constructs adapters and binds feature factories. `index.ts` serves the app and owns process signals. Other server modules use `../ports` and explicit dependencies; do not import vendor SDKs or concrete runtime/provider implementations.

| Work                                                          | Entry point                              |
| ------------------------------------------------------------- | ---------------------------------------- |
| Chat, uploads, media, inspector, HTTP errors                  | `app.ts`                                 |
| Local Host/Origin checks and narrow webhook exceptions        | `access.ts`                              |
| Dispatch, continuation, cancellation, revisions, workers      | `tasks.ts`                               |
| Shared schema and transactions                                | `db.ts`                                  |
| Private inspector payloads, usage, retention and redaction    | `inspector.ts`, `inspector-redaction.ts` |
| Encrypted credentials, staged forms, retries                  | `vault.ts`                               |
| Google accounts, action policy, subscriptions, event inbox    | `integrations.ts`                        |
| Action review and one-use execution                           | `approvals.ts`                           |
| Profile learning, memory, history, goals, schedules           | `personal.ts`                            |
| Notification preference schema/store                          | `preferences.ts`                         |
| Event classification, hourly review, quiet dispatch           | `triage.ts`                              |
| Messaging inbox, outbox, sender access, transport replacement | `channels.ts`                            |
| Encrypted channel setup and metadata routes                   | `channel-settings.ts`                    |

Read [API contract](../../docs/api-contract.md) before route changes and [security](../../docs/security.md) before boundary changes. The fixed local owner is not public authentication.

Create tasks/jobs and source mappings in one transaction. Preserve source IDs, channel identity, and revision checks. An ordinary reply can continue a waiting question; credentials, approvals, and ambiguous questions need their specific path. Persist waiting states and release workers. Do not replay uncertain external actions.

Bind every Google write approval to the selected owned `connectionId`. Recheck it at execution; missing or revoked accounts must fail without fallback. Keep watch intent separate from active subscriptions. Verify event owner, account, subscription, and raw signature before dispatch.

Derive personal-data provenance from persisted owned user messages, never model arguments. Automatic learning accepts only the supported matching quotes/statements; other changes require review. External event text cannot choose its own trust level.

Secure forms and channel setup send values directly to trusted services, never chat or model context. Expose status/metadata only. Polling acknowledges an update after inbox persistence; transport changes drain active delivery and recheck the current owner binding. Provider registration and local commit are separate systems.

Return fixed public errors without provider payloads or secrets. Keep schema additions compatible with existing local data. Use disposable schemas for duplicate dispatch, cancellation, restart, stale forms, account migration, and provider replacement tests; see [development](../../docs/development.md).

Inspector records are private developer data, not public error logs or telemetry. Mask and bound them before storage. Preserve task ownership, revision fencing, disabled capture, retention and combined timestamp/ID pagination. Unknown prices remain null; do not infer tool fees from model usage. Keep secure broker values outside these events.
