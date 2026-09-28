# Browser download completion — 2026-09-28

## Main CI failure

Main revision `5970b162da04c984467152e2ede1748f9422b2c4` failed [CI run 36378144449](https://github.com/n8n-io/sidekick/actions/runs/36378144449). Root integration checks passed **1,337 tests with three native-only skips**, and Cloudflare checks passed **403/403**. The separate native browser run passed **13/14** tests; its private-bridge PDF test failed after 9.216 seconds with an acknowledged `unavailable` response. The failing action within that test was not recorded. The runtime publication, owned HTTP delivery and synthetic Telegram multipart suite passed before it.

The automatic [production workflow 36378708361](https://github.com/n8n-io/sidekick/actions/runs/36378708361) was skipped because CI failed. This revision was not published by that workflow. Private logs and aggregate results remain under `.local/cloud/merged-release-5970b162-20260928/`.

## Controlled native reproduction

A separate controlled fixture reproduced a completion race: an ordinary browser click returned while `invoice.pdf.crdownload` still existed. An immediate download request without a selector or URL found no completed file and failed with “Choose the specific download link or URL.” The private bridge returned the same fixed public browser-action error seen in CI.

Unchanged isolated and combined local native runs passed. The controlled reproduction establishes a real completion race, but does not identify the exact action or cause of the original CI failure.

The held-response regression verifies the page's `document.contentType` inspection while the download body remains held. With the original no-target selection path restored, native attempt 05 failed this check. The implementation passed native attempt 06 with **27/27 tests and no failures or skips**. Private evidence remains under `.local/cloud/browser-download-ci-5970-diagnosis/`.

## Implementation and local validation

For a non-PDF page, a download request without a selector or URL now waits up to five seconds for one already-requested file to finish. The wait only reads the task's download directory; it does not click again or repeat the network request. It observes cancellation, rejects ambiguous files, replaced directories and unsafe file entries, and retains the 12 MiB limit.

The full local aggregate passed **1,347 of 1,351 tests, with four native-only skips and zero failures**, in 122.827 seconds. The production build and type/import/format checks passed. This aggregate began before the final test-only observed-scan barrier and cancellation-assertion refinements. The final focused browser-download file then passed **14 of 17 tests, with three native-only skips and zero failures**, under Node.js 24.21.0. Those refinements did not change the runtime or the native held-response handshake validated by attempt 06.

## PR validation and rollout boundary

[PR #8](https://github.com/n8n-io/sidekick/pull/8) revision `ff6017fc1ee6fb859269873512cccdb9f2b79366` passed all three jobs in [CI run 36380262444](https://github.com/n8n-io/sidekick/actions/runs/36380262444). Root integration checks passed **1,347 of 1,351 tests with four native-only skips**, Cloudflare checks passed **403/403**, and native browser delivery passed **27/27**.

Three review corrections then normalized filesystem failures to fixed messages, made the held-response fixture release idempotent, and bounded its scan waits while propagating early rejection. The corrected local tree passed **1,347 of 1,351 integration tests with four native-only skips and zero failures**, plus build and type/import/format checks. Its separate native run passed **27/27**. These are local receipts for the corrections, not an exact-head CI result for them.

The manual deployment did not complete: the workspace application LIST reported version 9 while DETAIL reported version 10, causing Wrangler to skip the rollout as unchanged. Deployment verification refused completion and admission remained closed. A guarded image-only workspace rollout corrected that mismatch without changing the original deployment identity or bypassing any fence. After refreshing short-lived registry pull credentials, the standard all-role verification and public smoke passed; the original operation reopened admission at **05:22:22 UTC**. This establishes deployment recovery, not authenticated production acceptance of the download change. Subsequent receipts belong to the PR and its workflow runs.

Earlier successful public-PDF production checks remain dated separately in the [production download record](2026-09-28-production-downloads.md).
