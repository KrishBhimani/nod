# Single thread

Each owner has one active **thread**. The thread owns one persistent Pi session, one workspace sandbox and one browser computer. Every user message, schedule fire, reaction wake and resume becomes a **turn** on that thread. Turns run one at a time in order. Pi keeps the transcript and compacts it; the server does not route messages or rebuild history.

## Model

`threads`

| column                  | meaning                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `id uuid`               | Key for the Pi session, the workspace and the computer.            |
| `owner_id text`         | One row per owner with `archived_at IS NULL`.                      |
| `status text`           | `idle`, `running` or `manual_control`.                             |
| `created_at/updated_at` |                                                                    |
| `archived_at`           | Set by reset. The same transaction creates the next active thread. |

`turns`

| column                                                  | meaning                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `id uuid`                                               | Fences every side effect. Replaces the old `(taskId, revision)` pair.                                        |
| `owner_id`, `thread_id`                                 |                                                                                                              |
| `source text`                                           | `user`, `schedule`, `event` or `resume`.                                                                     |
| `source_id text`                                        | Optional idempotency key, unique per owner.                                                                  |
| `message_id uuid`                                       | The user message for a `user` turn.                                                                          |
| `prompt text`                                           | The instruction sent to the agent.                                                                           |
| `channel text`                                          | Where replies from this turn are delivered: `web`, `telegram:…`, `whatsapp:…`.                               |
| `status text`                                           | `queued`, `running`, `succeeded`, `waiting`, `failed` or `cancelled`.                                        |
| `waiting_reason text`                                   | For `waiting`: `question`, `approval`, `credentials` or `browser`. Display and resume only; it never blocks. |
| `pending_connection_service`                            | Durable app callback received before the originating turn enters its matching wait.                          |
| `background`, `read_only`                               | Runtime flags.                                                                                               |
| `error text`, `created_at`, `started_at`, `finished_at` |                                                                                                              |

`messages.thread_id` and `messages.turn_id` replace `messages.task_id`. `artifacts.thread_id` replaces `artifacts.task_id`. Other tables replace `task_id`/`task_revision` with `turn_id`.

Existing tasks become retained turns, with owner and reset boundaries preserved. The newest current task supplies the initial thread UUID so its Pi checkpoint, workspace and browser remain available, including unresolved action receipts. Other old sessions remain retained without merging transcripts. Schedule history, prompt snapshots, usage, approvals, messages and channel provenance keep their mapped identities. Unfinished legacy execution is marked failed without dispatch; only an eligible current app-consent wait retains its continuation. New channel delivery is never invented for historical messages. Old task tables remain in place.

## Execution

- A pg-boss job `thread-drain` carries `{ threadId }`. The worker locks the thread; if it is `idle`, it claims the oldest queued turn, sets the thread to `running` and runs the turn. When the turn ends, the thread returns to `idle` and another drain job is sent. A failed drain transaction is retried durably; it settles any interrupted turn and advances the queue without replaying that turn.
- `withTurnLock(turnId, op)` checks that the turn is `running` on the active thread before any write. A stopped, cancelled or superseded turn throws the fixed stopped error.
- Stop aborts the running turn, cancels it and discards queued turns.
- Manual browser control retains the originating running turn or current browser wait and its channel, aborts running execution, and sets the thread to `manual_control`. New turns wait until control ends; resume queues a `resume` turn.
- A question, approval or credential request ends the turn as `waiting` and the thread becomes `idle`. The next user message is simply the next turn in the same Pi session. A completed credential form or app connection queues one `resume` turn only while its originating turn is still waiting on the active thread. An app callback received while its turn is running is recorded durably and dispatched only if that turn subsequently enters the matching wait; failure, Stop and reset discard the pending continuation. Claiming the next turn cancels older credential and browser waits; Stop also cancels waiting turns.
- Agent execution is never retried automatically. An interrupted turn ends as `failed` with one message: after an outside action, the user is asked to check whether it went through; otherwise they can say continue. The Pi session keeps the full context.

## Runtime

`RuntimeContext` carries `threadId` and `turnId`. Computer, workspace, Pi session and artifacts use `threadId`. There is no fresh-session flag. Recent history is sent only when Pi has no saved session yet. Attachments from the current turn's message are staged once into the thread workspace.
