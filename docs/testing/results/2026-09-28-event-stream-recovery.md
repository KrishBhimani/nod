# Web event-stream recovery — 2026-09-28

A deployment can temporarily return HTTP 503 when an open page reconnects its event stream. A non-200 response makes the browser close `EventSource` permanently. Previously, the client refreshed its login state but retained that closed source, so the page could remain on “Reconnecting”. Normal EOF after a valid stream has different behavior: the browser retries it itself. [HTML processing model](https://html.spec.whatwg.org/multipage/server-sent-events.html#sse-processing-model).

The client now replaces terminal sources with one pending retry, backing off from one second to at most 30 seconds. It requires an accepted account and always includes its expected-account query, including when a caller omits the owner argument. It preserves native retries and streamed text. Account changes, sign-out and unmount cancel pending retries and fence late callbacks. Reconnection does not resubmit chat messages or agent actions.

## Automated checks

- The regression failed before the fix: no replacement source appeared after terminal closure.
- Fourteen hook regressions cover terminal recovery, native retry deduplication, backoff, retained text and revision changes, stale callbacks, unmount, account replacement, expiry, missing owner arguments, accepted local identities, and hung or superseded session refreshes.
- The focused six-file run passed 46 tests, with no failures or skips. Five identity regressions also failed before the ownership correction.
- The full local suite passed 1,337 of 1,340 tests, with zero failures and three native-only skips. The build, TypeScript, architecture and formatting checks passed.
- Independent source review found no actionable issues.

## Native browser check

A loopback-only fixture bundled the actual event subscription helper, session store and stream reducer. It used synthetic data and the browser's native `EventSource`, with no provider credentials or live accounts.

One UI action ended the healthy stream and returned HTTP 503 for eight seconds. Without a reload, the browser recorded one native `CONNECTING` error, three terminal `CLOSED` errors and three replacement sources. The fourth source opened successfully. The retained text was exactly `Before outage + after recovery`, and the fixture displayed a passing result. The fixture was stopped after capture.

This establishes local browser recovery from an actual HTTP 503. One earlier production tab had shown “Reconnecting”, but its original response was not captured; that tab alone does not prove the cause.

## Dated production acceptance

This is a fixed snapshot of the tested program and flows.

Main merge `b6cb6ba535b85d2f3ae306896a515a0ec7a33452` passed [CI run 36373289270](https://github.com/n8n-io/sidekick/actions/runs/36373289270) and its automatic `workflow_run` [production deployment 36373913856](https://github.com/n8n-io/sidekick/actions/runs/36373913856) on 2026-09-28. All three CI jobs passed: 1,337 app tests passed with three native-only skips, all 403 Cloudflare checks passed, and all 16 native download checks passed. The deployment checked out the exact tested merge, published Worker code and immutable image references, completed all container-role rollouts, and passed exact-release health and public authorization checks at 03:41:55 UTC. This was actual publication, not a superseded-run skip or manual dispatch.

The existing Codex in-app browser and native Arc clients stayed open without reload across that rollout. By 03:43:37 UTC, a fresh ordinary chat request passed: the reply streamed and persisted, and the real UI showed it. The production check did not capture `EventSource` entering `CLOSED`. This establishes usable chat in unchanged open clients after deployment; the controlled local fixture above supplies the specific terminal-503 recovery proof. Saved terminal workflow JSON, private observer evidence and screenshots support these results and remain outside Git.

An earlier production UI check on `6f717320386d364dd18b57dffe6d0659bf3c02e2` used a 390×844 viewport. Keyboard activation opened the mobile menu, navigation returned from Goals to Chat, and full-height profile, preferences and theme-preview settings were observed. Pointer activation through the test tooling did not produce a transition, so mobile pointer/touch operation is not established. In desktop Arc, Cmd+, opened Settings and timezone search filtered the expected result; it was dismissed without changing the selection. No account setting changed, and the viewport was restored.

Production still uses the Cloudflare computer adapter. E2B funding, key authorization and live acceptance; Gmail OAuth repair; Telegram delivery; Slack consent, the complete demo and video delivery; and the operator privacy/public-sharing gate remain pending. See the [production download and integration record](2026-09-28-production-downloads.md) for earlier scoped Notion/PDF results and the [verification guide](../../verification.md) for other checks.
