# Sidekick

A personal assistant with a private single-owner local mode and an implemented hosted multi-user pilot. Do not push, deploy, or publish without authorization. Keep keys out of Git, logs, prompts, and client configuration. Keep private user content out of Git and logs. Do not add code comments or JSDoc.

Start with [README](README.md) for setup and current limits. Read the area guide before editing:

| Change                                                            | Guide                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| HTTP, persistence, queues, credentials, approvals, personal data  | [src/server/AGENTS.md](src/server/AGENTS.md)                       |
| Agent tools, task segments, context, cancellation                 | [src/runtime/AGENTS.md](src/runtime/AGENTS.md)                     |
| Model, browser, workspace, integrations, speech, channel adapters | [src/providers/AGENTS.md](src/providers/AGENTS.md)                 |
| Pages, conversation, inspector, forms, streaming                  | [src/web/AGENTS.md](src/web/AGENTS.md)                             |
| Fixtures and validation                                           | [tests/AGENTS.md](tests/AGENTS.md)                                 |
| Cloudflare containers, private RPC, storage broker and CI/CD      | [deployment/cloudflare/README.md](deployment/cloudflare/README.md) |

[System guide](docs/system-guide.md) is the living product and technical reference. Keep it current whenever behavior, dependencies, model defaults, trust boundaries, or validation status change. Preserve the distinction between implemented code, automated fixtures, live provider checks, and missing features.

[Architecture](docs/architecture.md) defines ownership and trust boundaries. [API contract](docs/api-contract.md) describes wire behavior. [Replacing modules](docs/replacing-modules.md) maps ports and state migration. [Security](docs/security.md) and [production requirements](docs/production.md) apply before boundary or hosting changes.

Shared HTTP types live in `src/shared/contracts.ts` and `src/shared/account.ts`; capabilities live in `src/ports`. Only `src/server/composition.ts` selects providers and runtime implementations. Keep product policy in features and protocol details in adapters. Prefer narrow factories over mutable globals.

Hosted ownership is process-immutable: `gateway.ts` authenticates Google sessions; `runtime-host.ts` selects one leased tenant process; `tenants.ts` provisions its restricted SQL login and private app/jobs schemas. Never change a global owner per HTTP request or forward control/auth database credentials to a tenant. Internal HMAC envelopes bind owner, environment, generation, method, target, body and capability; preserve replay and expiry checks. Do not bypass confirmed-stop fencing to recover a runtime faster.

The default admission is eight users, with matching container capacity. Provider/model/integration configuration is operator-selected. The selected hosted architecture runs the app on Cloudflare and uses one E2B computer per owner for browser, files and commands, with separate OS identities and a private browser profile/control boundary. The optional Cloudflare computer adapter retains separate owner/role containers. Keep all computer APIs developer-only behind the signed capability; ordinary users never choose providers. Hosted Inspector capture requires both an allowlisted developer UUID and explicit `DEV_INSPECTOR=true`. New storage/runtime providers must preserve owner boundaries, conditional writes, cancellation, uncertain-action fences and durable recovery. Keep development and production databases, keys and provider projects separate; start from [hosted environment example](deployment/hosted.env.example).

Keep chat central and quiet. Preserve task/channel identity, account-bound approvals, owned-message provenance, and task revisions. The Internet-connected workspace must remain separate from provider keys, host access, and authenticated browser profiles.

Run focused checks while editing, then `npm run check`, `npm run test:integration`, and `npm run build`; see [development](docs/development.md). Use synthetic data and disposable schemas. Update the owning guide when an entry point changes. Report automated fixtures, UI flows, and live account checks separately.

For Cloudflare changes, also run that package's type check/tests and development/production Wrangler dry runs. The main CI workflow gates the production deployment workflow; passing either local fixtures or a dry run is not a live-provider or production claim. Read the rollout/rollback runbook before changing images, secret versions, schemas or runtime generations.
