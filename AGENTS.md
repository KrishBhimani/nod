# Sidekick

A local, single-owner personal assistant. Do not push, deploy, or publish without authorization. Keep keys out of Git, logs, prompts, and client configuration. Keep private user content out of Git and logs. Do not add code comments or JSDoc.

Start with [README](README.md) for setup and current limits. Read the area guide before editing:

| Change                                                            | Guide                                              |
| ----------------------------------------------------------------- | -------------------------------------------------- |
| HTTP, persistence, queues, credentials, approvals, personal data  | [src/server/AGENTS.md](src/server/AGENTS.md)       |
| Agent tools, task segments, context, cancellation                 | [src/runtime/AGENTS.md](src/runtime/AGENTS.md)     |
| Model, browser, workspace, integrations, speech, channel adapters | [src/providers/AGENTS.md](src/providers/AGENTS.md) |
| Pages, conversation, inspector, forms, streaming                  | [src/web/AGENTS.md](src/web/AGENTS.md)             |
| Fixtures and validation                                           | [tests/AGENTS.md](tests/AGENTS.md)                 |

[System guide](docs/system-guide.md) is the living product and technical reference. Keep it current whenever behavior, dependencies, model defaults, trust boundaries, or validation status change. Preserve the distinction between implemented code, automated fixtures, live provider checks, and missing features.

[Architecture](docs/architecture.md) defines ownership and trust boundaries. [API contract](docs/api-contract.md) describes wire behavior. [Replacing modules](docs/replacing-modules.md) maps ports and state migration. [Security](docs/security.md) and [production requirements](docs/production.md) apply before boundary or hosting changes.

Shared HTTP types live in `src/shared/contracts.ts`; capabilities live in `src/ports`. Only `src/server/composition.ts` selects providers and runtime implementations. Keep product policy in features and protocol details in adapters. Prefer narrow factories over mutable globals.

Keep chat central and quiet. Preserve task/channel identity, account-bound approvals, owned-message provenance, and task revisions. The Internet-connected workspace must remain separate from provider keys, host access, and authenticated browser profiles.

Run focused checks while editing, then `npm run check`, `npm run test:integration`, and `npm run build`; see [development](docs/development.md). Use synthetic data and disposable schemas. Update the owning guide when an entry point changes. Report automated fixtures, UI flows, and live account checks separately.
