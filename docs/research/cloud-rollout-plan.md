# Sidekick cloud rollout: proposal for review

Research and prototype date: **2026-09-26**. Starting revision: `1a471a0`.

**Selected UX: A — Quick start**, following the user's review on 2026-09-26. Remove the privacy reassurance, login-versus-Google-app explanation, hosting credit and design-preview label from the login screen. Permission details remain at the relevant app connection step.

**Architecture recommendation:** keep Sidekick's current stack, add Google login and complete user isolation, host the application in Cloudflare Containers behind a small Worker, and use managed PostgreSQL plus private object storage. Evaluate E2B and Cloudflare for remote computers before selecting the production default. Preserve local Docker and provider replacement.

This branch contains research and a disposable UI prototype. Authentication, tenancy, provider provisioning, deployments and production acceptance are **not implemented** here. Existing application instructions still describe the working single-owner product. The user requested a review before those changes.

## Review the experience

```sh
npm ci
npm run prototype:cloud
```

Use the repository's supported Node version, **24.21.0 or newer**. The prototype runs at [localhost:4318](http://127.0.0.1:4318/?variant=A), without Docker, PostgreSQL, credentials or external services. It is a separate Vite entry point under `src/web/prototypes/cloud-signup`; the normal application route is unchanged. All data stays in memory and resets on reload.

| Direction                     | Signup                                                      | Account access                                              | Tradeoff                                                            |
| ----------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| **A — Quick start, selected** | Google login, optional Gmail/Calendar connection, then chat | Sidebar account menu opens Profile and Settings in a dialog | Small change to the current product; setup is visible and skippable |
| B — Guided setup              | Separate account, app and preference steps                  | Dedicated Account & settings page                           | More orientation, more steps before useful work                     |
| C — Chat first                | Straight into a conversation                                | Account settings open alongside chat                        | Fastest entry; app setup is easier to overlook                      |

Switch with the bottom bar or `?variant=A`, `B`, or `C`. **Scenarios** exposes cancelled/expired login, separate demo users, connection setup and event delivery, reconnect, Telegram pairing, computer failure, and an unavailable item. It also shows the current simulated state. The prototype makes no provider calls and must not collect real credentials.

Review the full route: sign in → connect or skip → chat → Apps → Channels/Telegram → Computer → sidebar account → Profile/Appearance. Existing Chat, Goals, Schedule, Apps, Channels and Vault remain familiar. The new computer entry describes readiness and takeover; infrastructure settings remain an advanced option controlled by the host.

Product requirements reflected in the design:

- Google login identifies a Sidekick user. It does not grant Gmail/Calendar access. Connected accounts can differ from the login account.
- No model, Composio, database or computer-provider keys in ordinary hosted-user setup. Those belong to the operator. A user-owned Telegram bot still needs its own token/pairing unless a separately validated managed-bot flow replaces it.
- Connection permission, subscription setup, received events and processed events are different states. The UI must not call a configured integration a verified delivery path.
- The assistant keeps user content central. Provider errors lead to reconnect/retry actions; ordinary users do not configure webhook URLs or database details.
- Profiles, appearance, time zone and preferences are account-scoped. Signing out clears browser data and control access; it need not cancel explicitly scheduled background work.

## Recommended pieces

| Piece              | Proposal                                                                                             | Why and qualification                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Public origin      | Cloudflare Worker, static assets and HTTPS domain on Jan's account                                   | Small deployment-specific ingress; the account, domain and access are not verified                                                      |
| API and agent jobs | Existing Fastify/Pi Node image in Cloudflare Containers, separate API/worker roles                   | Preserves the stack and can run on another container host; prove lifecycle/streaming first                                              |
| Login              | Better Auth with PostgreSQL sessions and Google                                                      | Fits Fastify and portable hosting; pin and validate the integration rather than inventing auth                                          |
| Database           | Neon PostgreSQL in an appropriate EU region                                                          | Standard PostgreSQL; direct worker/migration connections initially; separate development/production projects                            |
| Durable files      | Private R2 behind a storage interface; local filesystem adapter retained                             | Containers lose disk on restart. Transcripts, artifacts and browser recovery need explicit persistence                                  |
| Apps               | Existing Composio adapter with separate environment projects, keys, auth configs and webhook secrets | Preserves account selection and tools while adding immutable user ownership                                                             |
| Remote computer    | First candidates: E2B Desktop and Cloudflare with separate trusted-browser and shell environments    | Choose after a measured bake-off. Daytona is an alternative; browser-only services do not automatically satisfy private desktop sign-in |
| Telegram           | Existing transport with per-user encrypted bot configuration, explicit pairing and webhook delivery  | Reuse the durable inbox/outbox; remove fixed-owner/global bot assumptions                                                               |
| Models             | Existing provider ports and server-side configuration                                                | Reuse suitable existing operator keys; users supply their own connected accounts, not model credentials                                 |

The hosting recommendation is an architectural judgment, supported by Cloudflare's [container runtime and lifecycle documentation](https://developers.cloudflare.com/containers/faq/) and Better Auth's [Fastify integration](https://better-auth.com/docs/integrations/fastify). See the detailed reports for current constraints and source-linked comparisons.

## Findings that change the implementation

**Login is only the entry point.** The source uses `local-development` as the owner, broadcasts SSE globally, and has unowned channel inbox/outbox records and global recovery logic. A login screen over this would remain unsafe. Every request, queue job, stream, account, file, approval, vault operation and computer lease needs an immutable user context. Add application authorization, same-owner database references and fail-closed RLS with a restricted runtime role. Test cross-user access with concurrent users and guessed IDs, not just normal reads.

**The API/worker split needs a cross-process event feed.** Replace the process-local event bus with an owner-scoped durable event/outbox mechanism and replay cursor. Persist job intent before wake-up, route to known worker identities, reconcile pending work, and use renewable leases and graceful draining. Restarting a replica must not interrupt another replica's work. The detailed hosting report specifies the proposed wake/recovery design.

**“Webhook” does not mean instant Google push.** Sidekick's current Gmail inbox and primary Calendar triggers poll at a requested 15-minute interval, then Composio delivers events to Sidekick. Managed OAuth has polling limits. The first release can use those triggers honestly; near-real-time native Gmail Pub/Sub and Calendar watch channels are a separate design with renewal, history/sync tokens and more Google infrastructure. [Composio triggers](https://docs.composio.dev/docs/triggers), [managed versus custom OAuth](https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app).

**Public Google access needs the correct audience and consent setup.** Basic sign-in and Gmail/Calendar authorization have different requirements. Personal Gmail cannot use an Internal-only OAuth app. Custom public Gmail OAuth can require restricted-scope verification and security assessment; managed Composio OAuth still requires deliberate data handling, scopes and retention. Do not promise a launch date before resolving the chosen consent path. [Google restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

**Computers are private execution environments.** Preserve the separation between the trusted browser and unrestricted shell. Provider credentials and database keys stay outside both. Browser viewer access goes through owned, short-lived app authorization, with private input excluded from model captures and logs. Provider switching starts a new environment; it must not silently transfer browser credentials or retry an uncertain action elsewhere.

**Shared keys need usage controls.** Inventory existing keys without recording values, then provision only the selected server services. Production Composio needs its own project/key rather than importing development accounts. Add user concurrency, request/body limits, model/computer budgets and actionable operator diagnostics before opening public signup. Provider retention, regions, export/deletion and secret rotation are part of the hosting contract.

## Cost and provider choice

The remote computer is the material variable. The E2B configuration considered here uses two separate 2-vCPU/4-GiB environments: approximately **$0.3312 per active pair-hour**, plus **$150/month** for a Pro project. Those are aggregate running hours across all users. EU availability, separate development projects, storage and limits need account verification. Daytona has a material network-policy tier/top-up gate. Cloudflare may reduce vendor overhead but requires more browser persistence and private-control engineering. [E2B pricing](https://e2b.dev/pricing), [E2B EU access](https://docs.e2b.dev/faq/eu-region.md), [Daytona limits](https://www.daytona.io/docs/en/limits/).

These USD list-price examples exclude model use, Composio, application hosting, PostgreSQL, object storage, transfer and tax. They are not an approved budget. Neon scale-to-zero savings should not be assumed while pg-boss polls continuously. The [computer report](computer-providers.md#cost-model-and-account-gates) and [hosting report](cloud-hosting-auth.md) contain the calculations and gates. Select a production provider after measuring cold/warm startup, recovery, private takeover, real target-site behavior and total cost under the same workload.

## Delivery sequence after design review

| Stage                     | Deliverable                                                                                      | Gate before moving on                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 1. Feasibility            | Private Cloudflare Node deployment, database/storage path, E2B vs Cloudflare computer comparison | Streaming, wake-up, restarts, recovery, private control and measured costs work                      |
| 2. Identity and isolation | Google sessions, users, migrations, scoped APIs/jobs/events/files, RLS and key binding           | Two-user adversarial suite passes; no public exposure of the local-owner app                         |
| 3. Product account flows  | Signup, profile/settings, connected accounts, signed events, Telegram pairing                    | Local live-provider journey passes, including disconnect/revoke/expiry                               |
| 4. Hosted execution       | Durable artifacts/transcripts, remote adapters, per-user leases and budgets                      | Local app works against real development providers without a production deployment                   |
| 5. CI/CD and operations   | Main-merge deployment, migrations, health/readiness, rollback, retention, recovery tools         | Staging deploy and rollback/restart drill pass                                                       |
| 6. Production acceptance  | Shareable HTTPS link and observed real user journey                                              | Personal Google signup, integrations/events, remote work, Telegram round trip and isolation evidence |

Keep the existing CI gates. Add provider-contract and tenant-isolation fixtures, production image build, serialized migration job, then deployment on successful merges to `main`. Use separate scoped deployment secrets and environment protection. Worker and container image rollout is non-atomic, so use backward-compatible API/schema changes and wait for the image rollout before declaring success. A failed deploy must be visible and recoverable. [Cloudflare rollouts](https://developers.cloudflare.com/containers/rollouts/).

## Test without relying on production

| Mode           | Services                                                                         | What it proves                                                              |
| -------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| UI prototype   | In-memory synthetic state                                                        | Navigation, copy, interaction and responsive layout only                    |
| Local fixtures | Local PostgreSQL/Docker, deterministic provider fixtures                         | Ownership, cancellation, retry/dedupe, migrations and failure paths         |
| Local live     | Local server + real development Google/Composio/model/computer services          | Real OAuth, agent execution, events and Telegram behavior before deployment |
| Staging        | Cloudflare + separate database/storage/provider projects                         | Proxy behavior, cookies, signatures, lifecycle, deployments and rollback    |
| Production     | Production projects, authorized personal Google account and disposable test data | The actual shareable product journey and persisted outcomes                 |

For local live callbacks, relay only the webhook ingress or use a narrowly scoped development HTTPS endpoint. Do not tunnel today's entire unauthenticated app. Use a separate Telegram development bot, since polling and webhook ownership can conflict. Support selecting a remote computer while the API/UI run locally. Local real-provider tests still require provider accounts and may incur usage; they do not require a production deployment.

Production evidence must include a received Gmail test event, changed Calendar event, an owned assistant response, remote browser/shell task and artifact, private takeover/resume, a Telegram inbound message and observed reply, and a scheduled task with the browser closed. Correlate receipts and result states without retaining private message bodies in the repo. Also exercise revocation, duplicate webhooks, a worker restart and deployment during a safe synthetic task. A second authorized identity is needed for live cross-user attempts; automated fixtures cover the complete negative matrix beforehand.

## Portability, documentation and access gates

Keep vendor SDKs in adapters and selection in composition. Retain `Computer`, `Workspace`, `Integrations`, `MessagingTransport` and model/runtime boundaries; add narrow auth, durable-storage and lifecycle contracts where needed. Capability checks decide whether native sign-in, manual control or persistence is available. Unsupported capabilities must be visible and must not quietly fall back to weaker handling. Include local Compose and a generic container deployment alongside the Cloudflare recipe.

Implementation must update `README.md`, the system/architecture/security/production guides, API contracts, development and verification instructions, Composio/channel/vault docs, replacement-module guide, environment examples and owning `AGENTS.md` files. Document operator setup, end-user behavior, actual commands, providers/models/available-app configuration, required scopes, supported regions, test data cleanup and recovery. Preserve a dated distinction between fixtures and real provider/production proof.

After review, inspect existing accounts and configuration before creating resources. Remaining access facts are Jan's Cloudflare account/zone/plan, final hostname, repository deployment rights, Google OAuth audience/verification, database and provider regions, existing key availability and a bounded test budget. If a computer provider account is missing, the requested identity is `filipe.tavares@n8n.io` through Google where available. Personal Google is authorized for the later production test. No account creation, provider grants, paid provisioning or production test occurred during this research phase.

## Detailed research

- [Cloudflare hosting, authentication, tenancy, database and CI/CD](cloud-hosting-auth.md)
- [Remote computer providers, contracts, prices and bake-off](computer-providers.md)
- [Google/Composio events and Telegram setup](integrations-events-telegram.md)
- [Prototype design and validation record](../../src/web/prototypes/cloud-signup/README.md)
