# Price watch evaluation, 29 September 2026

This check used the disposable Otto end-to-end harness, a real Pi agent with `gpt-6-sol`, the task browser and the scheduler. The hotel and flight pages were synthetic. The flight was Athens to Barcelona on 14 November 2026, with a return on 17 November 2026. No live airline or hotel price was checked. No booking or cancellation action ran.

| Case                                     | Source checks    | Saved observations                | Alerts                  | Result                          |
| ---------------------------------------- | ---------------- | --------------------------------- | ----------------------- | ------------------------------- |
| Hotel, Lisbon, 14–16 October             | €180, €159, €159 | One baseline and three due checks | One at €159, a €21 drop | Pass at one-minute test cadence |
| Flight, Athens–Barcelona, 14–17 November | €240, €215, €215 | One baseline and three due checks | One at €215, a €25 drop | Pass at one-minute cadence      |

The hotel task first created the requested 09:00 and 21:00 Europe/Lisbon schedule with a verified €180 baseline. To check the drop rule without waiting for 09:00, a second hotel watch ran every minute. It saved €180 at 08:00, €159 at 08:01 and €159 at 08:02 Europe/Lisbon. It sent one drop alert and no repeat. The user then asked for the original hotel schedule to run every minute. Its 08:03 and 08:04 checks saved €159; it sent no second alert for a rate already reported in the same conversation. The extra test watch was paused before this change.

The final flight run used the completed observation tool. Due runs started 1.12–1.17 seconds after their scheduled minute. The page showed €240 at 09:06 and €215 at 09:07 and 09:08 Europe/Madrid. Each run saved the checked fare, source, terms and time. The 09:07 run received €240 as its previous verified observation and sent one drop alert. The 09:08 run received €215 and sent no alert. The flight schedule was paused after the third check.

The first implementation failed to save due-run observations because the model sent extra fields to a broad tool. An exact `record_schedule_observation` tool removed that error. Its first schema also rejected a valid HTTPS URL because the local TypeBox validator had no `uri` format; the server now checks the URL. One hotel run saved `€159 total` and the next saved `€159`. Exact text comparison marked those as different, although the agent did not send a repeat alert. The final tool returns the previous observation and lets the agent compare meaning under the user's rule.

Pi keeps each task's tool calls and results in its durable session transcript. Otto saves one small observation on each existing schedule run for a direct cross-session read and for Schedule history. The implementation adds no price-specific table, memory package or long-running agent. Pi custom entries are per session and do not enter model context. Each due occurrence is a new Pi session.

The three final flight runs each used about $0.032–$0.035 of recorded model and provider cost and finished about 9–11 seconds after dispatch. A continuous one-minute watch at this cost would be about $46–$50 per day before hosting cost. This acceptance run checks the requested fast cadence; it does not establish an economical long-term live flight watch. The browser ran in Otto's owned container. No user tab needed to stay open.

Automated fixtures check owner binding, one observation per active run, unavailable checks, prior verified values, retained history after deletion, exact tool arguments and Schedule rendering. `npm run test:integration` passed 1,466 tests with six skips and no failures. The UI rendering was checked by automated tests; no manual browser UI review or live account check was done. The disposable harness and schedules were stopped after the run.
