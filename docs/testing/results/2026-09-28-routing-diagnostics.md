# Conversation-routing failure diagnostics — 2026-09-28

The merged production release `a00bb2ec89be495edf105045d7c5b17753bf2b1d` passed automatic deployment, but its first controlled ordinary chat submission was rejected before work was accepted. The cause remains unproven. The new failure-metadata change passed local validation; deployment and production readback remain pending.

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

- Local validation passed: 13/13 router and 10/10 usage fixtures; 1,356 of 1,360 aggregate tests passed with four native-only skips and zero failures, plus types, architecture, formatting and frontend build. Cloudflare type checking, all 403 fixtures and both development/production dry runs also passed. These checks do not establish live diagnostic capture.
- Deployment and actual production failure-metadata readback: pending.
- Root cause of the original pre-persistence refusal: unresolved.

The earlier [browser-download acceptance](2026-09-28-browser-download-completion.md) remains separate. Production still uses the temporary split Cloudflare computers; E2B funding/keys/live acceptance, Gmail authorization, Telegram delivery, Slack consent/demo delivery and operator privacy requirements remain open.
