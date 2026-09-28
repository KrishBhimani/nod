# Conversation-routing failure diagnostics — 2026-09-28

The merged production release `a00bb2ec89be495edf105045d7c5b17753bf2b1d` passed automatic deployment, but its first controlled ordinary chat submission was rejected before work was accepted. The cause remains unproven. The failure-metadata change passed local validation and manual deployment as `fadb546af0746a5ba72bfeb057fec795e97c4187`; a warmed-state chat submission and an ordinary arithmetic question succeeded. Actual production failure-metadata capture remains unverified.

## Observed production boundary

[Main CI 36383014550](https://github.com/n8n-io/sidekick/actions/runs/36383014550) passed all three jobs. Its automatic [production deployment 36383810111](https://github.com/n8n-io/sidekick/actions/runs/36383810111) completed successfully at 06:05:08 UTC, with actual publication, role-rollout verification and exact-release health/public authorization checks; it was not a superseded skip.

An existing PDF attachment from the preceding manual acceptance still opened and rendered page 1 in the browser client left open across this rollout, without reloading. This proves retained artifact rendering, not new browser execution or acceptance of a new chat request.

Using an existing authorized Google session, a bounded check confirmed the exact release, primary agent model, current conversation revision and no active work before one ordinary `POST /api/messages`. The state preflight warmed the tenant. The request returned HTTP 503 with the fixed tenant error after 2.802 seconds. Read-only SQL found no matching accepted message or task. No retry was submitted by this check.

One failed historical outcome was present. Source inspection shows that unavailable or invalid conversation routing fails closed with HTTP 503 when blocked history exists, before message/job persistence. `llmReady` indicates a configured key, not successful routing initialization or provider access. The agent and routing models have separate settings.

## Isolated diagnostic

A separate classification-only call used the frozen routing context, unchanged router and locally held production model configuration. It made one model HTTP request, returned HTTP 200 and a valid conversation decision in 1.198 seconds, with nine output tokens. It submitted no application request, task or tool action.

This did not reproduce the production failure. It does not establish that the deployed configuration or transport matched the local call, and it does not identify the earlier refusal's cause. The measured production refusal was shorter than the configured five-second routing deadline; this evidence does not justify increasing that deadline or relaxing blocked-work fencing.

## Diagnostic change and validation

The change adds fixed failure codes and optional HTTP status to existing bounded model/timing/usage metadata, including failures during lazy router initialization. Only strict failed/cancelled `relevance/conversation_route` records without task/tool references can persist while Inspector is disabled. They remain private and owner-scoped, share the nonblocking limit of 128 pending writes and expire under the existing seven-day retention policy. Prompts, outputs, raw errors, causes and keys are excluded. Inspector endpoints remain gated; routing policy, public errors, retries and deadlines are unchanged.

Capture remains best effort: caller cancellation is prompt, but a provider operation that never settles can leave no receipt. Late settlement remains cancelled and emits at most one observation; this change does not alter provider cancellation behavior.

A subsequent naming refinement replaces `provider_response` with `response_processing`. `transport` means the request failed before response headers arrived; `response_processing` means headers arrived but completion failed, including non-2xx, body-stream, parsing or provider-event failures. These categories describe the observed phase, not causal blame. The live checks below apply to `fadb546a`; [PR #9](https://github.com/n8n-io/sidekick/pull/9) tracks subsequent final CI, manual and automatic publication receipts.

- Initial local validation passed: 13/13 router and 10/10 usage fixtures; 1,356 of 1,360 aggregate tests passed with four native-only skips and zero failures, plus types, architecture, formatting and frontend build. Cloudflare type checking, all 403 fixtures and both development/production dry runs also passed. These checks do not establish live diagnostic capture.
- The naming refinement passed 14/14 router and 10/10 usage fixtures. Its new regression failed before the refinement and passed afterward: the actual SDK received an unchanged HTTP 200 response, read one SSE frame and then encountered a body-stream error. The observation reported `response_processing` without raw error content, a second request or response wrapping.
- Final local aggregate after the naming refinement passed: 1,357 of 1,361 tests, four native-only skips, zero failures, plus build, types, architecture and formatting.
- Manual deployment, one warmed-state chat check and an ordinary UI question passed as recorded below; actual production failure-metadata capture/readback remains unverified.
- Root cause of the original pre-persistence refusal: unresolved.

## Manual deployment and chat check

Manual deployment of `fadb546af0746a5ba72bfeb057fec795e97c4187` passed at 06:35:44.505 UTC on 2026-09-28. After the owned-state preflight warmed the tenant, a new one-shot ordinary `POST /api/messages` returned HTTP 200 in 2.917 seconds. Read-only SQL confirmed one exact owned web reply, zero tool events and successful completion in the first observation. The existing in-app browser client displayed that reply without reloading.

On the same release, an ordinary question entered through the existing browser UI asked for 17 times 23 and received the correct answer, 391, without reloading. The read-only/SSE observer confirmed owned web-task success, two streamed text frames and zero artifacts.

These `fadb546a` checks establish the recorded chat successes. They do not identify or prove a fix for the earlier refusal. No routing failure was triggered, so they do not establish live failure-metadata capture or acceptance of the later naming refinement.

The earlier [browser-download acceptance](2026-09-28-browser-download-completion.md) remains separate. Production still uses the temporary split Cloudflare computers; E2B funding/keys/live acceptance, Gmail authorization, Telegram delivery, Slack consent/demo delivery and operator privacy requirements remain open.
