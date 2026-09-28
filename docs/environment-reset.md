# Resetting an environment

A full reset removes every account and its application data from one explicitly selected environment. It is an operator maintenance procedure, not the **Get started** action or `POST /api/conversation/reset`: those archive the current web conversation and preserve accounts and saved data. There is no public account-erasure endpoint or general-purpose reset CLI.

Use a dedicated database, object bucket and provider projects for each environment. Verify the exact public origin, database identity, bucket, provider project and deployed release before making changes. Never use a production reset as test-fixture cleanup.

## Preserve the installation

Keep the application deployment, database instance, authentication schema definitions, OAuth clients, model/provider keys, integration auth configurations and shared Composio webhook endpoint. Keep the encryption master key until all encrypted channel settings and provider identifiers needed for cleanup have been read privately. Do not retain a new copy of user content merely to perform a reset.

Capture a private manifest of account IDs, tenant schemas and roles, runtime generations, provider allocation IDs and object-store prefixes. Include orphaned resources in the inventory. Check that no unrelated installation shares the selected resources. Never print credentials, messages, browser profiles or provider payloads in a cleanup report.

## Close admission and stop work

For Cloudflare hosting, use the [deployment barrier](../deployment/cloudflare/README.md) to drain accepted tasks naturally and obtain exact tenant/computer stop receipts. Local process hosting, including E2B computers, has no Cloudflare deployment barrier; do not reset it until a supported natural-drain and exact-stop procedure has been documented and completed. Keep admission closed throughout deletion. Stop the gateway and prevent health checks, scheduled wakeups and anonymous session checks from restarting it during the reset; its in-memory registry must not survive the reset.

A stopped-looking dashboard row is insufficient. Confirm native process termination, settled startup and the expected generation for every tenant and computer. Unknown outcomes remain fenced. Do not clear Durable Object storage or generation guards to bypass an uncertain stop.

An unresolved historical action can prevent the normal deployment drain even after its computer has terminated. An explicitly authorized full erasure may discard that action's stored data after independently confirming physical termination of every affected runtime. Use a separate authenticated maintenance lock, preserve uncertainty until erasure, and record this as an erasure operation. Never relabel it as a clean task completion or replay the action to make a deployment check pass. Keep the failed deployment barrier closed until the old registry and user resources are gone; only then reconcile and reopen that same operation.

## Remove user resources

1. **Connected services:** while their identifiers and encrypted settings remain available, unregister each user's Otto Telegram webhook and discard queued bot updates. Verify its current webhook belongs to this installation first. Delete inventoried Composio triggers, recorded sessions, and connected or pending accounts scoped to the old owner IDs. This does not establish revocation of orphaned sessions that the installed SDK cannot enumerate. Preserve bots, messages in Telegram, Gmail contents and unrelated provider connections.
2. **Computers and files:** destroy owned E2B allocations when configured. For Cloudflare computers, stop each role and erase checkpoint manifests, retained checkpoint history and private per-owner metadata while preserving minimal revoked-generation fences. Delete completed artifacts, transcripts and computer archives, including unreferenced objects. Enumerate and abort incomplete multipart uploads through the storage provider's supported interface when available; an empty completed-object listing does not establish their absence.
3. **PostgreSQL:** confirm no tenant-role connections remain. In a bounded transaction, delete Better Auth users, accounts, sessions and verification states plus independent account settings. Drop only the exact inventoried app/jobs schemas and restricted tenant roles, failing on unexpected role dependencies. A provisioner with SET-only membership must use `SET LOCAL ROLE` for each tenant's schema drops, then restore its own role before revoking database access and dropping the tenant role. Remove channel ownership/revision records and the tenant registry for the selected environment. Preserve authentication/control table definitions and unrelated schemas.
4. **Callback authority:** erase pending OAuth callback state and remove old tenant-registry entries before reopening. Clearing authentication rows alone does not revoke hosted webhook routing. Remove obsolete developer account IDs from operator configuration where present.

The Cloudflare production bucket contains `production/<owner>/artifacts/`, `production/<owner>/sessions/` and `production/<owner>/computers/{browser,workspace}/` objects. The local hosted adapter stores private objects in tenant PostgreSQL schemas instead. Follow the selected storage/computer adapter; do not assume every deployment uses R2 or E2B.

## Verify and reopen

Verify zero authentication users/sessions/accounts/states/settings, zero old tenant/channel registry rows, no captured owner schemas or roles, no old runtime connections, and no completed user objects. Read back provider connection/webhook deletion and computer stop state. Keep a counts-only result and identify any provider-side retention or inventory limitation explicitly.

If the database connection fails around commit, keep maintenance closed and reconcile with a fresh read-only verification. Do not blindly repeat destructive SQL or assume a lost acknowledgement means rollback.

Remove temporary maintenance access and restore the exact application configuration. For Cloudflare hosting, reopen using the same signed deployment operation. Verify public health, anonymous session boundaries and rejection of old sessions. For a recording reset, leave the browser at sign-in until the authorized signup journey begins. Keep subsequent acceptance accounts and demo activity distinct from the zero-data reset evidence.

Provider backups, audit logs and retention windows are separate from live application data. Deleting a connected account does not prove historical provider logs are erased. The installed Composio SDK cannot enumerate orphaned sessions: known session IDs can be deleted, but exhaustive cleanup needs a provider-supported inventory or retention process. Do not describe a live-data reset as proof of immediate erasure from every provider backup.
