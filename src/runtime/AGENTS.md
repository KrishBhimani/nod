# Agent runtime

`index.ts` exports `createAgentRuntime({agent,computer,workspace,chooseBrowserAction?})`. Its methods are `runTask`, `status` and `dispose`. Runtime lifecycle, tool validation, budgets, prompt construction and waiting states belong here. Concrete SDKs and provider configuration belong in `../providers` and server composition.

Interfaces live in `../ports/agent.ts` and `../ports/computer.ts`. A model session receives only registered tools. Keep provider types out of those interfaces. Never add a host shell, arbitrary browser JavaScript or secret-read tool.

A credential or approval request ends the current execution segment. Stop further tools in that segment, persist the provider transcript and allow a fresh segment to continue. Background events suppress streamed prose and automatic final replies. User-facing messages require an explicit useful message or necessary question.

Give each streamed model message its own ID and close it at message end. Persist that ID with the delivered final reply. Task IDs alone cannot distinguish consecutive messages.

Use `../../tests/runtime-fixtures.ts` for substitute capabilities. `runtime-session`, `runtime-adapters` and `pi-agent` tests separate product runtime behavior from SDK-specific persistence. `application-adapters.test.ts` proves a substitute stack through HTTP and durable workers.
