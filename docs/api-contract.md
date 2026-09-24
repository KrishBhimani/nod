# Internal API contract

All routes use the same localhost origin and the development account. JSON error responses have `{error: string}`. Browser mutations require same-origin Origin checks. The public URL and non-loopback requests are disabled until real authentication is implemented.

| Method     | Path                                                     | Shape                                                                                                                     |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| GET        | /api/state                                               | AppState                                                                                                                  |
| POST       | /api/messages                                            | `{text, attachmentIds?: string[], taskId?: string, forceNew?: boolean}` -> `{taskId}`                                     |
| GET        | /api/messages                                            | `before?: ISO timestamp, beforeId?: UUID` -> up to 60 messages in chronological order                                     |
| POST       | /api/messages/:id/reaction                               | `{reaction: 'like' or 'dislike' or 'heart' or null}`; owned assistant messages only                                       |
| GET        | /api/tasks/:id                                           | owned Task, including tasks outside the recent state window                                                               |
| POST       | /api/onboarding                                          | `{timeZone?: string}` -> `{taskId}`; supersedes only prior tagged onboarding work                                         |
| GET        | /api/events                                              | SSE `{type:'refresh'}` or `{type:'delta',taskId,text,streamId?,done?}`                                                    |
| POST       | /api/tasks/:id/cancel                                    | `{ok:true}`                                                                                                               |
| POST       | /api/uploads                                             | multipart file -> Artifact                                                                                                |
| GET        | /api/artifacts/:id                                       | protected bytes                                                                                                           |
| POST       | /api/speech/transcribe                                   | multipart audio -> `{text}`                                                                                               |
| POST       | /api/speech/speak                                        | `{text}` -> Artifact                                                                                                      |
| GET        | /api/vault                                               | VaultEntry[]                                                                                                              |
| POST       | /api/vault                                               | `{label, origin, username, password}` -> VaultEntry                                                                       |
| DELETE     | /api/vault/:id                                           | `{ok:true}`                                                                                                               |
| GET        | /api/credential-requests/:id                             | CredentialRequest                                                                                                         |
| POST       | /api/credential-requests/:id                             | `{username?,password?,code?}` -> `{ok:true}`                                                                              |
| POST       | /api/credential-requests/:id/retry                       | `{ok:true}`; queues a fresh secure step only for its current waiting task revision                                        |
| POST       | /api/credential-requests/:id/method                      | `{methodId}`; selects a current observed supported login or verification method                                           |
| GET        | /api/connections                                         | Connection[]                                                                                                              |
| POST       | /api/connections/:slug/connect                           | `{url}`                                                                                                                   |
| POST       | /api/connections/:slug/disconnect                        | `{ok:true}`                                                                                                               |
| POST       | /api/connections/:slug/triggers                          | `{enabled:boolean}` -> `{ok:true}`                                                                                        |
| GET        | /api/inspector                                           | InspectorState                                                                                                            |
| GET        | /api/inspector/screen?taskId=...                         | image/png with X-Screen-State and X-Screen-Captured-At headers; 404 if no screen, 423 during credential entry             |
| GET        | /api/memory                                              | MemoryFact[]                                                                                                              |
| DELETE     | /api/memory/:id                                          | `{ok:true}`                                                                                                               |
| GET / PUT  | /api/profile                                             | `{name,location,phone,preferences}`                                                                                       |
| GET / POST | /api/goals                                               | list / `{title,description?,targetDate?}`                                                                                 |
| PATCH      | /api/goals/:id                                           | `{title?,description?,targetDate?:string\|null,progress?,nextAction?,status?}`                                            |
| GET / POST | /api/schedules                                           | list / `{title,prompt,cron,timeZone}`                                                                                     |
| PATCH      | /api/schedules/:id                                       | `{title?,prompt?,cron?,timeZone?,enabled?}`                                                                               |
| DELETE     | /api/schedules/:id                                       | removes the schedule and recurring job                                                                                    |
| GET / PUT  | /api/preferences                                         | `{notificationRule,timeZone,quietStart,quietEnd}`                                                                         |
| GET        | /api/notifications                                       | recent relevance decisions and feedback                                                                                   |
| POST       | /api/notifications/:id/feedback                          | `{feedback:'useful'\|'not_useful'}`                                                                                       |
| GET        | /api/approvals/:id                                       | saved action and review state                                                                                             |
| POST       | /api/approvals/:id                                       | `{approved:boolean}`; executes the saved arguments only                                                                   |
| GET        | /api/channels                                            | enabled channel configuration and delivery counts                                                                         |
| GET        | /api/channel-settings                                    | `{ready,channels:[{provider,enabled,accountName?,accountHandle?,mode?,webhookStatus?,webhookUrl?}]}`; no secrets          |
| PUT        | /api/channel-settings/telegram                           | `{botToken,allowedUserId,webhookUrl?}` -> `{ok:true,channel}`; no URL selects local polling                               |
| PUT        | /api/channel-settings/whatsapp                           | `{accessToken,appSecret,phoneNumberId,allowedNumber,verifyToken,webhookUrl?,policyConfirmed:true}` -> `{ok:true,channel}` |
| DELETE     | /api/channel-settings/:provider                          | disables the channel and removes saved credential ciphertext                                                              |
| POST       | /api/connections/:slug/accounts/:connectionId/disconnect | removes only the selected owned account                                                                                   |
| POST       | /api/connections/:slug/accounts/:connectionId/triggers   | `{enabled:boolean}` sets that account's watch preference                                                                  |

Web routes: `/` chat, `/goals`, `/schedule`, `/vault`, `/connections`, `/channels`, `/credentials/:id` secure form, `/approvals/:id` action review. `/dev` opens chat with the inspector; `/you` is a compatibility route to chat. Channels has secure setup forms; model provider setup uses server environment configuration. Do not show fixtures as live results.

See `src/shared/contracts.ts` for response types. Attachment-only messages are accepted; empty messages without attachments are rejected. `Message.streamId` associates a persisted reply with its transient stream. Completed approvals use `completed`; a second execution is rejected. Paused schedule records remain editable; DELETE removes them.

Messages use automatic routing unless `taskId` or `forceNew` is supplied. A short answer can continue one waiting question in the same channel. An ambiguous answer returns 409 with `code: 'task_selection_required'` and `{id,title}[]` choices; the web composer keeps the draft for explicit task selection or a new request. Credential and approval steps require their secure forms. Message history uses the oldest message's timestamp and ID together to avoid duplicate or omitted rows at timestamp ties.

Implementation ownership and change guidance live in the area's `AGENTS.md`, linked from the root guide.

Connections return one row per saved account, plus a disconnected service row when no account is saved. `connectionId` is the local account selector; `accountName` and `accountEmail` come from the provider. Google tool arguments may include `connectionId`; multiple accounts require a selection, and write approvals retain it. The server removes this selector before calling the provider. Watches default to requested for supported services. `triggersActive` and `triggerStatus` distinguish an actual subscription from disabled, pending, or unavailable delivery configuration. Legacy service-only disconnect and trigger endpoints reject ambiguous accounts.
