# Production signup, downloads and streaming — 2026-09-28

The historical checks below exercised release `cfe9bb3defa3c29107a7503d3a85192eecf728ca` at `https://sidekick.n8n-maintenance.workers.dev`, using the Cloudflare computer adapter. Manual deployment and exact-release health passed. [CI run 36364873045](https://github.com/n8n-io/sidekick/actions/runs/36364873045) passed all three jobs for that commit. These checks do not validate subsequent source changes.

The [production reset](2026-09-28-production-reset.md) completed before this check. One fresh authorized work account and its activity are subsequent data, separate from the verified empty reset state.

## 2026-09-28 automatic deployment of e1d9e5d

Main merge `e1d9e5d38a0ae796e7c5bad847f417edb6a94cb1` passed [CI run 36370336653](https://github.com/n8n-io/sidekick/actions/runs/36370336653) and its automatic `workflow_run` [production deployment 36371062842](https://github.com/n8n-io/sidekick/actions/runs/36371062842). The deployment published the release and completed at 02:57:35 UTC; exact-release health and authorization boundaries passed at 02:57:33.520 UTC. The workflow verified images, rollouts and status. An optional independent registry-manifest readback failed at `registry-images` because of local Docker registry authentication, so it adds no independent image-verification evidence.

Public health returned 200 for the exact release. A read-only observer confirmed one ordinary owned chat task succeeded, with one delta frame and a persisted reply; the real UI displayed that reply after reload. Existing IAB and native Arc tabs remained at Reconnecting across the rollout, and reloading restored them. This establishes post-deployment chat, not seamless connection recovery. The later [event-stream recovery follow-up](2026-09-28-event-stream-recovery.md) records a successful automatic main deployment and fresh chat in clients kept open without reload, separately from its local HTTP 503 reproduction. Private observation and screenshot evidence remain outside Git.

## 2026-09-28 follow-up on f79924a

Release `f79924aec7c045628f95cdd95bc351b95d6706dd` passed manual deployment from 02:12:18 to 02:15:10 UTC, including natural drain, image rollout and authorization/health checks. The local suite passed 1,326 tests total: 1,323 passed, three native-only skips and zero failures; root checks and build passed, as did 19 focused metadata tests. [PR #5](https://github.com/n8n-io/sidekick/pull/5) subsequently merged as `e1d9e5d` after all CI jobs passed: 1,323 app tests passed with three native-only skips, 403 Cloudflare checks passed, and the separate native suite passed 16 checks. The later automatic deployment and post-merge chat evidence are recorded above.

A fresh Notion read returned the changed fixture value, which was withheld from the prompt, and the correct page link. The read-only observer confirmed task success for the expected owner and current web channel, eight delta frames and exact-release health; the UI response matched the fixture. This establishes the scoped synthetic-page read on this release, not broad workspace access, writes or event delivery.

The public PDF recheck also succeeded: the observer confirmed terminal task success, three delta frames and one owned artifact in the correct channel on the exact release. The viewer rendered page 1. A supported browser link-download API saved 13,264 bytes with SHA256 `3df79d34abbca99308e79cb94461c1893582604d68329a41fd4bec1885e6adb4`, matching the public reference. The earlier IAB accessibility click and download-event wait timed out; that tooling path remains unverified. At 02:37:35 UTC, a normal Download-link click in native Arc, signed in to the existing work account, saved another 13,264-byte PDF with the same hash. This passed the ordinary desktop download path without replaying the task or creating another account. This public-file check did not exercise authenticated Via Verde access or the concurrent cleanup race; native fixtures cover that race. Private observer evidence, download-method evidence and screenshots remain outside Git.

## Historical 98dfa8d failure

Production `98dfa8d5b6d55ef1ef4b86dfbbf55c1cc30c36cc` passed manual deployment and all CI jobs. It continues to use separate Cloudflare browser/workspace containers. The selected E2B conversion remains pending funding, keys and live acceptance.

A Notion refresh read on this release failed on its third app call. Discovery returned a `schemaRef` requiring `COMPOSIO_GET_TOOL_SCHEMAS`; Sidekick rejected that metadata action locally, so no Notion page-get request was dispatched. The preceding execution result was 13,235 bytes, below the 18,000-byte limit, and was not omitted. This confirmed dispatch gap is separate from the earlier successful synthetic-page read and earlier empty provider searches. The later fix resolves advertised missing schemas inside the adapter; its scoped live read passed on `f79924a` above.

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
- Operator privacy-information review and the public-sharing gate. Scoped Notion and public-PDF success do not complete broader hosted acceptance.

See [production requirements](../../production.md), [provider setup](../../research/provider-account-setup.md) and the [earlier production chat record](2026-09-27-production-chat.md).
