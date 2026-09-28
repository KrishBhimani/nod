# Sidekick cloud rollout: proposal for review

**Decision update, 2026-09-28:** Cloudflare Containers is the selected application and computer provider. E2B and other provider changes are deferred. This supersedes the provisional provider recommendations below without changing their historical research or validation claims. Current capacity is eight total provisioned users with separate owner runtime, browser and workspace containers; the computer roles start on first use. Follow the [current production guide](../production.md) and [Cloudflare runbook](../../deployment/cloudflare/README.md).

Research and prototype date: **2026-09-26**. Starting revision: `1a471a0`.

**Selected UX: A — Quick start**, following the user's review on 2026-09-26. Keep login and account setup concise: remove privacy reassurances, explanations of login versus app access, hosting credits, preview labels and event-processing detail from ordinary screens. Provider consent supplies the permissions review; the product adds only information needed for the immediate decision.

**Selected application providers:** Cloudflare for application hosting and private object storage, Neon for PostgreSQL, and Composio for connected apps. Keep Sidekick's current stack, add Google login and complete user isolation, and run the application in Cloudflare Containers behind a small Worker. E2B remains the provisional remote-computer candidate, pending a full trusted-browser plus isolated-shell test and comparison with Cloudflare. Preserve local Docker and provider replacement.

This document preserves the research and prototype proposal made before implementation. The branch now implements hosted Google authentication, tenant isolation, the reviewed UI, E2B adapters and Cloudflare deployment tooling. Live signup, complete provider acceptance and production deployment remain unfinished. Use the [hosted acceptance record](../testing/results/2026-09-26-cloud-hosting.md) and [account-preparation record](provider-account-setup.md) for current implementation, provider resources and validation status; the proposal below is historical context.

## Review the experience

```sh
npm ci
npm run prototype:cloud
```

Use the repository's supported Node version, **24.21.0 or newer**. The prototype runs at [localhost:4318](http://127.0.0.1:4318/?variant=A), without Docker, PostgreSQL, credentials or external services. It is a separate Vite entry point under `src/web/prototypes/cloud-signup`; the normal application route is unchanged. All data stays in memory and resets on reload.

| Direction                     | Signup                                                          | Account access                                              | Tradeoff                                                            |
| ----------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| **A — Quick start, selected** | Google login, one optional screen for all seven apps, then chat | Sidebar account menu opens Profile and Settings in a dialog | Small change to the current product; setup is visible and skippable |
| B — Guided setup              | Separate account, app and preference steps                      | Dedicated Account & settings page                           | More orientation, more steps before useful work                     |
| C — Chat first                | Straight into a conversation                                    | Account settings open alongside chat                        | Fastest entry; app setup is easier to overlook                      |

Switch with the bottom bar or `?variant=A`, `B`, or `C`. Development-only scenario controls expose cancelled/expired login, separate demo users, connection callbacks, reconnect, Telegram pairing and diagnostic failures. They show simulated state and are not production permissions. The prototype makes no provider calls and must not collect real credentials.

Review the full route: sign in → connect or skip → chat → Apps → Channels/Telegram → sidebar avatar → Profile/Appearance. Existing Chat, Goals, Schedule, Apps, Channels and Vault remain familiar. Preserve the production Apps page design and account management; onboarding does not replace it. On desktop, keep navigation vertically centered, animate icon hover states, preserve the collapse/expand control and omit connected-app counts. On mobile, chat fills the screen; a menu opens navigation and account settings. Computer views and technical diagnostics belong only to explicitly authorized developers.

Preserve the existing app styles rather than redesigning its sidebar or other established surfaces. The sign-in page keeps its editorial cards and explains the intended benefit through concrete overnight outputs: a supplier comparison and prepared follow-ups. This is proposed product behavior, not evidence that scheduled work has run. Settings use vertical navigation beside the active section, familiar form controls and concise preference rows. Selectable theme previews communicate selection through border and background, without checkboxes or checkmarks.

Product requirements reflected in the design:

- Google login identifies a Sidekick user; connected accounts can differ from that identity. Keep the distinction in authorization and consent handling without explanatory banners in the ordinary flow.
- Offer Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, Slack and Notion together in one optional onboarding screen. Use compact, single-row cards with Connect, Connecting, a visually distinct Connected check or Reconnect. Omit connected-account identity and add-account, multiple-account and disconnect controls from onboarding. Connect starts the provider authorization flow immediately, without a Sidekick permissions modal; the provider owns its consent screen. Each consent return refreshes the originating screen and preserves the remaining setup. Bind the return destination to the owned consent attempt; cancellation, expiry and failure must return safely with an actionable state. Never accept an arbitrary return URL.
- No model, Composio, database or computer-provider keys in ordinary hosted-user setup. Those belong to the operator. A user-owned Telegram bot still needs its own token/pairing unless a separately validated managed-bot flow replaces it.
- Keep the existing production Apps page for account management after onboarding. Subscription setup, receipt and processing remain separate backend states, available in developer diagnostics. A connected label does not certify event delivery.
- The assistant keeps user content central. Provider errors lead to reconnect/retry actions; ordinary users do not configure webhook URLs or database details.
- Use the Google account avatar in the sidebar account control and profile. The production server normalizes the verified provider picture claim and serves a bounded safe image, with initials as fallback; a client-supplied URL is not an avatar source. Prototype portraits are synthetic local assets.
- Keep Profile, Appearance and Preferences together in a simple account dialog with a mobile-friendly layout. Add quick Light, Dark and System theme controls to the account dropdown and its mobile menu equivalent. Open settings with Cmd+, on macOS or Ctrl+, elsewhere while the user is in the signed-in app; an active modal takes precedence. These settings are account-scoped. Signing out clears browser data and control access; it need not cancel explicitly scheduled background work.
- The server startup configuration selects local or remote computer adapters through composition. Ordinary users never choose a provider or see a Computer page. Any necessary private credential step uses a narrowly scoped form; it does not expose a general browser or desktop.

## Recommended pieces

| Piece              | Proposal                                                                                             | Why and qualification                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Public origin      | Cloudflare Worker, static assets and HTTPS domain on Jan's account                                   | Account access verified; domain, plan, Containers support and CI credentials still need validation                                      |
| API and agent jobs | Existing Fastify/Pi Node image in Cloudflare Containers, separate API/worker roles                   | Preserves the stack and can run on another container host; prove lifecycle/streaming first                                              |
| Login              | Better Auth with PostgreSQL sessions and Google                                                      | Fits Fastify and portable hosting; pin and validate the integration rather than inventing auth                                          |
| Database           | Neon PostgreSQL in an appropriate EU region                                                          | Standard PostgreSQL; direct worker/migration connections initially; separate development/production projects                            |
| Durable files      | Private R2 behind a storage interface; local filesystem adapter retained                             | Containers lose disk on restart. Transcripts, artifacts and browser recovery need explicit persistence                                  |
| Apps               | Existing Composio adapter with separate environment projects, keys, auth configs and webhook secrets | Preserves account selection and tools while adding immutable user ownership                                                             |
| Remote computer    | Provisional E2B candidate; compare Cloudflare with separate trusted-browser and shell environments   | Choose after a measured bake-off. Daytona is an alternative; browser-only services do not automatically satisfy private desktop sign-in |
| Telegram           | Existing transport with per-user encrypted bot configuration, explicit pairing and webhook delivery  | Reuse the durable inbox/outbox; remove fixed-owner/global bot assumptions                                                               |
| Models             | Existing provider ports and server-side configuration                                                | Reuse suitable existing operator keys; users supply their own connected accounts, not model credentials                                 |

The hosting recommendation is an architectural judgment, supported by Cloudflare's [container runtime and lifecycle documentation](https://developers.cloudflare.com/containers/faq/) and Better Auth's [Fastify integration](https://better-auth.com/docs/integrations/fastify). See the detailed reports for current constraints and source-linked comparisons.

## Findings that change the implementation

**Login is only the entry point.** The source uses `local-development` as the owner, broadcasts SSE globally, and has unowned channel inbox/outbox records and global recovery logic. A login screen over this would remain unsafe. Every request, queue job, stream, account, file, approval, vault operation and computer lease needs an immutable user context. Add application authorization, same-owner database references and fail-closed RLS with a restricted runtime role. Test cross-user access with concurrent users and guessed IDs, not just normal reads.

**The API/worker split needs a cross-process event feed.** Replace the process-local event bus with an owner-scoped durable event/outbox mechanism and replay cursor. Persist job intent before wake-up, route to known worker identities, reconcile pending work, and use renewable leases and graceful draining. Restarting a replica must not interrupt another replica's work. The detailed hosting report specifies the proposed wake/recovery design.

**“Webhook” does not mean instant Google push.** Sidekick's current Gmail inbox and primary Calendar triggers poll at a requested 15-minute interval, then Composio delivers events to Sidekick. Managed OAuth has polling limits. The first release can use those triggers honestly; near-real-time native Gmail Pub/Sub and Calendar watch channels are a separate design with renewal, history/sync tokens and more Google infrastructure. [Composio triggers](https://docs.composio.dev/docs/triggers), [managed versus custom OAuth](https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app).

**Public Google access needs the correct audience and consent setup.** Basic sign-in and Gmail/Calendar authorization have different requirements. Personal Gmail cannot use an Internal-only OAuth app. Custom public Gmail OAuth can require restricted-scope verification and security assessment; managed Composio OAuth still requires deliberate data handling, scopes and retention. Do not promise a launch date before resolving the chosen consent path. [Google restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

**Computers are private execution environments.** Preserve the separation between the trusted browser and unrestricted shell. Provider credentials and database keys stay outside both. Computer viewers, manual control and diagnostics require explicit server-side developer authorization as well as owned, short-lived leases; a query flag cannot grant access. Ordinary users work through chat and narrowly scoped credential forms when needed. The operator chooses the provider at server startup. A provider change starts new allocations; it must not silently transfer browser credentials or retry an uncertain action elsewhere.

**Shared keys need usage controls.** Inventory existing keys without recording values, then provision only the selected server services. Production Composio needs its own project/key rather than importing development accounts. Add user concurrency, request/body limits, model/computer budgets and actionable operator diagnostics before opening public signup. Provider retention, regions, export/deletion and secret rotation are part of the hosting contract.

## Cost and provider choice

The remote computer is the material variable. The E2B configuration considered here uses two separate 2-vCPU/4-GiB environments: approximately **$0.3312 per active pair-hour**, plus **$150/month** for a Pro project. Those are aggregate running hours across all users. EU availability, separate development projects, storage and limits need account verification. Daytona has a material network-policy tier/top-up gate. Cloudflare may reduce vendor overhead but requires more browser persistence and private-control engineering. [E2B pricing](https://e2b.dev/pricing), [E2B EU access](https://docs.e2b.dev/faq/eu-region.md), [Daytona limits](https://www.daytona.io/docs/en/limits/).

These USD list-price examples exclude model use, Composio, application hosting, PostgreSQL, object storage, transfer and tax. They are not an approved budget. Neon scale-to-zero savings should not be assumed while pg-boss polls continuously. The [computer report](computer-providers.md#cost-model-and-account-gates) and [hosting report](cloud-hosting-auth.md) contain the calculations and gates. Select a production provider after measuring cold/warm startup, recovery, developer control, scoped credential handling, real target-site behavior and total cost under the same workload.

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

For local live callbacks, relay only the webhook ingress or use a narrowly scoped development HTTPS endpoint. Do not tunnel today's entire unauthenticated app. Use a separate Telegram development bot, since polling and webhook ownership can conflict. Let operators select a remote computer in startup configuration while the API/UI run locally. Local real-provider tests still require provider accounts and may incur usage; they do not require a production deployment.

Production evidence must include a received Gmail test event, changed Calendar event, an owned assistant response, remote browser/shell task and artifact, a scoped private credential flow where needed, a Telegram inbound message and observed reply, and a scheduled task with the browser closed. Correlate receipts and result states without retaining private message bodies in the repo. Separately validate developer authorization and private control, including denial of direct computer endpoints to ordinary users. Also exercise revocation, duplicate webhooks, a worker restart and deployment during a safe synthetic task. A second authorized identity is needed for live cross-user attempts; automated fixtures cover the complete negative matrix beforehand.

## Portability, documentation and access gates

Keep vendor SDKs in adapters and provider selection in server-startup configuration resolved by composition. Retain `Computer`, `Workspace`, `Integrations`, `MessagingTransport` and model/runtime boundaries; add narrow auth, durable-storage and lifecycle contracts where needed. Capability checks decide whether native sign-in, manual control or persistence is available. Unsupported capabilities must be visible to the operator; users receive a concise action or task failure only when it affects them. Never quietly fall back to weaker handling. Include local Compose and a generic container deployment alongside the Cloudflare recipe.

Implementation must update `README.md`, the system/architecture/security/production guides, API contracts, development and verification instructions, Composio/channel/vault docs, replacement-module guide, environment examples and owning `AGENTS.md` files. Document operator setup, end-user behavior, actual commands, providers/models/available-app configuration, required scopes, supported regions, test data cleanup and recovery. Preserve a dated distinction between fixtures and real provider/production proof.

Account preparation continued after the research snapshot. The [account-preparation record](provider-account-setup.md) is the current source for separate provider projects, credentials, OAuth configurations, invitations and unresolved access or billing steps. The [hosted acceptance record](../testing/results/2026-09-26-cloud-hosting.md) distinguishes automated tests, real development-provider checks and the remaining local and production journeys.

Personal Google is authorized for both local and production acceptance. Keep email addresses, secret values and private account content out of repository records. Provider configuration and passing fixtures do not establish live consent, event delivery or a production deployment.

## Detailed research

- [Cloudflare hosting, authentication, tenancy, database and CI/CD](cloud-hosting-auth.md)
- [Remote computer providers, contracts, prices and bake-off](computer-providers.md)
- [Google/Composio events and Telegram setup](integrations-events-telegram.md)
- [Provider account preparation and remaining access](provider-account-setup.md)
- [Prototype design and validation record](../../src/web/prototypes/cloud-signup/README.md)
