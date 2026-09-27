# Interrupted task routing repair

Status date: **2026-09-27**.

A normal production request to check the current weather in Lisbon was attached to an older failed weather execution. It failed before starting a new model or tool call because the saved execution contained a browser action whose result was never confirmed. The checkpoint correctly refused to replay that action; selecting the interrupted execution for a new request was the defect.

The downloaded original checkpoint contained one old pending browser action and no completed receipt or new request entries. Read-only database observation confirmed the new request reused the old task and failed in about 1.3 seconds without starting a tool. Accounts, history and the unresolved receipt were preserved.

## Behavior

Conversation routing separates eligible outcomes from blocked failed or recovery outcomes within the same bounded context. Independent requests can create new work. A continuation naming blocked work returns a fixed conflict before changing messages, jobs or task revisions. Explicit replies and task IDs have the same guard. The transaction rechecks the latest task so a status change after routing cannot reopen a failed execution or select an older successful one.

If routing fails while blocked work is present, submission fails closed. The existing conversation fallback remains available without blocked context. Successful follow-ups, active work and current questions keep their existing behavior. Failure messages no longer promise that an interrupted execution can simply continue. The checkpoint replay protection is unchanged.

Messaging channels recognize this specific refusal, roll back partial submission writes and atomically record one owned response before processing later messages. Other errors retain their existing retry behavior. This prevents a refused continuation from blocking the channel inbox and outbox.

## Validation

- Sixty-four focused tests passed against disposable local PostgreSQL, including routing races, blocked continuations, fresh requests, bounded context, fallback behavior and the existing checkpoint replay protection.
- Six live routing checks using the development OpenAI configuration and synthetic context passed: fresh weather, blocked weather retry, blocked email retry, independent file creation, successful follow-up and ordinary conversation. These checks called only the classifier; they did not execute tools or change accounts.
- The complete local application suite passed all 1,271 tests with no skips or failures. The frontend build, TypeScript, architecture and repository checks passed.

Manual production acceptance and CI are recorded with the pull request when completed. A classifier result alone does not establish that the production browser task completed.
