# Server features

`composition.ts` constructs providers and binds features. `index.ts` serves the web app and owns process signals. Neither provider SDKs nor runtime implementations belong in other server modules; use the types in `../ports` and explicit factory arguments.

| Work                                                       | Entry point       |
| ---------------------------------------------------------- | ----------------- |
| Chat, uploads, media, inspector and HTTP errors            | `app.ts`          |
| Durable dispatch, cancellation, task revisions and workers | `tasks.ts`        |
| Schema and transaction helper                              | `db.ts`           |
| Credential encryption, secure forms and continuation       | `vault.ts`        |
| Google connections, approval policy and event inbox        | `integrations.ts` |
| Action review and continuation                             | `approvals.ts`    |
| Profile, goals, history and recurring schedules            | `personal.ts`     |
| Quiet event checks and hourly reviews                      | `triage.ts`       |
| Messaging inbox, outbox and delivery policy                | `channels.ts`     |

Read [API contract](../../docs/api-contract.md) before route changes and [security](../../docs/security.md) before boundary changes. The local owner is fixed; do not infer a public multi-user boundary from owner columns.

Create task/job records in the same PostgreSQL transaction. Fence writes and continuation with the task revision. Persist waiting states and release workers. External actions with uncertain outcomes need review; do not auto-replay them. Provider errors returned to clients must be fixed public messages, with no raw payloads or secrets.

Use disposable schemas in the matching `../../tests` fixture. Test duplicate dispatch, cancellation and restart for changes to durable work. Keep schema additions compatible with existing local data and test any table rename or provider reference migration.
