# Production chat and automatic-deployment acceptance

Checked on 2026-09-27 against `https://sidekick.n8n-maintenance.workers.dev`. The accepted merged release is `6e0a3aab02f42fd453bb5af9fbf0bd802eae083c`. This records the running Cloudflare-computer pilot; it does not establish live E2B behavior or complete hosted-product acceptance.

## Repairs and local validation

The computer adapter previously failed native command execution because of an execution-user override rejected in the deployed environment. Removing that override retained the image's unprivileged user. A separate routing defect attached fresh requests to interrupted tasks, preventing new work from starting. Routing now distinguishes independent observations from explicit retries and uncertain duplicate external actions. The server rechecks the latest task before accepting a continuation, including when a reply names an older successful task. Existing receipts and uncertain-action fences remain intact.

All 1,273 local application tests passed with no skips or failures on the final application source, together with repository checks, the frontend build and Linux container readiness/isolation validation. The final routing instructions passed 29 live development-model checks using synthetic context and the existing routing model; those checks performed no external actions and used no production conversation history.

## Ordinary production chat

The existing personal test account submitted ordinary requests through the production chat composer, without resetting its account or forcing a fresh task through an API:

| Request                                  | Observed result                                                  | Evidence scope                                                    |
| ---------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| Calculate 12 × 12 using the computer     | Actual shell output and answer were 144                          | One matched completed tool record                                 |
| Check current Lisbon weather             | Actual browser observations supported the sourced weather answer | Two browser calls, two completed records, no unresolved actions   |
| Open Example Domain and report its title | Actual page title and answer were Example Domain                 | One browser call and completed record on final PR head `f592bcc1` |

The final application source was manually deployed before merge. Original private execution checkpoints were downloaded through the authorized Cloudflare dashboard and checked against task identity, tool arguments, results and durable completion records. The prior failed task remained unchanged. These observed requests do not prove that every arbitrary browser task will succeed.

## Merge and automatic production deployment

[Final PR CI](https://github.com/n8n-io/sidekick/actions/runs/36351557922) passed all three jobs and automated review passed. [PR #3](https://github.com/n8n-io/sidekick/pull/3) was merged through the browser with the authorized override after manual production acceptance.

[Main CI](https://github.com/n8n-io/sidekick/actions/runs/36352346158) passed for the exact merged SHA. Its successful completion automatically triggered [production deployment](https://github.com/n8n-io/sidekick/actions/runs/36352918775) through `workflow_run`; no manual dispatch was used. The workflow published the images, drained tenants, deployed code and configuration, completed all container rollouts, and passed health and unauthenticated authorization checks at 21:57:54 UTC. It did not take the superseded-release skip path.

Independent post-deployment reads matched all four container applications to the three immutable Linux amd64 images for the merged release. There was no active rollout or pending image target. The deployment barrier was complete and health returned the exact release before and after verification. A local registry-authentication failure was separately diagnosed and resolved with a short-lived pull-only credential refresh; it did not change production configuration or trigger another deployment.

## Two-account persistence and ownership after deployment

Two existing Google accounts each submitted one fresh read-only shell task after the automatic deployment. Both read the same absolute synthetic path in their own computers and returned their different, unchanged original markers. Neither task recreated the file or published another artifact. Runtime generations advanced from 6 to 11 for the first account and 4 to 9 for the second.

Each original downloaded checkpoint matched its owner, task and SHA-256 identity and contained exactly one prescribed shell call, a matching completed record and the expected output, with no errors or unresolved calls. The original task and artifact returned HTTP 200 to their owner and HTTP 404 to the other account in both directions: four positive and four denial checks. Both original artifact downloads retained their exact 43 bytes. The existing Google-authenticated Sidekick session survived reload and displayed the retained conversation and new completed task.

Private evidence remains in ignored owner-only files; it includes user identifiers and execution contents and must not be committed. The HTTP assertions above come from the reviewed acceptance runner and its successful terminal record, rather than a second independent download of each response.

## Remaining gates

- Activate and live-test the selected E2B projects, combined templates, one-sandbox signup preparation, guest security boundary, cancellation and same-resource pause/resume. Existing Cloudflare files and browser profiles do not migrate automatically.
- Complete hosted Gmail/Calendar consent, actual signed event delivery, remaining app returns and integration ownership/approval checks.
- Complete dedicated Telegram bot setup, verified sender binding and actual message delivery.
- Verify the remaining production session, SSE, browser-profile, approval, schedule, cancellation and recovery cases; file persistence alone does not establish these.
- Finish collaborator access and publish/configure the reviewed operator privacy notice before broader sharing.

The [earlier hosted record](2026-09-26-cloud-hosting.md) retains the dated development checks and deployment incidents. The [provider setup record](../../research/provider-account-setup.md) and [production guide](../../production.md) describe the outstanding configuration and release gates.
