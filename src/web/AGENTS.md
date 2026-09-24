# Web interface

`app.tsx` owns navigation; `pages` owns route views; `components` owns controls and the shared shadcn-style primitives in `ui.tsx`. `styles.css` owns the n8n palette and layout. Use `lib/api.ts` for HTTP and `../shared/contracts.ts` for wire types.

Keep chat concise and central. Profile, goals, schedules and memory are on `/you`; secure credentials and approvals use separate routes. Development events and browser screenshots belong on `/dev`. Provider setup details do not belong in user conversations.

The browser must not import server, runtime, ports or provider code. `hooks/use-app-state.ts` refreshes persisted state and uses `lib/streams.ts` for transient deltas. Reconcile by stream ID, not task ID; stale refreshes must not erase a later message. `lib/schedules.ts` preserves wall-clock time and custom cron expressions during edits.

Read [API contract](../../docs/api-contract.md) for server behavior. Reuse existing controls before adding dependencies. Validate changed flows in the real local app, including error and waiting states. Synthetic browser or reducer fixtures do not prove a live account connection.
