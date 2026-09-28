# Unattended production reminder — 2026-09-28

One synthetic web reminder completed on production release `b6cb6ba535b85d2f3ae306896a515a0ec7a33452` while all observed Sidekick clients were closed. This uses the Cloudflare computer configuration and the fresh account created after the [production reset](2026-09-28-production-reset.md).

The ordinary chat composer created one one-off schedule for 04:04 UTC, or 05:04 Europe/Lisbon. Its creation task succeeded before the in-app browser and native Arc Sidekick tabs were closed at 04:00:54 UTC. No further authenticated application requests, schedule edits, deployments or user messages were initiated during the closed-client window. A read-only SQL observer followed the exact owner, source message, schedule revision, original delayed job and resulting task. Anonymous release health checks ran before closure and after the final duplicate-observation window, not during scheduled execution.

## Observed result

- The original scheduled job started 0.260 seconds after its due time. The background task succeeded and persisted the exact requested reminder 5.711 seconds after due. These are one-run timings, not a delivery guarantee.
- There was one owned execution-history entry, one assistant task and one saved chat reminder. The one-off schedule disabled itself and cleared its next occurrence and job reference. Another 62 seconds of observation found no duplicate delivery.
- The conversation revision and saved preference rows stayed unchanged. Explicit schedules run independently of automatic event/review quiet-hours suppression.
- The unchanged release passed health before and after observation. Reopening the app showed the saved reminder; Schedule history displayed **Finished**.
- The exact original task checkpoint was downloaded through the authorized Cloudflare storage UI. Offline verification matched one `send_message` call to its pending intent, completed receipt and successful result, with no other tool calls, foreign reply target or unresolved receipt.

The first observer missed the request because the editor serialized an underscore as Markdown escaping. A bounded read-only diagnostic identified the existing successful creation task and schedule. A continuation matched that exact serialized text and the original IDs, baseline and ingress window; it did not submit another request. Original failure evidence was retained. A separate offline timing correction preserved milliseconds lost when PostgreSQL `Date` objects were implicitly converted to strings in the first summary.

## Scope

Browser closure and the absence of operator-initiated application requests are operator-attested; SQL independently found no new user message after closure. This establishes unattended one-off dispatch and persisted web delivery with the hosted runtimes available. It does not isolate Cloudflare Cron wake from the running gateway's recovery loop, prove cold-start or restart recovery, test recurrence or a second owner, verify push/human receipt, or establish E2B, Gmail, Slack or Telegram delivery.

Private observer snapshots, original checkpoint bytes, hashes, receipt verification and UI captures remain outside Git. The disabled synthetic schedule and its history remain on the test account. See the [deployment acceptance](2026-09-28-event-stream-recovery.md#dated-production-acceptance) and [verification guide](../../verification.md) for other scoped results.
