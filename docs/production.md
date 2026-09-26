# Hosted Sidekick

The repository includes Google login, account settings, isolated per-user Node runtimes, private tenant SQL roles, a Cloudflare container adapter and production CI/CD. This is a bounded pilot implementation. Automated fixtures and local process tests do not establish a working public deployment or live provider delivery; record those checks separately before sharing a production signup link.

## Deployment shape

```text
Browser / verified webhook
            |
Public Cloudflare Worker + static web assets
            |
Private Node gateway: Google sessions, accounts, tenant provisioning
            |
One private Node container per user, signed requests and expiring lease
            |
Private PostgreSQL role + app/jobs schemas
            |
E2B browser / E2B workspace     Owner-bound private R2 storage
```

The gateway authenticates the session before selecting an owner. Each tenant process has an immutable owner, its own SSE emitter and task workers, its own PostgreSQL login and application/jobs schemas, and a separate working directory. Schema permissions isolate child tables even where they have no owner column. Tenant roles cannot read another tenant or the control/auth schemas, create roles, or switch to another tenant role. Provisioning never adopts unrelated existing roles or schemas.

Control/auth database credentials, Google login secrets and the tenant derivation master key stay in the gateway. Actors receive derived database/vault credentials, signed-runtime identity and selected provider credentials. Provider credentials never enter the user's E2B command environment. Cloudflare's trusted container identity determines storage paths; caller headers cannot select another owner. Public ingress does not expose actor bootstrap or internal channel claims.

The pilot admits eight users and keeps one gateway plus up to eight tenant containers active. Minute Cron wakes the gateway; its persisted owner registry and periodic recovery restore registered tenants. Actors require signed SQL-backed lease renewal and self-fence on expiry. Replacement requires a confirmed stop of the exact prior generation. This is an always-running service. Increase admission, container limits, database connections and budgets together; the provisioner has an absolute 400-role ceiling.

## Operator configuration

Use distinct development and production Workers, Durable Object namespaces, private EU R2 buckets, PostgreSQL databases, Composio projects/auth configs, Google OAuth clients and E2B keys/templates. PostgreSQL initialization changes default public grants, so use a dedicated Sidekick database with a provisioner allowed to create login roles and schemas. Keep that credential out of actors and task computers.

| Configuration                                                                                 | Purpose                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `SIDEKICK_MODE=gateway`, `SIDEKICK_ENVIRONMENT`, `SIDEKICK_PUBLIC_URL`                        | Hosted entrypoint and fixed application origin                     |
| `DATABASE_URL`                                                                                | Dedicated control/auth database and tenant provisioning connection |
| `SIDEKICK_MASTER_KEY`                                                                         | Stable 32-byte key for tenant database/runtime/vault derivation    |
| `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                              | Login sessions and Google OAuth                                    |
| `SIDEKICK_MAX_USERS`                                                                          | Atomic admission limit, default eight                              |
| `SIDEKICK_DEVELOPER_IDS`                                                                      | Account UUIDs authorized for developer/computer views              |
| `COMPUTER_PROVIDER=e2b`, `E2B_API_KEY`, `E2B_BROWSER_TEMPLATE`, `E2B_WORKSPACE_TEMPLATE`      | Separate browser and command computers                             |
| `OBJECT_STORAGE_PROVIDER=http`, `OBJECT_STORAGE_ENDPOINT=http://sidekick.storage/v1/objects/` | Private Cloudflare storage broker                                  |
| Model keys/settings and `COMPOSIO_*`                                                          | Server-owned providers and enabled integrations                    |

Users choose which accounts to connect; startup configuration selects computer/model providers. The Google callback origin must match the deployed HTTPS origin. Profile, avatar and settings belong to the authenticated account; appearance is also accessible from the account menu. Hosted Inspector capture requires both `DEV_INSPECTOR=true` and an owner UUID in `SIDEKICK_DEVELOPER_IDS`; ordinary accounts do not persist Inspector prompts or tool payloads.

Cloudflare stores the gateway configuration as a compact JSON `GATEWAY_ENV` secret, limited to 5 KiB. Deployment validates origin/environment, injects the release SHA and keeps keys out of build arguments and web assets. The [Cloudflare runbook](../deployment/cloudflare/README.md) lists resources, token scopes, CI secrets, private RPC and deployment commands.

Self-hosting can use the Node gateway's local per-user process transport and a compatible PostgreSQL service. Local hosted actors store private objects and checkpoints in their own PostgreSQL schema by default. The optional filesystem adapter requires a durable private volume and manual stale-lock recovery after an interrupted writer. Computer/storage ports keep Cloudflare/E2B details outside product logic. Use development provider projects and disposable data to test this stack locally. Local process isolation assumes a trusted host; never expose the single-owner `local` mode publicly. See [replacing modules](replacing-modules.md) and [development](development.md).

## Durability and external actions

Tasks, jobs, schedules, event inbox/outbox and ownership live in PostgreSQL. Artifacts and Pi checkpoints use bounded private object storage with conditional writes. A stale checkpoint writer fails; a saved pre-action journal without a confirmed result prevents automatic replay. Failed conditional cleanup can leave a private orphan for reconciliation rather than delete a newer object. Cloudflare container disks are ephemeral working space.

Database idempotency does not make external writes or browser actions exactly once. A provider may accept an action before its acknowledgement is lost. Preserve uncertain outcomes and reconcile them rather than silently replaying. Browser/workspace allocations are separate and leased; unknown termination or competing ownership remains fenced. Fixtures do not prove that a real website permits automation.

The E2B workspace can execute arbitrary commands and reach its configured network. It receives no trusted provider keys, host Docker socket or authenticated browser profile. These separations do not prevent every prompt-injection outcome or replace provider network controls, quotas and monitoring. A browser screenshot is not a native operating-system desktop.

## Integrations and messaging

App connections use Composio authorization and owned callback attempts. Gmail/Calendar subscriptions, signatures, deduplication and owner routing need a real production event test; enabling a preference does not establish delivery. Keep development and production Composio credentials separate. Managed OAuth does not remove Google production consent/restricted-scope requirements. [Google OAuth production policy](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance).

Telegram setup verifies the bot identity, claims it for one Sidekick account, encrypts its credentials and uses an owner-bound webhook route. Another user cannot claim the same verified bot. The current form requires the user's numeric Telegram sender ID; one-time deep-link pairing and a verified test challenge are not implemented. Sender binding, webhook authentication and owned routing remain required. Test registration, receipt, a reply, disconnect and duplicate delivery in production. Uncertain remote webhook state or token revocation requires provider-side reconciliation. Local polling and synthetic fixtures are separate evidence.

WhatsApp needs its own current eligibility, pricing, account and template review; a working adapter is not worldwide production availability. Preserve reply-window limits, channel identity, account-bound approvals and uncertain-send behavior described in [channels](channels.md).

## CI/CD and rollback

CI checks root types/architecture/formatting, the full PostgreSQL fixture suite, client build, Cloudflare types/fixtures, both environment bundles and an amd64 Node image. Production follows successful CI for the current `main` revision, inside the GitHub `production` environment. Configure branch/environment protection so reviewed `main` code alone receives production secrets.

Deployment rebuilds an image from the exact CI-validated commit, then rechecks that it is still current on `main` immediately before publishing. It pre-pushes that commit-tagged release image and activates Worker code, image reference and `GATEWAY_ENV` through `wrangler deploy --secrets-file`. It does not promote CI's image artifact. Worker activation and container rollout are separate operations. Smoke waits for the exact release SHA from gateway health, then checks anonymous session/state access, private-route denial and foreign-origin POST rejection. CI does not log in to Google, connect apps or send messages.

A failed smoke does not trigger automatic rollback. Inspect the live Worker/image and tenant leases first. Keep one active generation per tenant; old code must support the current SQL schema, object/checkpoint format and key versions. Worker rollback does not restore PostgreSQL, R2, computer sessions or external actions. Preserve prior images and keys; prefer a forward fix after incompatible state changes. Startup schema setup is not a tested reversible migration system.

Treat derivation and encrypted-data keys as recovery material. Replacing one without coordinated credential rotation or re-encryption can make accounts unavailable. Back up required keys separately from PostgreSQL/R2 and test restoration. Secret changes also require a controlled process restart because running containers retain startup values.

## Release evidence

Automated suites cover SQL cross-schema/`SET ROLE` denial, session/CSRF boundaries, signed requests, actor fencing, owned callbacks/bot claims, object-store conflicts, checkpoint recovery, private routing and deployment ordering. Docker image and two-user process tests add local evidence. They are not Cloudflare, Google, Neon, R2, E2B, Composio or Telegram acceptance tests.

Before marking the pilot ready, record a real two-account check: signup/logout; profile/theme/mobile settings; each supported app returning to its original screen; chat streaming; inaccessible foreign task/file/SSE/vault IDs; Gmail/Calendar event receipt; Telegram setup/reply; browser/workspace pause/reconnect; restart with history/files intact; and a merged-main production release. Record commit, environment, provider and outcome without private content or credentials. Verify database/key restoration and cost limits separately before expanding access.

Measure always-running containers, database connections/storage/backups, private object bytes, E2B active/paused resources, model tokens, Composio tools/events and messaging usage. No fixed monthly cost or scale claim follows from the fixtures. Verify limits and plans for the actual deployment. [Verification guide](verification.md).
