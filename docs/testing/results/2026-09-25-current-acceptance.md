# Current-model acceptance and schedule delivery

Date: 2026-09-25. This report supplements the earlier dated checks. It does not relabel old model runs or fixture results as current live-provider tests.

## Environment and scope

Two isolated app runs used the actual GPT-6 Sol agent, GPT-6 Luna conversation router, browser adapter, Linux workspace, PostgreSQL workers and chat UI. Provider records confirm both model IDs. Gmail, Slack, Notion consent/data and authentication were synthetic. External messaging transports were disabled. The normal owner profile was not reset or used for these tasks.

Run A used schema `e2e_2df131d661284ec1` and temporary directory `sidekick-e2e-XDA0mq`. Run B used `e2e_aa5b8c54c4f64ea1` and `sidekick-e2e-o7Rfwt`. Timing logs and selected synthetic database evidence remain local. Full model sessions and browser profiles are not checked into Git.

The final source fingerprint is `df4350455059d0063429d82af49b9affbe9cf5eebe04990fd2f49de41a54d947`. It hashes the 152 sorted paths from `src`, `scripts`, `package.json` and `package-lock.json`, with each path and file body separated by a null byte. Documentation is excluded.

This pass reruns browser navigation, screenshots, files, integration reads, task continuity, cancellation, goals, timed reminders and Inspector checks affected by the latest changes. Named Vault accounts and fake password/2FA continuation use the separate current-model [Vault acceptance report](2026-09-25-vault-accounts.md). The [Apps and chat report](2026-09-25-apps-and-chat.md) retains current-model consent, draft/send, destructive chat confirmation, inline reaction and image-viewer evidence. Those reports state their own runs, models and limits. The [acceptance matrix](../acceptance-matrix.md) defines the full case set; this is not a claim that all 24 cases were freshly repeated in these two runs.

## Failures found and repaired

1. The model misread a future Lisbon reminder as already past. Its prompt supplied UTC time and the zone but no explicit local timestamp. Prompts now include both UTC and local ISO time, offset and IANA zone. Every runtime prompt refreshes that clock, including secure continuation and reopened sessions. The reported future-time request then created the correct one-off schedule. Focused fixtures cover Lisbon DST transitions, date rollover, fractional offsets and persisted-session clock changes.
2. Scheduled tasks did not retain their originating external conversation. The server now stores the verified channel receipt with the schedule and creates a durable delivery route for each occurrence. Current account/sender checks, reply windows and uncertain-send protection still apply. PostgreSQL and synthetic Telegram transport tests cover actual timed dispatch. No real Telegram or WhatsApp delivery was performed.
3. A concrete goal progress change appended to the Goals page's Update draft triggered an unnecessary confirmation. The action policy now recognizes that exact contextual draft followed by an explicit goal-change instruction. The context alone and the tested leading negations and draft-only continuations do not authorize a change. The same UI workflow now saves progress and next step directly.

The schedule route implementation does not enable autonomous background creation of new schedules. Existing authorization still requires a direct user request for that operation.

## Observed task timings

Times below measure received chat request to saved terminal execution state. File publication and useful replies can arrive earlier. These are individual samples, not latency guarantees.

| Request                                                                | Result                                                                                                                               | Duration                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Find the last sent email                                               | Returned synthetic NS-2048, its recipient and attached CSV.                                                                          | 8.229 s                                                                  |
| Send the attachment from that email                                    | Continued the same task, downloaded the correct attachment and published it without another confirmation. File available at 5.874 s. | 7.861 s                                                                  |
| Read Northstar updates from Slack and Notion                           | Used both connected synthetic accounts and returned their actual data.                                                               | 9.934 s                                                                  |
| Open IANA's example-domains page and send a screenshot                 | Read the actual public page heading and published a recognizable screenshot. Image available at 10.750 s.                            | 11.906 s                                                                 |
| Create an invoice CSV                                                  | Published the requested three rows with the correct filename, MIME and contents. File available at 6.055 s.                          | 7.282 s                                                                  |
| Slow browser page, with a related screenshot request during navigation | Returned READY-903, then its screenshot. Both inputs kept one task and outcome; screenshot ran as revision 1.                        | 20.043 s for the first result; 18.597 s from follow-up to its completion |
| Stop browser navigation, then open IANA again                          | Cancellation produced no late assistant message. The next request opened the public page successfully.                               | 7.553 s for recovery                                                     |

The email attachment contained `NS-2048,Reviewed,360.00`. The generated CSV contained NS-1042 / EUR 240.00, NS-1043 / EUR 85.00 and NS-2048 / EUR 360.00. The files were checked through stored artifact bytes, not only their chat labels.

Apps consent completed through the visible synthetic Gmail, Slack and Notion flows. Account identities remained visible, with an Add account action. These checks exercise local consent/callback/account handling, not the external providers' OAuth services.

## Goals and reminders

The final run created Complete Northstar review with target 2026-10-02 and next step Check invoice NS-1042 in 5.329 seconds. Clicking Update prepared a contextual chat draft. Appending the explicit 25% progress and Prepare NS-2048 summary changes saved them without a confirmation question in 4.912 seconds. The same date, progress and next step remained after reloading Goals.

The one-off request said 12:54 in the user's timezone. The stored schedule was exactly `2026-09-25T11:54:00.000Z`, Europe/Lisbon, with no cron. Its useful reply was Northstar one-off check. The one-off disabled after execution and appeared once in History.

The fresh recurring check ran twice through actual delayed workers. Both intended UTC occurrences were registered before they were due. No clock was advanced and no dispatcher was called manually.

| Schedule                              | Intended UTC occurrence | Worker start after due | Useful reply saved after due |
| ------------------------------------- | ----------------------- | ---------------------- | ---------------------------- |
| Northstar one-off check               | 2026-09-25 11:54:00     | 0.276 s                | 1.957 s                      |
| Northstar timing verification, first  | 2026-09-25 11:55:00     | 0.310 s                | 1.760 s                      |
| Northstar timing verification, second | 2026-09-25 11:56:00     | 0.351 s                | 1.958 s                      |

The pause request cancelled the next recurring job at 11:56:18.431, before its 11:57 due time. Schedule and Inspector both showed no upcoming reminders, and this state survived reload. The 11:57:58 database check confirmed exactly two fresh occurrences, no third execution and a cancelled next job that never started.

An earlier recurring trial had correct replies at 11:51 and 11:52, but the operator submitted pause at the 11:53 boundary. That occurrence had already dispatched. It read the paused state and finished without another reply; the subsequent 11:54 occurrence was cancelled. The late expected-time registration made that trial unsuitable for the strict two-occurrence acceptance criterion, so it was repeated with the fresh schedule above. It is not counted as proof that the 11:53 dispatch was prevented.

## Inspector evidence

Run A's Tools tab reported 13 calls across eight tools, matching stored calls: six app calls and one each for ask_user, browser, download_app_file, publish_artifact, send_message and send_screenshot. The expanded attachment call showed its actual account/message/attachment input and the matching artifact output.

At the same checkpoint Costs showed USD 0.120086, matching the ledger sum of USD 0.1200855 after display rounding. The OpenAI subtotal contained 17 GPT-6 Sol operations costing USD 0.1191863 and six GPT-6 Luna operations costing USD 0.0008992. Expanding details did not add overlapping totals. The remaining synthetic app, browser, workspace and public-web operations stayed unpriced. Recorded provider estimates are not invoices.

Screen continued showing the actual IANA browser while independent file work ran. Its screenshot opened from the bounded chat image. Activity showed current work and upcoming schedules with Lisbon times. Schedule History showed actual occurrence timestamps and execution statuses. A Done status describes execution, not proof of the user's full objective.

Prompts labelled the goal update as a continued session and showed its effective latest instruction with `2026-09-25T11:53:34.508Z`, local `2026-09-25T12:53:34+01:00` and Europe/Lisbon. The user request remained structured data after that trusted clock.

## Automated checks and limits

- `npm run check`: TypeScript, architecture and formatting passed.
- `npm run test:integration`: 522 passed, zero failed and zero skipped, in 59.125 s.
- `npm run build`: passed with the existing client chunk-size warning.
- Focused clock, action-policy and scheduled-channel regressions are included in the full suite.
- `git diff --check`: passed.

Both generated app/queue schemas and the final test workspace container were removed after evidence export. The normal app health check still returned OK. Private temporary evidence remains local.

Named password and fake-2FA continuation are proven against the synthetic website, including same-host account selection and rejected-input recovery. Public X login-page navigation produced a Vault invitation in the separate current-model report; no real X credentials were entered. Real X/Google authentication, X bookmark retrieval, real provider OAuth and Telegram/WhatsApp delivery remain unverified. Local schedules require the app and Mac to remain running. No push or deployment was performed.
