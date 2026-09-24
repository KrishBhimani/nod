# Before hosting Sidekick

Sidekick is a loopback-only, single-owner prototype. A successful local task does not make it a hosted product. No public login, production database, deployment, or multi-user signup is provisioned.

## First hosted shape

After implementing the boundaries below, an initial deployment can use an application service, PostgreSQL, private object storage, and isolated task computers. Separate web/API capacity from workers as usage grows. Browser memory, concurrent tasks, and retained authenticated sessions determine capacity more than open chat windows.

```text
Authenticated app / verified channel ingress
                    |
             API + task broker
                    |
       PostgreSQL tasks, jobs, outbox
                    |
        Workers -> isolated computers
                    |
     Credential broker + private artifacts
```

This is a target architecture. The repository does not provision it. `npm run build` checks TypeScript and builds the client; production also needs reproducible server images, supervised processes, health checks, versioned migrations, and a tested rollback path.

## Required boundaries

| Area                    | Required work                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User accounts           | Replace `local-development` with authenticated identity and secure sessions. Authorize every task, file, event stream, credential, approval, and provider connection. Google consent and a configured bot sender are not app login.                                                                                                                                                    |
| Execution               | Isolate tenants with separate sandboxes, volumes, identities, quotas, and egress policy. Current tasks share one Linux user, container, and tool volume. Task folder names do not isolate hostile commands.                                                                                                                                                                            |
| Browser and credentials | Separate authenticated profiles, browser control, and decryption from unrestricted shell execution under a trusted service identity. Retain origin, form, revision, and observation checks.                                                                                                                                                                                            |
| Keys                    | Add managed key storage, rotation, access auditing, and recovery. Existing ciphertext needs the same key or explicit re-encryption. KMS does not hide plaintext from an operator controlling its authorized decrypting service.                                                                                                                                                        |
| Files and retention     | Use private artifact/profile/transcript storage with ownership checks, retention, deletion, and short-lived access. Never publish complete workspaces. Database content outside the vault/channel ciphertext remains sensitive. Disable developer capture with DEV_INSPECTOR=false; any future production inspector needs separate administrator authorization and a retention policy. |
| HTTP                    | Add HTTPS, authenticated ingress, session/CSRF controls, quotas, and abuse handling. Preserve raw webhook bytes, signatures, replay checks, account binding, and deduplication. Expose only intended public routes.                                                                                                                                                                    |
| Database                | Use restricted service credentials, versioned migrations, monitored queues, encrypted backups, and restore drills. Back up required key material separately under controlled access.                                                                                                                                                                                                   |

## Internet and computer access

The local workspace uses a separate firewall sidecar and runs without Linux capabilities or privilege escalation. It can access the public IPv4 Internet and install CLI packages; private/LAN/metadata destinations and external IPv6 are blocked. This is a useful local boundary, not a tenant sandbox or protection against public data exfiltration.

A production policy must decide which destinations, package registries, and downloads are allowed, and how to limit cost, malware, and resource use. Public egress can carry files, prompts, or other data the agent can access. The workspace has no provider environment, host Docker socket, or authenticated browser profile, but those exclusions alone do not prevent every prompt-injection outcome.

Native Mac/Windows applications and a GUI desktop are not implemented. A future shared desktop would also need exclusive coordination for its physical input state. A browser screenshot is not a remote operating-system desktop.

## Workers and uncertain outcomes

The API, four task workers, pg-boss scheduler, heartbeat, and channel scans currently share one Node process. The machine must stay awake. Stored schedules survive restart, but exact execution time and replay of every missed occurrence are not guaranteed.

Before running several replicas, add leases, worker ownership, scheduler coordination, graceful draining, and reconciliation. Current startup recovery assumes one process and can mistake another process's work for interrupted work. Persist waiting states and release workers rather than keeping long credential or approval requests open.

Database idempotency prevents duplicate internal dispatch. It cannot make external API writes or browser actions exactly once. Use provider idempotency keys where available and retain approval/result records. The channel outbox stops retries after uncertain sends; add an operator recovery flow and backoff for failures known to be retryable.

## Google and messaging

Composio holds managed OAuth tokens. Review its access, retention, scopes, event usage, and actual account plan. Google production consent can require verification or additional assessment for sensitive/restricted scopes. Managed OAuth does not remove those obligations. [Google production OAuth policy](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance).

Multi-account actions and approvals must preserve a specific account binding throughout review and execution. Provider replacement requires revocation/reconnection and cannot silently adopt old account or subscription IDs. Gmail/Calendar watch preference being enabled does not prove an active subscription or webhook delivery. See [Google connections](composio.md).

Channel setup verifies a bot/business credential and stores it encrypted. It does not prove ownership of the user-entered recipient ID, public webhook reachability, or end-to-end delivery. A public bot needs secure account pairing, tenant routing, consent, revocation, quotas, and abuse controls.

Telegram local polling requires no public ingress. Webhook deployments should expose only the signed callback route. Telegram webhook registration and local persistence are separate operations; failures may require checking both systems. Disconnecting locally does not revoke a token or remove the remote webhook.

WhatsApp needs a current market-specific eligibility and pricing review, approved account configuration, reply-window handling, and templates if proactive messages are required. The prototype accepts text from one configured owner and sends free-form replies only within 24 hours. An operator confirmation checkbox or working SDK is not worldwide eligibility. [Channel setup and limits](channels.md).

Messaging channels have no remote task chooser when several ordinary questions are waiting. Resolve ambiguity in the web app. Secure credentials, approvals, and attachments also remain local. Delivery receipts, media transport, and operator resend tools are not implemented.

## Cost and evidence

Budget for application and worker compute, PostgreSQL/backups, private file/profile storage, and bandwidth. Add model, speech, optional Jev, Composio tools/events, and messaging-provider usage. Trigger checks and hourly reviews can cost money even when no notification is sent. Tool installs, browser observations, long histories, retries, and retained artifacts also affect usage.

No fixed monthly estimate is validated for this workload. Measure task time, model usage, events, stored bytes, and actual provider bills; then price the hosting region and plans. Existing Composio accounts may have different terms. [Composio pricing](https://composio.dev/pricing).

Use [verification](verification.md) to distinguish synthetic checks from live provider evidence. Local network tests and a live Gmail label read do not validate every integration, deployment, or adversarial page.
