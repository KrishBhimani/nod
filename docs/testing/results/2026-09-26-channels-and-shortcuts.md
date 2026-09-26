# Channels and contextual shortcuts — 2026-09-26

Channels now uses full-width rows for connected and available services. Telegram and WhatsApp use matching “Chat with your sidekick” descriptions. The saved identity stays readable, while Start conversation or Finish setup and the removal control stay together on the right. Narrow layouts put these controls below the identity.

Removal uses a channel-specific confirmation with Keep channel focused first. Pending removal blocks duplicate actions and hides the close control. Errors remain in the dialog for retry. Accepted removal fences old reads and returns focus to Connect. Leaving Channels aborts pending setup and removal requests; late results cannot start a new read or update the page.

Outside editable fields, Cmd/Ctrl+B toggles the sidebar or mobile navigation menu, and Cmd/Ctrl+I toggles the enabled Inspector. The composer retains bold and italic. Typing `- ` after Shift+Enter now starts a bullet list while preserving the preceding paragraph and literal code.

## Checks

- All 902 integration tests passed under Node.js 24.21.0 with disposable PostgreSQL schemas, zero failures and zero skips.
- Focused checks cover channel confirmation, retry, focus return, stale reads, cancellation, setup completion, contextual shortcuts, hard-break list creation, list continuation and Markdown round trips.
- TypeScript, import boundaries, formatting and the production build passed. The build retains its existing main-bundle size warning.
- Actual browser checks covered 1280 px desktop and 390 px phone layouts, light and dark colors, readable identities and controls, and no horizontal overflow.
- The real channel removal dialog was opened and cancelled with the keyboard. The pending Apps close control was also checked against its actual stylesheet and existing account tests; it is already hidden during the request.
- Actual keyboard input verified sidebar and Inspector toggles, mobile menu access, bold and italic without navigation, and a bullet list after Shift+Enter. The synthetic draft was cleared without sending a message.
- An independent code review found no further actionable issues in the channel lifecycle, contextual shortcuts or bullet input rule.

No live channel was removed or replaced, and no provider message was sent. Setup and removal mutations used fixtures. These checks do not establish external channel delivery or new provider authentication.

Local screenshot evidence is in the ignored `.local/evidence/channel-cards-2026-09-26` directory. The local app remains available at `http://localhost:4320/channels`.
