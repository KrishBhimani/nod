# Local verification — 2026-09-24

This records the local prototype checks after provider extraction. Synthetic fixtures and live-account checks are distinct. No repository push, public deployment or new paid plan was part of this run.

## Automated checks

- `npm run check`: TypeScript, import boundaries and repository formatting passed.
- `npm run test:integration`: 93 checks passed, zero skipped, using disposable PostgreSQL and pg-boss schemas.
- `npm run build`: production web bundle passed.
- `git diff --check`: passed.
- Dependency audit: zero reported vulnerabilities at installation.
- Source and client-bundle scan: no matches for the configured private credential values.

The full application substitute test uses the real HTTP routes, queue, runtime and persistence with replacement agent, computer, workspace, speech, Google and key-store adapters. A separate messaging test substitutes transport without Chat SDK. Fixtures cover action approval, memory provenance, secure credential continuation, stale forms, revocation, interrupted work, delivery ambiguity and stream reconciliation.

## Live local checks

| Flow                             | Observed result                                                                                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent chat and browser work | Short chat completed in about 1.4 seconds while browser work continued; browser task completed in about 8.2 seconds. These are individual local observations, not a benchmark.                                          |
| Browser text and artifact        | Read the actual body paragraph on example.com, saved it, and downloaded the matching text file.                                                                                                                         |
| Developer browser view           | Inspector returned a valid PNG from that task's browser. This is browser observation, not native Mac control.                                                                                                           |
| Attachment-only message          | Existing synthetic red image was accepted without text; the live model described it correctly.                                                                                                                          |
| Speech                           | Generated audio through OpenAI, downloaded it and transcribed it back successfully. No microphone recording was made.                                                                                                   |
| Credential key source            | Saved a randomly generated synthetic password using macOS Keychain, confirmed metadata did not contain plaintext, then removed the test entry. Live website sign-in and OTP entry remain separate from broker fixtures. |
| Google                           | Existing Gmail and Calendar connections survived migration. Live Gmail tool discovery and `GMAIL_LIST_LABELS` returned without error. Calendar actions were not tested.                                                 |
| Goals                            | Created a synthetic goal, edited progress/next action, paused it and verified persistence after restart. Removed the test row afterward.                                                                                |
| Schedules                        | Created a weekly routine in Europe/Lisbon, paused/resumed it and deleted it through the web interface. No recurring test schedule remains.                                                                              |
| Memory and approval              | Agent proposed a synthetic memory, web approval completed, the task resumed and the stored source matched its originating user message. Reloaded after restart, then removed the memory through the web UI.             |
| Private application files        | Requests for `.env` and provider source returned 403.                                                                                                                                                                   |
| Lifecycle                        | One-command startup brought up the local stack. A server stop with an open web session completed cleanly after explicit event-stream and Vite teardown.                                                                 |

Live checks found and fixed a Composio SDK validation failure caused by absent auth-config overrides represented as `undefined`. Protocol tests now exercise the actual SDK validation path; passing only an adapter fake had not caught it.

## Still requiring setup or additional implementation

Anthropic, Jev, live Telegram/WhatsApp delivery, Google Drive/Docs/Sheets consent, external Google event delivery and real website credential/OTP flows are not live-verified. Chat SDK supports the implemented optional text channels; channel media remains in the web app. iMessage, native desktop control, payment-card storage and public multi-user authentication are not implemented. See [production requirements](production.md), [channels](channels.md) and [vault boundaries](vault.md).
