# Internal API contract

All routes use the same localhost origin and the development account. JSON error responses have `{error: string}`. Browser mutations require same-origin Origin checks. The public URL and non-loopback requests are disabled until real authentication is implemented.

| Method     | Path                               | Shape                                                                              |
| ---------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| GET        | /api/state                         | AppState                                                                           |
| POST       | /api/messages                      | `{text, attachmentIds?: string[], taskId?: string}` -> `{taskId}`                  |
| GET        | /api/events                        | SSE `{type:'refresh'}` or `{type:'delta',taskId,text,streamId?,done?}`             |
| POST       | /api/tasks/:id/cancel              | `{ok:true}`                                                                        |
| POST       | /api/uploads                       | multipart file -> Artifact                                                         |
| GET        | /api/artifacts/:id                 | protected bytes                                                                    |
| POST       | /api/speech/transcribe             | multipart audio -> `{text}`                                                        |
| POST       | /api/speech/speak                  | `{text}` -> Artifact                                                               |
| GET        | /api/vault                         | VaultEntry[]                                                                       |
| POST       | /api/vault                         | `{label, origin, username, password}` -> VaultEntry                                |
| DELETE     | /api/vault/:id                     | `{ok:true}`                                                                        |
| GET        | /api/credential-requests/:id       | CredentialRequest                                                                  |
| POST       | /api/credential-requests/:id       | `{username?,password?,code?}` -> `{ok:true}`                                       |
| POST       | /api/credential-requests/:id/retry | `{ok:true}`; queues a fresh secure step only for its current waiting task revision |
| GET        | /api/connections                   | Connection[]                                                                       |
| POST       | /api/connections/:slug/connect     | `{url}`                                                                            |
| POST       | /api/connections/:slug/disconnect  | `{ok:true}`                                                                        |
| POST       | /api/connections/:slug/triggers    | `{enabled:boolean}` -> `{ok:true}`                                                 |
| GET        | /api/inspector                     | InspectorState                                                                     |
| GET        | /api/inspector/screen?taskId=...   | image/png, 404 if no screen, 423 during credential entry                           |
| GET        | /api/memory                        | MemoryFact[]                                                                       |
| DELETE     | /api/memory/:id                    | `{ok:true}`                                                                        |
| GET / PUT  | /api/profile                       | `{name,location,phone,preferences}`                                                |
| GET / POST | /api/goals                         | list / `{title,description?,targetDate?}`                                          |
| PATCH      | /api/goals/:id                     | `{title?,description?,targetDate?:string\|null,progress?,nextAction?,status?}`     |
| GET / POST | /api/schedules                     | list / `{title,prompt,cron,timeZone}`                                              |
| PATCH      | /api/schedules/:id                 | `{title?,prompt?,cron?,timeZone?,enabled?}`                                        |
| DELETE     | /api/schedules/:id                 | removes the schedule and recurring job                                             |
| GET / PUT  | /api/preferences                   | `{notificationRule,timeZone,quietStart,quietEnd}`                                  |
| GET        | /api/notifications                 | recent relevance decisions and feedback                                            |
| POST       | /api/notifications/:id/feedback    | `{feedback:'useful'                                                                | 'not_useful'}` |
| GET        | /api/approvals/:id                 | saved action and review state                                                      |
| POST       | /api/approvals/:id                 | `{approved:boolean}`; executes the saved arguments only                            |
| GET        | /api/channels                      | enabled channel configuration and delivery counts                                  |

Web routes: `/` chat, `/vault`, `/connections`, `/you` profile/goals/schedules, `/credentials/:id` secure form, `/approvals/:id` action review, `/dev` inspector. Provider setup uses server environment configuration. Do not show fixtures as live results.

See `src/shared/contracts.ts` for response types. Attachment-only messages are accepted; empty messages without attachments are rejected. `Message.streamId` associates a persisted reply with its transient stream. Completed approvals use `completed`; a second execution is rejected. Paused schedule records remain editable; DELETE removes them.

Implementation ownership and change guidance live in the area's `AGENTS.md`, linked from the root guide.
