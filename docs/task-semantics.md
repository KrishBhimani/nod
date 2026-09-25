# Conversation outcomes and execution sessions

The current `tasks` table represents an execution session. Its prompt and revision change when work resumes. It is not a reliable count of the user's intended outcomes. A greeting creates an execution; a long follow-up can create another; a successful model turn does not prove that an outcome was achieved. Preserve those records and their security checks rather than silently relabelling past data.

## Implemented bounded routing

The server adds an owned `outcomes` record for a concrete request that needs work across messages. `tasks` remains the compatible execution/session boundary with nullable `outcome_id`. New small-talk or factual-answer executions need no outcome. Existing history remains unclassified; do not backfill guessed objectives from titles.

Resolve explicit owned message replies first, then ordinary answers to the current waiting question. Both retain the current channel and conversation-generation checks. For other messages, ask an injected semantic router to choose conversation-only, a new outcome, or continuation of one of a small set of server-supplied outcome candidates. The router receives bounded user/assistant context and candidate identifiers. Broker-held Vault values and raw browser content are not supplied, but anything typed in a chat message can reach the model, including sensitive text entered by the user. A model decision cannot grant access or bypass a wait.

Run the model callback outside database locks with a short timeout. On return, acquire the conversation lock and revalidate the selected outcome's owner, channel and generation. An idle related session resumes through the existing revision mechanism. If it is active, persist the message and a pending input without starting overlapping browser work. After the current segment ends, dispatch the pending input in order only when ordinary continuation is permitted. Secure credentials, approvals and manual control keep their dedicated continuation paths. Cancellation/reset invalidate pending inputs. Persist the selected input's message ID for each segment so later queued messages cannot replace its memory provenance.

This routing improves continuity but does not prove semantic correctness. Unavailable or invalid classification must have a bounded fallback; it must not guess a foreign target or resume an uncertain external action. Ambiguous requests may need one concise clarifying question. Outcome completion must be an explicit recorded decision backed by a result or the user, never a direct alias of `tasks.status='succeeded'`.

## Acceptance checks

- A greeting followed by a separate request does not turn the greeting into an outcome.
- A multi-message outcome retains its link through ordinary questions, credentials and approvals.
- A related message arriving during a browser action waits behind that session and cannot open an overlapping browser run.
- Two unrelated outcomes remain independent. A stale router result cannot cross owners, channels or a reset generation.
- Cancelling/resetting active work prevents pending inputs from resurrecting it.
- Each resumed segment receives the correct user-message provenance, including when several inputs arrived during an active segment.
- No router timeout, provider failure or malformed target bypasses existing secure-wait or uncertain-action rules.
- Existing task IDs, artifacts, inspector records and browser sessions remain addressable; old data is not fabricated into outcomes.

## General inspector

Use the inspector to explain execution, not as the product's task list. Keep a global retained-activity view with optional execution/outcome filtering, source and channel provenance, tool/model/provider records, and browser-session selection. Show session plus revision when needed to distinguish repeated segments. Group sessions under an outcome only when a stored link exists.

Schedule history is a separate operational view: exact due time, accepted execution, current execution state and fixed error. Connected-event decisions, webhook delivery and schedule dispatch should also be inspectable without pretending every event is a user task. Correlate these records with server IDs and preserve payload redaction and retention. Report unavailable or partial cost coverage explicitly; totals are not a provider invoice.

Outcome routing and pending-input dispatch are implemented in `server/outcomes.ts` and `server/tasks.ts`. The injected port lives in `ports/conversation.ts`; provider-specific classification remains in adapters. `outcomes`, `conversation`, `task-continuation` and `channels` passed 24 focused synthetic checks. Schedule history is implemented in `server/schedules.ts`; `schedules` and `personal` passed 20 checks, including a timed pg-boss worker without model or external actions. These checks do not measure live semantic routing accuracy.

Automatic outcome completion, user outcome management, a historical backfill and a generalized cross-channel outcome transfer are not implemented. The current policy retains channel-specific execution ownership even though saved personal context is shared. A router timeout or invalid result creates an ordinary unclassified execution; it does not attach work to a guessed candidate.
