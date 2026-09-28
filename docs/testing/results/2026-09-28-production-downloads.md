# Production signup, downloads and streaming — 2026-09-28

The historical checks below exercised release `cfe9bb3defa3c29107a7503d3a85192eecf728ca` at `https://sidekick.n8n-maintenance.workers.dev`, using the Cloudflare computer adapter. Manual deployment and exact-release health passed. [CI run 36364873045](https://github.com/n8n-io/sidekick/actions/runs/36364873045) passed all three jobs for that commit. These checks do not validate subsequent source changes.

The [production reset](2026-09-28-production-reset.md) completed before this check. One fresh authorized work account and its activity are subsequent data, separate from the verified empty reset state.

## Current release follow-up

Production `98dfa8d5b6d55ef1ef4b86dfbbf55c1cc30c36cc` passed manual deployment and all CI jobs. It continues to use separate Cloudflare browser/workspace containers. The selected E2B conversion remains pending funding, keys and live acceptance.

A Notion refresh read on this release failed on its third app call. Discovery returned a `schemaRef` requiring `COMPOSIO_GET_TOOL_SCHEMAS`; Sidekick rejected that metadata action locally, so no Notion page-get request was dispatched. The preceding execution result was 13,235 bytes, below the 18,000-byte limit, and was not omitted. This is a confirmed dispatch gap, separate from the earlier successful synthetic-page read and earlier empty provider searches. Its source fix and live recheck remain pending.

## Historical cfe9bb3 results

| Check                          | Result and scope                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google signup and onboarding   | The real browser flow completed. A read-only locator independently bound one verified Google identity, one existing session and one derived production tenant. The observer created no session. This is one-account evidence.                                                                                                                  |
| Notion search and read         | After consent and page-level access to one private synthetic page, exact-title search and content read returned the fixture value withheld from the prompt and the correct page link. Terminal readback confirmed one owned current-conversation task succeeded with one persisted assistant reply. This establishes access to that page only. |
| Public PDF                     | The original public W3C PDF rendered in the app and downloaded successfully. Independent owned-artifact readback returned 13,264 bytes with SHA256 `3df79d34abbca99308e79cb94461c1893582604d68329a41fd4bec1885e6adb4`, matching the public reference bytes. This is public-file evidence, not authenticated Via Verde acceptance.              |
| Web text streaming             | A separate ordinary request completed after the observer repair. The stream contained eight text frames and 223 text bytes; state and history each contained the two persisted messages. Exact-release health returned 200 before and after.                                                                                                   |
| Mobile navigation and settings | At 390×844, the Goals menu included Chat, and Settings filled the viewport with the custom timezone control. This was checked on the same historical `cfe9bb3` release.                                                                                                                                                                        |
| CI                             | Root checks, PostgreSQL tests, client build, Cloudflare validation, role-image checks, native authenticated browser-download fixtures, combined E2B Docker isolation and secret scanning passed. These fixtures do not establish live E2B or Telegram behavior.                                                                                |

## Evidence boundaries

The original PDF stream observer failed because of a SQL type-comparison bug in the private harness. Its failure record was preserved. A separate post-completion read-only check established owned artifact association, successful HTTP readback and matching bytes; the browser separately established rendering and download. These checks do not reconstruct the missing PDF-stream observation. The later text observer passed after the harness repair.

The text observer saw no completion frame; persisted task success established terminal state. The SQL/HTTP observers did not inspect original tool receipts or prove external recipient delivery. The native authenticated browser and synthetic Telegram multipart fixtures remain separate from this public-PDF production check.

Earlier Notion workspace-title searches returned empty provider results. The later synthetic-page check passed after that page was explicitly shared with the existing connector; it does not establish broad workspace access or a definitive cause or general fix for the earlier empty results. The UI response matched the withheld fixture value and correct page link, and read-only terminal metadata confirmed success at 01:40:59Z. No private page title, value or identifier is included here.

Private evidence remains under `.local/cloud/production-channel-attachment-observer/` and `.local/cloud/ci-cfe9bb3-36364873045/`. No account identifiers, session credentials, private page content or provider payloads are included in this record.

## Still pending

- Live Telegram attachment delivery and fresh-account channel isolation acceptance.
- Broader Notion access and write flows, Slack demo acceptance and the requested recorded demo.
- Gmail custom OAuth repair and successful user consent.
- E2B funding, separate project keys and combined templates, live guest isolation and same-resource recovery. This release still used Cloudflare computers.
- Live acceptance of the newer download-cleanup behavior and the pending metadata-dispatch fix. Deployment and CI success do not complete broader hosted acceptance.

See [production requirements](../../production.md), [provider setup](../../research/provider-account-setup.md) and the [earlier production chat record](2026-09-27-production-chat.md).
