# Single-account erasure — 2026-09-29

## Scope and result

The operator authorized erasing the currently authenticated production account while preserving the other account and the installation. This is an account reset, separate from conversation reset or whole-environment deletion. Owner identifiers, credentials and user content are excluded from this record.

**The scoped live account reset completed.** Target provider records, computer metadata, completed stored objects and SQL data were removed while preserving one other account and the shared installation. The original Worker was restored, admission reopened, and the previously authenticated browser showed sign-in after reload. No new signup was performed during verification. These counts describe the reset checkpoint; subsequent signup activity is separate.

## Local validation

The private, narrowly scoped SQL/provider helpers passed **12 tests**. Disposable PostgreSQL fixtures covered a second account with preserved contents and grants, SET-only schema ownership, active target connections and leases, stale identities, unexpected dependencies, transactional rollback and committed target-only deletion. Fake provider transport covered exact ownership, historical expired attempts, direct callback separation and refusing automatic retry after an uncertain write. The final maintenance helper passed **20 tests**. These fixtures are separate from live erasure evidence.

## Confirmed production progress

Both accounts completed natural deployment drain. The temporary maintenance operation sealed admission and physically stopped the gateway. Exact target runtime/computer stop proof and unchanged survivor metadata were checked before provider deletion.

At **00:31:27 UTC**, the provider helper recorded **14 completed deletions**: eleven exact connected or pending accounts, two watches and one known session. Readback confirmed all inventoried IDs absent. Shared provider projects, auth configurations and the webhook subscription were retained. One expired direct OAuth callback had no stored grant and was excluded from Composio deletion.

A fresh read-only SQL preflight at **00:44 UTC** passed with zero target-role connections, no active target lease, a reviewed dependency closure of **706 objects** and **one protected owner**.

At **00:57:42 UTC**, separate tenant, browser and workspace metadata purges completed with all target roles still physically stopped and the survivor's clean stop preserved. The initial combined request reached Cloudflare's invocation limit during repeated stop-proof checks. Splitting the operation by role retained fresh proof before and after each purge. Minimal revoked-generation markers remain.

At **00:58:08 UTC**, the exact target prefix's **117 completed objects** were deleted, with zero remaining. Independent listing at **00:58:43 UTC** confirmed **zero objects and zero bytes** under that prefix. This does not establish absence of incomplete multipart uploads.

The scoped SQL transaction committed at **00:58:28 UTC**. Independent read-only verification at **00:58:35 UTC** confirmed the target's auth/control rows, app/jobs schemas and restricted role absent, with **one protected owner** and shared definitions preserved. Survivor identity, schema ownership and grants matched the reviewed baseline. The check did not read survivor message or file contents.

The temporary erasure lock was released at **00:58:46 UTC** using the fresh SQL attestation. The signed deployment barrier remained closed for restoration of the original Worker.

## Restoration and final verification

The original Worker was restored and attested at **00:59:05 UTC**, removing the temporary maintenance code. At **00:59:22 UTC**, the same signed deployment operation completed with admission open and one preserved survivor receipt. Production remained on release `cbbdfd29338772076b3248367bb6a671f32999ac`.

At **00:59:34 UTC**, public health, Google sign-in availability, a null anonymous session and private-route authorization checks passed. At **01:00:19 UTC**, reloading the same previously authenticated browser showed **Sign in to Otto** and **Continue with Google**. The erased session no longer opened the account; the browser was left at sign-in without creating a replacement account.

At **00:59:54 UTC**, the seven exact raw local diagnostic files belonging to this account were removed, totaling **716,137 bytes**. Metadata-only proof and unrelated archives were preserved.

## Limits

The computer metadata purge retains minimal owner/generation tombstones and revocation fences. These guard against restarting an erased generation; they are not retained chat, files or browser content. Incomplete R2 multipart uploads have not been verified absent.

Provider deletion covers the inventoried accounts, watches and known session. It does not prove erasure of orphaned provider sessions, historical logs, backups or retention copies. This verification covers live account data, not a forensic purge of every retained copy. Revoked external grants require reconnecting; restoring SQL does not restore them. See the [scoped reset procedure](../../environment-reset.md).

This reset does not prove that the underlying Via Verde failure is fixed. It erased the selected account's stored state under explicit authorization; it did not replay an uncertain action or establish successful authenticated statement retrieval and attachment delivery.
