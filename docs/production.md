# Before hosting Sidekick

This repository is a loopback-only, single-owner prototype. A successful local browser task does not make it a hosted product. No deployment, public domain, production database, or multi-user signup is provisioned.

## A practical first hosted shape

After the boundaries below are implemented, a small initial deployment can use one application VM, PostgreSQL, private object storage, and isolated task computers. Keep the web/API process separate from worker capacity as usage grows. Browser memory, concurrent tasks, and idle authenticated sessions determine compute needs more than the number of open chat windows.

```text
Authenticated web / verified channel ingress
                    |
             API + task broker
                    |
       PostgreSQL tasks, jobs, outbox
                    |
       Workers -> isolated computers
                    |
    Credential broker + private artifacts
```

This describes a target architecture, not infrastructure included here. `npm run build` currently checks TypeScript and builds the web client. A hosted release also needs a reproducible server image, supervised processes, health checks, versioned migrations, and a tested rollback path.

## Required boundaries

| Area | Required change |
| --- | --- |
| Accounts | Add signup/login and secure sessions. Replace the fixed `local-development` owner with verified user IDs. Authorize every task, file, event stream, credential request, approval, and provider connection against that identity. OAuth connection consent is not app login. |
| Execution | Give each tenant an isolated sandbox or VM, separate volumes, resource quotas, and controlled egress. All task folders currently share one offline Linux container and Unix user. A folder name does not isolate hostile shell commands. |
| Browser and vault | Keep authenticated profiles, browser control, and credential decryption outside the unrestricted shell. Use a separate trusted service identity. Preserve exact-origin checks, serialized credential entry, and hidden observations during injection. |
| Keys | Replace local Keychain handling with an appropriate secrets service and KMS envelope encryption. Add rotation, access auditing, and recovery. KMS does not hide plaintext from an operator who controls the authorized decrypting service. |
| Files | Put artifacts in a private object store with owner checks, short-lived access, size limits, retention, and deletion. Do not mount or publish complete workspaces. Browser profiles and task transcripts need private persistent storage too. |
| HTTP | Add HTTPS, authenticated app ingress, CSRF/session controls, request limits, and abuse protection. Retain signature verification over original webhook bytes, replay protection, account binding, and task deduplication. Expose only explicitly intended public routes. |
| Database | Use restricted service credentials, migrations, encrypted backups, restore drills, retention policies, and monitored queue growth. Back up the data and necessary key material through separate controlled processes. |

Native Mac control is not part of this runtime. Browser tasks can use separate sessions; a future shared desktop's physical mouse and keyboard would require exclusive coordination. A browser screenshot is not a remote computer desktop.

## Workers, schedules, and recovery

The prototype runs its API, four task workers, pg-boss scheduler, heartbeat, and channel scans in one Node process. The Mac must remain awake and that process must run for timed work. Stored schedules survive a restart, but this is not a promise to run at the exact wall-clock time or to replay every missed occurrence.

Before using several replicas, add explicit worker ownership and leases, scheduler coordination, graceful draining, and reconciliation. Some current recovery logic assumes one process and can classify another process's work as interrupted. Keep durable task segments short: waiting for an approval or credential should persist a waiting state and release the worker.

Database idempotency prevents duplicate internal dispatch. It cannot make a browser click or external API write exactly once. Preserve approval records, provider idempotency keys where available, and review states for ambiguous outcomes. The channel outbox already stops automatic retries after an uncertain send. Add operator recovery tools and safe backoff for failures that are known to be retryable.

## Google and messaging connections

Use separate development and production configurations, verified callback ownership, explicit toolkit/action permissions, and connection revocation. Audit the exact Google OAuth scopes for the actions offered; sensitive or restricted scopes can require verification and additional assessment. Managed OAuth does not remove these obligations or guarantee every required scope was granted. [Google production OAuth policy](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance).

Composio holds the OAuth tokens in the current design. Review its retention controls and the private data sent to provider tools and models. Gmail/Calendar changes use polling triggers, so notification timing has provider latency. See [Google integration details](composio.md).

The current Chat SDK channels accept one allowlisted owner and text only. Public bots need account pairing, tenant routing, per-user consent, quotas, revocation, and abuse handling. WhatsApp needs a market-specific eligibility review, current account/policy approval, reply-window handling, and any applicable templates. Neither a working adapter nor the local confirmation flag proves worldwide eligibility. [Channel requirements and limits](channels.md).

## Cost structure

Budget for a base application VM, PostgreSQL and backups, private file/profile storage, and bandwidth. Add worker or sandbox compute for simultaneous tasks and any computers kept warm while idle. A single VM can reduce an early fixed bill but is one failure domain and does not provide tenant isolation by itself.

Variable costs include the selected OpenAI/Anthropic model, speech, optional Jev requests, Composio API calls and delivered events, and messaging-provider usage. Trigger checks and quiet goal reviews can still cost money even when no notification is sent. Repeated browser observations, long task histories, retries, screenshots, and artifact retention affect usage.

No fixed monthly estimate is validated for this workload. Measure active task time, model usage, events, stored bytes, and provider bills during the local pilot; then price the chosen hosting region and plans. Existing Composio accounts can have different plan terms, so check the actual account against [current Composio pricing](https://composio.dev/pricing). Set tenant budgets and service limits before a public launch.
