# Production reset — 2026-09-28

The authorized live-data reset completed at `https://sidekick.n8n-maintenance.workers.dev` before new signup acceptance or demo recording. The application release remained `ff327a744b7a9addbbd8f8cbc4bb4ce7ea58e3b6`. This is maintenance evidence, not acceptance of the pending channel/download fixes or E2B conversion.

## Verified result

| Resource           | Result                                                                                                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL         | Independent post-commit verification at 01:06 UTC found zero users, sessions, OAuth accounts/states, account settings, tenants, channel records, captured owner schemas/roles and owner connections. Authentication/control table definitions remain intact.                                   |
| Runtime state      | Both tenant processes, six current/orphan computer objects and the gateway were confirmed physically stopped before erasure. Private owner metadata, command records, checkpoint references and alarms were removed from all eight owner objects; minimal stopped-generation fences remain.    |
| R2                 | All 43 completed objects were deleted from the dedicated production bucket; the final completed-object inventory was empty.                                                                                                                                                                    |
| Remote connections | Verified removal of one Telegram webhook with queued updates discarded, four Composio accounts, two triggers and one recorded session.                                                                                                                                                         |
| Reopening          | The same failed deployment operation was reconciled to `aborted` after erasure. The exact original Worker module, bindings, assets and image configuration were restored. Health returned 200 with the original release, anonymous session returned no user, and anonymous state returned 401. |
| Browser            | The production origin displayed the Google sign-in page. No replacement account was created during reset verification.                                                                                                                                                                         |

The initial normal drain refused an unresolved historical browser action despite physical termination. A bounded authenticated maintenance operation independently verified native stop state before discarding the user-authorized data; it did not replay that action or manufacture a clean completion receipt. The temporary operator endpoint was removed with the exact original Worker restoration.

The first SQL attempt rolled back on a schema-ownership permission error. The corrected procedure used the provisioner's existing SET-only tenant memberships for schema deletion, restored the administrator for role deletion and passed a non-superuser disposable PostgreSQL regression before retry. A fresh reviewed inventory and independent post-commit read established the result above.

Development data, provider projects, OAuth clients, shared Composio webhook configuration, deployment credentials, database instance and application configuration were preserved. Telegram bots/messages and mail in Google accounts were not deleted.

## Limits and subsequent work

This removes live application data. It does not establish immediate deletion from provider backups or audit logs. Composio cannot enumerate orphaned sessions through the installed SDK, so only recorded sessions were verified. Completed R2 object enumeration does not prove absence of incomplete multipart uploads; those were not enumerated through the available Worker binding.

New production acceptance and the requested signup/integration/chat demo are subsequent activity and require separate release evidence. Production still selects the Cloudflare computer adapter. E2B remains pending separate project keys, templates, live acceptance and production funding; its Hobby concurrency limit is sufficient for the configured pilot.

See the [reset runbook](../../environment-reset.md), [provider setup](../../research/provider-account-setup.md) and [prior production chat acceptance](2026-09-27-production-chat.md).
