# Goals, Schedule and secure sign-in acceptance

Date: 2026-09-25. These checks use the real app, model, PostgreSQL workers, Chrome and Vault with disposable test data. Website credentials and the authentication service are synthetic. They do not prove that Google, X or another external website will accept a real account login.

## Scope and evidence

The app ran on port 4320 in three isolated schemas. The normal owner app on port 4310 was not reset or used for mutations.

| Run | Schema                 | Purpose                                                                                            |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------- |
| A   | `e2e_b64d557bafa74782` | Password rejection/retry, fake 2FA rejection/retry, automatic continuation and screenshot delivery |
| B   | `e2e_08fdc8bc557f41fb` | Goals, recurring/one-off schedules, timed execution, history, narrow layout and network recovery   |
| C   | `e2e_7e1cd364d80d48ea` | Fresh acceptance of the final goal completion fix                                                  |

The provider ledgers for Runs B and C record GPT-6 Sol agent work and GPT-6 Luna relevance calls. Run A's manifest names GPT-6 Sol; its exported summary does not independently list the executed provider calls.

The source fingerprint is `a972bb9cc3c6742eb7138c77817c2ec8a58278271e0fb9b890c7ef40d41f570a`. It hashes 152 sorted paths under `src`, `scripts`, `package.json` and `package-lock.json`, separating each path and file body with a null byte. Files under `docs` are excluded; local guides under `src` are included.

Safe local exports are `/tmp/sidekick-ui-auth-evidence.json`, `/tmp/sidekick-goals-schedule-evidence.json` and `/tmp/sidekick-goal-completion-evidence.json`. Copies and screenshots are under `.local/evidence/goals-schedules-auth/`, excluded from Git. Full model sessions, browser profiles and credentials are not checked in.

The [earlier acceptance report](2026-09-25-current-acceptance.md) covers public browser navigation, file creation/delivery, integration reads, task continuity and Inspector costs. The [Apps and chat report](2026-09-25-apps-and-chat.md) covers synthetic OAuth, draft/send behavior, chat confirmations, reactions and galleries. Those are separate runs, not cases freshly repeated in this pass.

## Defects found and fixed

- Goal and schedule Resume drafts requested an extra confirmation despite a direct instruction. Recognition is now scoped to those personal actions.
- The Schedule Change draft did not recognize its own introductory wording. A concrete change now applies after the draft is sent.
- The Goals Update draft followed by “Mark it completed with progress 100% now.” also requested confirmation. A goal-only completion rule fixes that case. Draft-only, negated, quoted and unrelated-action inputs remain covered by regression tests.
- Secure sign-in messages displayed unrelated website preview cards next to the Vault invitation. Credential invitations now keep their links without fetching or rendering cards. Ordinary public article previews remain available.
- Goal and schedule actions lacked distinct accessible names. Cards and controls now identify their target. Schedule tabs expose a focusable panel.
- Common recurrence patterns displayed as Custom timing. They now have accurate readable labels; uneven cron intervals remain custom.
- Paused schedules were hidden when no work was upcoming. That group now expands in this state.
- Failed page reads had no useful recovery in some states and exposed “Failed to fetch.” Goals, schedules and history now use fixed failure text and an error-only Try again action while retaining cached data.
- Long goal next steps could overflow. They now wrap within the card.

## Password and fake 2FA

The request asked the agent to sign in to the synthetic Northstar website, report the invoice awaiting review, and send a screenshot.

1. The agent opened the site and supplied a Vault link with the website origin.
2. The operator saved a named login, Northstar work. A wrong password produced a fresh secure retry form. The name remained; credential fields were cleared.
3. A correct password advanced the website to its verification-code stage. The agent supplied a second secure link.
4. A wrong verification code produced another fresh retry form. The correct code then opened the account.
5. The original task continued without another chat request, reported invoice NS-1042 awaiting review for EUR 240, and delivered a screenshot in chat. The image viewer showed the actual authenticated fixture page.
6. Vault contained one named entry for `https://example.com`. OTP entry did not create another credential.

| Measurement                                                  |   Elapsed |
| ------------------------------------------------------------ | --------: |
| Received request to Vault wait                               |  16.141 s |
| Accepted password to OTP wait                                |   8.526 s |
| Accepted OTP to first saved reply                            |   5.566 s |
| Accepted OTP to screenshot-message save event                |   8.323 s |
| Accepted OTP to terminal success                             |   9.548 s |
| Entire request, including manual waits and rejected attempts | 163.768 s |

The recorded secret scan found zero matches for the supplied test passwords/codes across 288 database rows and one model-session file. The database scope was messages, task events, Inspector records/prompts, provider usage, credential requests and account selection. This is bounded evidence for the submitted values, not proof against every possible disclosure. Browser profiles/cookies were not searched.

## Goals in the UI

The actual Add goal, Update, Pause and Resume controls prepared chat drafts. Sending them created Northstar launch readiness, changed it to 25%, set its next step, paused it and resumed it. The date 2026-10-02, progress and next step survived navigation and reload.

| Action                        | Received request to saved terminal state |
| ----------------------------- | ---------------------------------------: |
| Create                        |                                  6.453 s |
| Update progress and next step |                                  6.146 s |
| Pause                         |                                  5.889 s |
| Resume                        |                                 10.558 s |

Run B exposed the completion confirmation defect and is not counted as a passing completion check. Run C repeated that exact UI request with the final policy loaded. Completion succeeded in 5.971 seconds without a confirmation question. The original task continued as revision 1; the stored goal became completed at 100% with the same target date. The completed card survived reload, removed Pause/Resume and hid the old next step. No approval remained pending.

## Real scheduled execution

The Schedule page showed an exact one-off time and a recurring interval in Europe/Lisbon. The recurring task was created at Every 5 minutes, paused, resumed, then changed through its Change draft to Every minute. The new next occurrence and label appeared without manual refresh.

Expected UTC occurrence times were registered before they were due. No test clock was advanced and no dispatcher was invoked manually.

| Run                        | Due time, Europe/Lisbon | Worker dispatch after due | Reply saved after due | Result   |
| -------------------------- | ----------------------- | ------------------------: | --------------------: | -------- |
| Northstar pulse, first     | 2026-09-25 13:43        |                   0.146 s |               2.813 s | Finished |
| Northstar pulse, second    | 2026-09-25 13:44        |                   2.188 s |               4.632 s | Finished |
| Northstar release reminder | 2026-09-25 13:44        |                   0.188 s |               2.095 s | Finished |

All three exact reminder messages reached chat. History showed all three with their local due time and Finished state. The one-off disabled itself. The recurrence was paused before 13:45. At 13:46:21, the database still contained exactly two recurrence runs, one one-off run, no future runnable jobs and no next occurrence for either schedule.

History and paused state survived a full reload. With no upcoming work, the paused task remained visible with Resume. Inspector Activity showed both upcoming tasks in Lisbon time before they ran.

## Layout, keyboard and recovery

- Goals and Schedule were checked at 1280 px and 390 px. At 390 px, the document had no horizontal overflow and both schedule cards fit within their container. The completed goal is also checked in Run C.
- Schedule tabs responded to ArrowRight, Home and End. Tab moved from the selected tab into its labelled panel.
- A temporary browser network failure retained the existing goal and schedule cards. Restoring the network and selecting Try again recovered each page. The final History build retained all three runs while showing “Could not load schedule history.” and recovered through Try again.
- No manual refresh icon was added. Retry is visible only while a read has failed.
- Temporary viewport and network overrides were restored.

## Checks and limits

- `npm run test:integration`: 534 passed, zero failed or skipped, in 61.289 s.
- The final load-failure wording changes then passed all 10 focused Goals/Schedule UI checks.
- `npm run check`: TypeScript, architecture and formatting passed after the final source edits.
- `npm run build`: passed after the final source edits, with the existing bundle-size warning.
- `git diff --check`: passed.

All six generated app/queue schemas and all three temporary workspace containers were removed after evidence export. The normal app health endpoint still returned OK. App and credential-form test tabs were closed; an earlier connection-error tab could not be closed by the browser tool. The normal owner tab was left untouched.

Real Google/X login, X bookmarks, external-provider OAuth and live Telegram/WhatsApp delivery remain separate verification needs. Local schedules require the app and Mac to stay running. Fake 2FA proves secure code entry and browser continuation for this supported form, not passkeys, hardware keys or all provider challenges. No push or deployment was performed.
