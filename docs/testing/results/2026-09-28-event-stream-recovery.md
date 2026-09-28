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

This establishes local browser recovery from an actual HTTP 503. One existing production tab had shown “Reconnecting”, but its original response was not captured; that tab alone does not prove the cause. Production release and account checks remain separate from this controlled fixture and are tracked in the [verification guide](../../verification.md).
