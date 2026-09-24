# Agent runtime

`index.ts` exports `createAgentRuntime({agent,computer,workspace,chooseBrowserAction?})`. Its methods are `runTask`, `inspectTools`, `status` and `dispose`. Runtime lifecycle, tool validation, budgets, prompt construction and waiting states belong here. Concrete SDKs and provider configuration belong in `../providers` and server composition.

`tools.ts` owns tool names, descriptions and schemas. Sessions and `inspectTools` use that same catalog. Inspection must not open a workspace, browser or model session. Include the optional browser chooser tool only when the factory received that capability.

`RuntimeContext.observe` receives paired tool starts and ends, with validated arguments, actual outputs, fixed errors and timing, plus provider-normalized model usage. `observations.ts` bounds each write to one second and disables capture for the remaining segment after a timeout. The optional `observationTimeoutMs` factory argument can shorten that limit. Cancellation releases waits immediately; cancelled tool ends and queued or late model usage use nonblocking best-effort delivery. A timeout still disables later usage capture, so totals can be partial. Late callback failures remain handled. Flush only the bounded queue when a segment ends. Server persistence still owns query timeouts, redaction, limits, task revision checks and developer access. Raw tool values can contain private content; do not send them to ordinary logs or chat.

Interfaces live in `../ports/agent.ts` and `../ports/computer.ts`. A model session receives only registered tools. Keep provider types out of those interfaces. Never add a host shell, arbitrary browser JavaScript or secret-read tool.

A credential or approval request ends the current execution segment. Stop further tools in that segment, persist the provider transcript and allow a fresh segment to continue. Background events suppress streamed prose and automatic final replies. User-facing messages require an explicit useful message or necessary question.

Give each streamed model message its own ID and close it at message end. Persist that ID with the delivered final reply. Task IDs alone cannot distinguish consecutive messages.

Use `../../tests/runtime-fixtures.ts` for substitute capabilities. `runtime-session`, `runtime-adapters` and `pi-agent` tests separate product runtime behavior from SDK-specific persistence. `application-adapters.test.ts` proves a substitute stack through HTTP and durable workers.
