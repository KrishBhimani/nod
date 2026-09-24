# Web interface

`app.tsx` owns navigation and the inspector layout. `pages` owns views, `components` owns shared controls, and `styles.css` owns the palette/layout. Use `lib/api.ts` for HTTP and `../shared/contracts.ts` for wire types. The browser must not import server, runtime, ports, or provider code.

The sidebar contains Chat, Goals, Schedule, Connections, Channels, and Vault. `pages/plans.tsx` renders goals/schedules. Personal context and setup are conversational; there is no separate profile page. Credential and approval links open dedicated forms. The inspector opens beside chat; `/dev` opens it directly.

Keep conversation central and quiet. Preserve working state, timestamps/date history, reactions, file/image attachments, and task choice for ambiguous replies. `components/message.tsx` renders Markdown with sanitized embedded HTML; keep URL checks and local-link handling in `lib/message-links.ts` and `lib/markdown.ts`. Do not allow raw unsanitized HTML or arbitrary remote image loading. `composer.tsx` handles pasted images and files; there is no microphone recording control. Speech playback is an optional message action.

`hooks/use-app-state.ts` refreshes persisted state and `lib/streams.ts` handles deltas. Reconcile by stream ID, not task ID; stale refreshes must not erase a later message. `lib/schedules.ts` preserves wall-clock times and custom cron expressions.

Connections uses local service logos and verified account labels when available. Scope disconnect/watch actions to a connection ID. Show requested watches separately from active delivery. Channels sends setup secrets only through its secure server endpoint and shows honest polling/webhook state. Never restore credentials into a form from status responses.

Secure form values stay out of URLs, local storage, chat, and logs. Clear them after submission. Preserve expired/retry, staged login, and unsupported-method states. Inspector refresh must pause during secure work and distinguish live, last-known, and unavailable images without hiding chat.

`components/inspector-tools.tsx` owns the Tools inspector tab; `lib/inspector-observations.ts` owns its filtering, pagination merge, and display formatting. Use `shared/inspector.ts` DTOs for the current registered-tool catalog and selected task recordings. Render tool inputs, outputs, errors, and schemas as escaped text, never HTML or Markdown. Keep old tasks without recordings distinct from zero cost. Label recorded assistant model costs as SDK estimates in USD. Compaction, cache warming, speech, browser-provider, other tool/provider fees, and hosting are excluded. Use "Price unavailable" when no estimate exists. Calls and usage share a cursor; merge both by ID, preserve loaded older pages during refresh, catch up any gap between pages, and refresh loaded calls that are still running. Use server totals rather than visible-row totals. Model requests associate with a task revision, not an individual tool charge.

Read [API contract](../../docs/api-contract.md) before changing requests. Reuse existing controls. Validate changed flows in the local app at desktop/narrow widths, including waiting/error states. Fixtures and configured labels do not prove live OAuth, login, or channel delivery.
