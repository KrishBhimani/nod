# Apps, chat and Inspector checks

Date: 2026-09-25. Changes and tests are local. The normal owner's accounts and chat were not reset.

## Test environment

The isolated acceptance app used the real GPT-6 Sol agent, GPT-6 Luna conversation router, Chromium browser, PostgreSQL queue and Linux workspace. Gmail, Slack, Notion and website authentication used synthetic fixtures. Channel transports were disabled. No email or Slack message was sent to a real recipient.

The configured OpenAI models answered live smoke requests. Claude Sonnet 5 is a supported configured default, but Anthropic was not tested with a live key in this run.

## Observed flows

Durations run from the received chat request to the observed terminal execution state. These individual samples include model and queue time and are not performance guarantees.

| Request                                    | Result                                                                                                                                                                 | Duration                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Find the last sent email                   | Read the sent mailbox and returned the current synthetic NS-2048 message, recipient, Lisbon time and attachment name.                                                  | 8.051 s                          |
| Send the attachment from that email        | Resolved the follow-up to the sent email and delivered the correct private CSV attachment without an action-review page. The file was persisted after 8.408 s.         | 11.120 s                         |
| Find Northstar updates in Slack and Notion | Read both connected synthetic accounts and summarized their results. The fixtures returned no source URLs; the assistant stated that limit instead of inventing links. | 14.409 s                         |
| Open a browser page and send a screenshot  | Published a masked image attachment through the real browser and artifact path. The destination was the harness fixture, not a public website check.                   | 10.622 s                         |
| Open the manual-control form               | Opened the synthetic form and left it untouched. Separate-window viewing, Take control and Resume agent were checked.                                                  | 7.190 s                          |
| Display five image attachments             | An API-seeded message displayed four bounded tiles and a +1 badge. The viewer opened, advanced to image five, showed details and disabled Next at the end.             | 3.841 s to model acknowledgement |

Pending image previews, keyboard image navigation, removed-upload cancellation and blob cleanup have DOM fixture coverage. The five-image live check used the real upload/message endpoints to seed a sent message; it does not prove a live clipboard or file-picker interaction.

The typing indicator displayed the agent avatar. Common reactions opened in an inline strip; a selected heart persisted. Apps displayed Gmail, Calendar, Drive, Sheets, Docs, Slack and Notion with a Connect or Add account action on each service. The tested consent pages were synthetic.

Costs showed one provider row with expandable operation/model detail and a single ledger subtotal. Unknown prices stayed unavailable. Activity showed current work and saved upcoming schedules. The standalone browser window shared the same capture and control path, without duplicate follow-current-browser copy.

## Navigation and refresh

Apps, Goals, Schedule, Channels and Vault headers have no refresh icon. Cached pages keep their last good state during automatic reads. Channels reloads status on focus and after an accepted setup change. Vault metadata uses the same cache, and an accepted save or deletion updates it before revalidation.

Live DOM checks at nine points on each sidebar navigation/control item returned the same pointer target and cursor. SVG children do not handle pointer events or transform on hover. Consecutive grouped assistant messages had a 28 px gap from prior text to the next message, reduced from the previous 43 px.

## Browser failure and recovery

The reported X failure was reproduced in an isolated real Chromium profile. X returned HTTP 403 / `ERR_HTTP_RESPONSE_CODE_FAILURE`; a command-line GET returning 200 did not make the browser navigation succeed. The app had hidden this diagnostic behind a generic failure and could then inspect Chrome's internal error page.

The browser adapter now retains a bounded navigation failure, prevents stale screen/form reuse, and recovers through an explicit later navigation. Runtime and Inspector expose a fixed readable error without raw provider output. The screen pauses failed capture until a retry or new activity. Ordinary public navigation, screenshot capture, cancellation/reopen and process-restart recovery passed in an empty synthetic profile. No login or bookmark access on X was achieved.

## Action and reaction boundaries

Ordinary known app operations use the current owner's request and account scope. Draft-only requests do not authorize sends. Unknown and destructive operations store their exact action, arguments and selected account and ask in chat. A yes/no reply is bound to that confirmation, channel, conversation generation and execution revision. Execution runs in a worker, outside the message-ingress transaction; uncertain outcomes are not replayed. Approval HTTP routes and the separate approval page are removed.

Assistant reactions are optional and limited to visible owned user messages during a direct-user web segment. The server enforces one reaction per message and a durable five-minute cooldown. Removal does not permit another reaction to the same message. Background runs and external channels skip this tool. There is no live Telegram or WhatsApp reaction support in this change.

## Chat action acceptance

A fresh isolated app used the real model and synthetic Gmail consent. It created one stored Gmail draft in 10.837 s, with no send receipt and no review page. A deletion request showed one specific chat question after 10.500 s. Replying No completed in 1.839 s and produced no delete receipt. A new deletion request produced a new question; replying Yes executed the exact stored deletion once and finished in 1.789 s. No duplicate confirmation boilerplate appeared in either segment.

A separate explicit email-send request completed in 8.957 s without an extra confirmation. The synthetic receipt ledger contained exactly one draft creation, one deletion and one send. All three used the selected synthetic account; none delivered externally. A subsequent fresh `GMAIL_LIST_DRAFTS` read confirmed the deleted draft was absent and left the receipt count unchanged. The confirmation question still includes technical target identifiers when the app tool supplies no human-readable target label.

Secure/manual continuation authority and late credential-callback revision checks were verified with disposable database fixtures. This acceptance session did not repeat a live credential entry after that final revision guard. The policy applies to connected-app and personal mutation callbacks; browser clicks retain the existing bounded tool and model instructions rather than a general server-side destructive-click classifier.

The full-suite check also exposed a database/app clock mismatch in expired Vault form labels. The fixed read path uses PostgreSQL expiry, matching submission and retry. A clock-skew regression reproduced the issue before the fix and passed afterward.

## Final automated validation

- `npm run check`: passed TypeScript, import boundaries and formatting.
- `npm run build`: passed. The existing client chunk-size warning remains.
- `npm run test:integration`: 436 passed, zero failures and zero skipped, in 70.631 s. This run includes the final Vault clock-skew fix.
- `git diff --check`: passed.

The disposable acceptance schema and container were removed after recording results. The normal local app responded with GPT-6 Sol configured and ready. No push or deployment was performed.

## Limits

Synthetic account tests do not prove real OAuth consent, provider delivery, real credentials or 2FA. Earlier authentication and timed-schedule evidence is retained in the other reports in this directory. X's browser denial remains a remote-site limit. Provider cost estimates are not invoices; prices that adapters do not report remain unknown. Local schedules require the app and Mac to be running.
