# Chat and sign-in review — 2026-09-26

This pass follows reported message flicker, misplaced actions, missing direct browser input, failed second-account consent and staged website sign-in. The live website check used separate PostgreSQL schemas and temporary workspace/browser containers. Passwords remained in the encrypted test Vault. No business record was opened and no account setting was changed.

## Reproduced defects

- The runtime ended a text stream before its queued saved reply arrived. The web client then removed the streaming component and mounted another component for the saved message. Completed updates before tools were also discarded. Safe completed foreground updates now persist, and the same stream identity remains through the saved-message handoff.
- Sending a message scrolled after paint and reset the history-control state. Scrolling now runs before paint and sending preserves existing history controls and the composer.
- The browser image forwarded clicks but had no keyboard, paste, composition or wheel handlers. Input now uses the focused image surface, a bounded ordered queue and the existing private owner/revision-bound route. Shift-Escape returns focus to controls.
- Composio rejected consent creation from a session pinned to an existing Gmail account with code 4309. Consent now uses a temporary unpinned session. Live initiation returned HTTP 200 and opened Google's account chooser after the temporary session was deleted. The existing account remained unchanged; a second OAuth grant was not completed.
- An idle CONNECT timeout destroyed its upstream socket without closing Chromium's side. Synthetic direct and chained tunnels reproduced the dangling connection. Both sides now close on unexpected termination; a slow-reader regression verifies that graceful completion still flushes the full response. Fixture shutdown also drains pending and established tunnels.
- Observation and capture preflight calls lost cancellation signals. The pinned browser CLI also resent the same command after its 30-second read timeout. Warm commands now use one private socket request with an absolute deadline. An interrupted operation keeps the queue fenced until close is acknowledged. Initial browser launch still uses the native CLI.
- An uncertain private input request lost its local rejection guard when a blur or screen suspension changed the handler generation. Failed input now blocks that exact lease across suspension, while another task or newer lease remains usable; Done is still available.
- TOConline's Portuguese `Entrar` control was absent from the trusted submit detection. Its six single-digit verification boxes were also unsupported. Both layouts now work through the secure broker. Rejected-code retry clears the entire validated group before input events, preventing mixed old/new codes. A collapsed or changed group is rejected before entry.
- Collecting each OTP digit as a global redaction value corrupted unrelated page numbers and browser references. Grouped values and accessibility field-value masking now hide entered digits while keeping unrelated text and actionable references intact.

## Live TOConline result

The initial attempt did not establish sign-in. Its inspection found email and password fields without a submit selector, and a later observation stalled. The network and cancellation defects above were reproduced separately; the trace does not isolate one cause for that stall.

After updating only the temporary browser worker, a fresh task reused the saved credential and reached the actual email-code stage. The user submitted the code in the already-open secure step. The final website observation contained both code-validation success and `Autenticação efetuada com sucesso`. The task stopped at that confirmation. It did not inspect business records or change settings.

The repaired request was accepted at 11:14:31 UTC, reached code entry at 11:14:47, resumed after code submission at 11:15:15 and finished at 11:15:17. These are one local test's observed times, not a performance guarantee. The separate chat-code and connected-inbox changes were requested after this successful form-based check; their evidence must be reported separately.

## UI observations

At 1280 pixels, the user bubble ended at the conversation's right boundary. Its actions were 10 pixels to its left. The timestamp was inside the bubble at 10 pixels. The running dark-theme view was inspected directly. The production build was also checked at 390 × 844 pixels in both themes. Mobile keeps Chat and a top-right menu; its pages, theme, Inspector and Restart setup fit without horizontal overflow. Clicking outside closes the menu. The desktop Vault shortcut opened the page with Cmd+K; production More exposes Inspector and Restart setup while the direct development controls remain separate.

## Current app-to-container acceptance

A fresh disposable harness mounted the current source into both temporary containers so the worker and Docker command bridge used the same input protocol. In the actual production UI, Take control forwarded a click, typed text, Cmd+A, pasted text, a final key and Enter to Chromium. The synthetic page confirmed the exact value with `Manual input accepted: MANUAL-741`. Shift-Escape focused Done; Done restored the ordinary browser view. Event fixtures separately cover composition, wheel input, queue bounds, focus loss and stale sessions.

The same app/model/container run opened the synthetic login page, collected one email/password pair in a private form, requested the code in chat, and reached the Northstar account page. The code reply immediately appeared as `Verification code sent securely.` and retained that form after reload. The completed assistant reply remained visible after refresh. A read-only audit of the exact disposable schemas found no plaintext password or code across all tables, including seven messages, 24 task events, 20 Inspector records and four prompt snapshots. The 34 agent records and 29 timing records also had no match. Exactly one masked code receipt was stored. The task succeeded 3.023 seconds after that receipt. This establishes the new chat-code flow with a synthetic website, not a live email-code lookup or real Google/X authentication.

Validation and publication results are recorded in [verification](../../verification.md). Live website authentication, live consent initiation, synthetic inbox fixtures and UI event fixtures remain distinct evidence.
