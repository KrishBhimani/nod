---
name: schedules-and-watches
description: Create reminders, recurring tasks and watches that check a source and alert on a rule. Use when the user asks to be reminded, to repeat a task, or to be told when something changes.
---

# Schedules and watches

1. Decide the kind. A reminder prompt tells the user something at the time ("Remind the user to call the bank"). An action prompt does the work each run ("Check the price of X at URL and alert if it is under 50 EUR"). Write the prompt as the complete instruction the future run will receive.
2. Use the user's time zone. Both kinds need timeZone; kind once needs a future runAt with offset and kind recurring needs a five-field cron.
3. For a watch, check the source once now and pass baselineObservation {status: verified, sourceUrl, value, summary} to schedule_create.
4. On each scheduled run, check the source, then call manage_personal_context schedule_record_observation {status, sourceUrl, value, summary}. Keep value short and stable; put item terms in summary. Use status unavailable with value null when you could not verify.
5. Compare the meaning of the new value with the previous verified one, then apply the user's alert rule. A current-state rule ("while it is under 50") alerts every due run that meets it unless the user asked to suppress repeats. A change rule alerts only on a verified change. An unavailable check never counts as a change.
6. In background runs, send_message only for a real alert or a necessary question. Routine checks stay quiet.
