# LAB-380 end-to-end evaluation

This plan tests [LAB-380](https://linear.app/n8n/issue/LAB-380) through Otto's normal chat, connected-app path, and schedule dispatcher. The account and Sheet are synthetic. The run must not read a personal account or write to the Sheet.

## Frozen case C380.v1

The prompt is the Linear prompt with a fixed local morning time:

> Using my spending Google Sheet, tell me what I spent this week by category and how that compares with my monthly budget. Then check it every morning at 11:59 Europe/Madrid and tell me if I'm over.

The test date is 29 September 2026. The Sheet title is **September spending test**. Its link and ID come from the synthetic Google Sheets account. The Spending tab has five rows dated 28 September and no rows dated 29 September. The Budget tab has three rows:

| Category  | Weekly spend | Monthly budget |   Difference |
| --------- | -----------: | -------------: | -----------: |
| Food      |       €50.00 |        €200.00 | €150.00 left |
| Transport |      €125.00 |        €100.00 |  €25.00 over |
| Software  |       €40.00 |         €60.00 |  €20.00 left |

Food has two source rows, €32.50 and €17.50. Software has two paid subscriptions, €20.00 each. The independent answer key is the fixture data, not Otto's answer. One due check should find no transactions on 29 September and still report that Transport is €25.00 over budget. The frozen source state stays the same through the first due run.

| Check | Pass condition                                                                            | Evidence                    |
| ----- | ----------------------------------------------------------------------------------------- | --------------------------- |
| C1    | The initial request starts with one plain message.                                        | Chat and task trace         |
| C2    | The Sheets connection starts from one chat button without a redundant connection message. | UI recording                |
| C3    | The answer names **September spending test** and gives its sheet link before the figures. | Final chat message          |
| C4    | Food spend is €50.00.                                                                     | Sheet rows and answer       |
| C5    | Transport spend is €125.00.                                                               | Sheet rows and answer       |
| C6    | Software spend is €40.00.                                                                 | Sheet rows and answer       |
| C7    | Transport is the only category reported over budget, by €25.00.                           | Budget rows and answer      |
| C8    | One visible, editable daily schedule is saved for 11:59 Europe/Madrid.                    | Schedule API and UI         |
| C9    | The normal dispatcher starts a due run after 11:59 with no open user browser.             | Queue timing and task ID    |
| C10   | The due result says there were no transactions on 29 September.                           | Due message and Sheet rows  |
| C11   | The due result reports the Transport overage once.                                        | Due message and message IDs |
| C12   | No Sheets write action occurs.                                                            | Integration audit           |
| C13   | The initial task and due task each finish or name an exact blocker.                       | Task state and chat         |
| C14   | Each final answer shows elapsed time and measured cost, or says cost is unavailable.      | Chat and usage ledger       |

The case result is one binary score. It passes only when C1–C14 pass in the same build and observed due run. A missing synthetic account, failed harness, or missed test time blocks scoring until a valid run. A product failure is red.

## Evaluator correction C380.v2

C380.v1 remains red on C10. Its due alert reported the verified overage but did not say that no transaction was dated 29 September. LAB-380 asks Otto to alert when spending exceeds a budget; it does not ask for a daily transaction count. C10 therefore added a reporting requirement outside the user task. Keep that red result as evidence of an invalid check.

C380.v2 uses the same Sheet and answer key. Its prompt is:

> Using my spending Google Sheet, tell me what I spent this week by category and how that compares with my monthly budget. Then check it every morning at 12:05 Europe/Madrid and tell me if I'm over.

The new check time permits a second due run on 29 September. C10 now passes only when the due run reads the dated source rows again, uses current-month totals, and does not invent a new transaction. All other checks keep their C380.v1 meanings. Score C380.v2 from a fresh isolated task, account and due run; do not rescore the first run.

The C380.v2 run passed the due read, observation, single alert and no-write checks. It remains red on C3: the initial answer linked the Sheet but called it “your sheet” rather than naming its available title. This replay prompt also conflicted with itself: “morning” and 12:05 name different parts of the day. The user's answer resolved that conflict. The question was valid. C8 and C9 in this version did not state the changed due time, so this version does not establish a full-case pass.

## Source-title replay C380.v3

C380.v3 keeps the same data, answer key and C1–C14 checks. It uses this prompt so another same-day due run can be observed:

> Using my spending Google Sheet, tell me what I spent this week by category and how that compares with my monthly budget. Then check it every morning at 12:10 Europe/Madrid and tell me if I'm over.

The fresh C380.v3 task named the exact Sheet title and gave the correct figures. It then asked about the same “morning” versus 12:10 conflict. No schedule was created before that question. This version is invalid as a same-day due test. Keep its trace as evidence for the source-title fix, but do not score it as a full case.

## Same-day daily replay C380.v4

This operational variant keeps the same spending and budget task, fixture, answer key and checks, with these exact changes:

> Using my spending Google Sheet, tell me what I spent this week by category and how that compares with my monthly budget. Then check it every day at 12:15 Europe/Madrid and tell me if I'm over.

C8 requires one visible, editable daily schedule for 12:15 Europe/Madrid. C9 requires the dispatcher to start one run after that time with no Otto browser tab open. C10 uses the corrected fresh-read condition from C380.v2. C1–C7 and C11–C14 retain their meanings. A pass on C380.v4 proves the daily connected-Sheet path. The valid C380.v1 run supplies separate evidence for the original late-morning wording.

The C380.v4 initial answer passed its spending and schedule checks. The temporary test process stopped when the Codex turn was interrupted before the 12:15 due run could be observed. Its disposable schema was removed. This is an environment interruption, so C380.v4 has no full-case score.

## Interrupted-run replay C380.v5

C380.v5 keeps the C380.v4 setup, answer key and checks. It changes only the due time so the normal dispatcher can run again on the same day:

> Using my spending Google Sheet, tell me what I spent this week by category and how that compares with my monthly budget. Then check it every day at 12:20 Europe/Madrid and tell me if I'm over.

C8 and C9 use 12:20 Europe/Madrid. All other checks keep their C380.v4 meanings. Score C380.v5 from a new isolated task, account and due run.

C380.v5 is red on C11. Its due run started 1.411 seconds after the due time, read the Sheet again, and saved a verified Transport €25 over-budget observation. It sent no alert. The schedule asked for an alert when a category exceeds its budget. The unchanged value did not cancel that current-state rule.

## Current-state alert replay C380.v6

C380.v6 keeps the C380.v5 setup, answer key and checks. It changes only the due time for another same-day run:

> Using my spending Google Sheet, tell me what I spent this week by category and how that compares with my monthly budget. Then check it every day at 12:26 Europe/Madrid and tell me if I'm over.

C8 and C9 use 12:26 Europe/Madrid. All other checks keep their C380.v5 meanings. The fix tells Otto to send an alert on each due run that meets a current-state rule, unless the user asked to suppress repeats. A change-only rule still requires a verified change. Score C380.v6 from a new isolated task, account and due run.

C380.v6 passed C1–C14. Its normal due job started 0.340 seconds after 12:26 with no Otto browser open. It read the Sheet, saved a verified current-month observation, sent one Transport €25-over alert, and made no Sheet write. The initial and due messages each showed elapsed time and recorded cost. Its initial schedule kept the baseline in prompt text but did not save a structured baseline observation. This run proves the daily alert result; it does not by itself prove behavior when `record_schedule_observation` returns an unchanged previous value.

## Account-choice regression replay C380.v7

C380.v7 keeps the C380.v6 setup, answer key and checks. It changes only the due time for a same-day run on the code that also includes the account-choice instruction:

> Using my spending Google Sheet, tell me what I spent this week by category and how that compares with my monthly budget. Then check it every day at 12:37 Europe/Madrid and tell me if I'm over.

C8 and C9 use 12:37 Europe/Madrid. All other checks keep their C380.v6 meanings. Score C380.v7 from a new isolated task, account and due run.

C380.v7 passed C1–C14 in one isolated run with the real agent and the synthetic Sheets account. The first answer named and linked **September spending test**, gave all three fixed totals, and identified Transport as €25.00 over budget. It saved one daily schedule and a structured, verified baseline observation. The normal dispatcher started the due task 0.698 seconds after 12:37, with no Otto browser open. The task read the Sheet again, saved a verified observation, received the unchanged previous baseline, and sent one Transport over-budget alert. The integration audit recorded no Sheet write. The initial and due tasks succeeded; each final answer showed elapsed time and cost. The run record is in the ignored local evidence directory.

## Holdouts

H1 asks, “Which subscriptions did I pay for this month?” in the same connected Sheet. It passes when Otto names both Software payments, €20.00 each, with the Sheet link and no other payment. H3 has two synthetic Google Sheets accounts, both with the same fixed Sheet. It asks, “Find my Google Sheet named September spending test. Tell me this week's spending by category and which monthly budget is over. Do not edit it.” It passes when Otto asks which account to use, then finds the named Sheet in the selected account, gives the three fixed totals, names Transport as €25.00 over, links the Sheet, and makes no write. H1 and H3 are the required holdouts for the connected-Sheets case. H2 is an unrun extension: it gives the same data in a Drive CSV and asks for the category and budget comparison. It passes when the three totals and the €25.00 overage match C380.v1, without a Sheets read. Keep the prompts, files, and answer keys fixed before the first holdout run.

H1 passed on the C380.v7 build. The answer named Figma and Notion at €20.00 each, gave the €40.00 total and linked the Sheet. The first H3 attempt gave the right totals, source and no-write result, but used the first account without asking. Earlier tasks in that conversation had already used that account and the same Sheet. This context makes the account-choice check invalid. H3.v2 keeps the same prompt and answer key, but connects both accounts before the first chat task in a fresh isolated run. It scores the account question only in that clean state.

H3.v2 is red on the account question. The fresh app tool search returned both synthetic account labels. Otto used the first connection without asking, then gave the right Sheet result. H3.v3 keeps the H3.v2 setup, prompt and answer key. It repeats the fresh run after a general account-selection instruction: ask for a choice before the first account read when several accounts fit and the user did not select one.

H3.v3 passed. Otto asked which of the two synthetic account emails to use before a Sheet read. After the user selected the second account, all three Sheet reads used that account. The answer gave the fixed totals, the €25 Transport overage and the Sheet link, with no write.

## Google Sheets connection experience

This is a separate user-facing gate. It applies to private Sheets. A public link can be read through the browser when the page permits access.

| Check | Pass condition                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| U1    | If several connected Google accounts fit, Otto lists their account labels in chat and asks which one to use before it reads.     |
| U2    | If no account fits, chat shows one Google Sheets connection action and no manual Apps setup step.                                |
| U3    | First-use authorization goes to Google's account choice and consent under Otto's own OAuth app, without a Composio-branded page. |
| U4    | After consent, Otto returns to the same chat task and continues without a second user request.                                   |
| U5    | A Sheet name or pasted link leads to the selected Sheet's exact title and source link in the answer.                             |

The synthetic chat run proves U2 and U4. H3.v3 proves U1 and the name path with two synthetic accounts. It does not prove U3 because the fixture uses synthetic consent. The current Composio connection uses its hosted link. Composio's [authentication guide](https://docs.composio.dev/docs/authentication/white-labeling-authentication) describes Connect Link branding and a custom Google OAuth app for an Otto-branded consent screen. A tested provider setup is still needed to remove the Composio page. Keep this UX gap apart from the synthetic LAB-380 spending score.

## Run record

Record the commit, model, prompt hash, fixture version, account ID, task IDs, schedule ID, expected due time, actual dispatch and reply times, integration reads and writes, each check result, cost, and UI evidence under the ignored local evidence directory. Keep the baseline red attempt when a fix is made. Before each fix, record the failing check, a cause hypothesis, predicted trace, and evidence that would reject it. Repeat the frozen case and holdouts after the fix.
