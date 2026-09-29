# Resetting accounts and environments

A full reset removes every account and its application data from one explicitly selected environment. A single-account erasure removes one explicitly selected account and preserves every other account. Both are operator maintenance procedures, distinct from the **Get started** action or `POST /api/conversation/reset`: those archive the owner's current thread and preserve accounts and saved data. There is no public account-erasure endpoint or general-purpose reset CLI.

Use a dedicated database, object bucket and provider projects for each environment. Verify the exact public origin, database identity, bucket, provider project and deployed release before making changes. Never use a production reset as test-fixture cleanup.

## Select the scope

For one account, resolve the owner UUID from the authenticated account and require a unique match in the authentication database. Pin its tenant schemas, restricted role, runtime generation, provider identifiers and object prefix. Record the other owners' identities, schema ownership, grants and shared definitions as a preservation baseline. Refresh the inventory after work drains; an identity or dependency change requires a new review.

Every deletion must match the pinned owner and environment. Never use a full-table truncate, whole-bucket purge or whole-environment helper for a single-account erasure. Keep the other accounts stopped naturally during maintenance, with their data intact, and preserve their deployment receipts when removing the erased owner's receipt.

## Preserve the installation

Keep the application deployment, database instance, authentication schema definitions, OAuth clients, model/provider keys, integration auth configurations and shared Composio webhook endpoint. Keep the encryption master key until all encrypted channel settings and provider identifiers needed for cleanup have been read privately. Do not retain a new copy of user content merely to perform a reset.

Capture a private manifest of account IDs, tenant schemas and roles, runtime generations, provider allocation IDs and object-store prefixes. Include orphaned resources in the inventory. Check that no unrelated installation shares the selected resources. Never print credentials, messages, browser profiles or provider payloads in a cleanup report.

## Close admission and stop work

For Cloudflare hosting, use the [deployment barrier](../deployment/cloudflare/README.md) to drain accepted turns naturally and obtain exact tenant/computer stop receipts. Local process hosting, including E2B computers, has no Cloudflare deployment barrier; do not reset it until a supported natural-drain and exact-stop procedure has been documented and completed. Keep admission closed throughout deletion. Stop the gateway and prevent health checks, scheduled wakeups and anonymous session checks from restarting it during the reset; its in-memory registry must not survive the reset.

A stopped-looking dashboard row is insufficient. Confirm native process termination, settled startup and the expected generation for every tenant and computer. Unknown outcomes remain fenced. Do not clear Durable Object storage or generation guards to bypass an uncertain stop.

An unresolved historical action can prevent the normal deployment drain even after its computer has terminated. An explicitly authorized account or environment erasure may discard that action's stored data within the approved scope after independently confirming physical termination of every affected runtime. Use a separate authenticated maintenance lock, preserve uncertainty until erasure, and record this as an erasure operation. Never relabel it as a clean turn completion or replay the action to make a deployment check pass. Keep the failed deployment barrier closed until the selected registry entries and user resources are gone; only then reconcile and reopen that same operation.

## Remove user resources

1. **Connected services:** while their identifiers and encrypted settings remain available, unregister each selected user's Otto Telegram webhook and discard queued bot updates. Verify its current webhook belongs to this installation first. Delete inventoried Composio triggers, recorded sessions, and connected or pending accounts scoped to the selected owner IDs. Recheck ownership before each deletion and confirm absence afterward. Direct OAuth callback records are not Composio accounts; follow their adapter's revocation path. This does not establish revocation of orphaned sessions that the installed SDK cannot enumerate. Preserve bots, messages in Telegram, Gmail contents and unrelated provider connections.
2. **Computers and files:** destroy owned E2B allocations when configured. For Cloudflare computers, stop each role and erase checkpoint manifests, retained checkpoint history and private per-owner metadata while preserving minimal revoked-generation fences. Delete completed artifacts, transcripts and computer archives, including unreferenced objects. Enumerate and abort incomplete multipart uploads through the storage provider's supported interface when available; an empty completed-object listing does not establish their absence.
3. **PostgreSQL:** confirm no selected tenant-role connections or live leases remain. In a bounded transaction, delete only the selected Better Auth users, accounts, sessions and independent account settings. Drop only the exact inventoried app/jobs schemas and restricted tenant roles, failing on external schema dependencies or unexpected role grants, memberships and settings. A provisioner with SET-only membership must use `SET LOCAL ROLE` for each tenant's schema drops, then restore its own role before revoking database access and dropping the tenant role. Remove only the selected owners' channel ownership/revision records and tenant registry entries in the selected environment. Preserve authentication/control table definitions and unrelated rows, grants and schemas. Better Auth verification state has no reliable owner field: for a single-account erasure, require it to be empty or establish a separately reviewed ownership mapping; never delete it broadly. A full-environment reset may remove all verification state from its dedicated authentication schema.
4. **Callback authority:** erase pending OAuth callback state and remove old tenant-registry entries before reopening. Clearing authentication rows alone does not revoke hosted webhook routing. Remove obsolete developer account IDs from operator configuration where present.

The Cloudflare production bucket contains `production/<owner>/artifacts/`, `production/<owner>/sessions/` and `production/<owner>/computers/{browser,workspace}/` objects. The local hosted adapter stores private objects in tenant PostgreSQL schemas instead. Follow the selected storage/computer adapter; do not assume every deployment uses R2 or E2B.

## Verify and reopen

Verify zero selected authentication users/sessions/accounts/settings, zero selected tenant/channel registry rows, no captured owner schemas or roles, no selected runtime connections, and no completed objects under the selected prefixes. A full-environment reset also verifies zero authentication verification states; a single-account erasure verifies the reviewed handling of shared state and unchanged protected owner identities, schema ownership, grants and shared definitions. Read back provider connection/webhook deletion and computer stop state. Keep a counts-only result and identify any provider-side retention or inventory limitation explicitly.

Record deletion intent before each external operation and SQL commit. If a provider response or database connection fails around a write, keep maintenance closed and reconcile with a fresh read-only verification. Do not blindly repeat destruction or assume a lost acknowledgement means rollback. Restoring SQL does not restore revoked provider grants; those require reconnecting.

After live erasure succeeds, remove exact local raw diagnostics created for the selected account, identified by their recorded owner and purpose. Preserve metadata-only verification and unrelated archives. Do not copy user content into the verification record.

Remove temporary maintenance access and restore the exact application configuration. For Cloudflare hosting, reopen using the same signed deployment operation. Verify public health, anonymous session boundaries and rejection of old sessions. For a recording reset, leave the browser at sign-in until the authorized signup journey begins. Keep subsequent acceptance accounts and demo activity distinct from the zero-data reset evidence.

Provider backups, audit logs and retention windows are separate from live application data. Deleting a connected account does not prove historical provider logs are erased. The installed Composio SDK cannot enumerate orphaned sessions: known session IDs can be deleted, but exhaustive cleanup needs a provider-supported inventory or retention process. Do not describe a live-data reset as proof of immediate erasure from every provider backup.

The [2026-09-29 single-account erasure record](testing/results/2026-09-29-owner-erasure.md) separates local fixture coverage, verified production deletion, survivor preservation and provider retention limits.
