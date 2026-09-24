# Sidekick

Local personal assistant. Never push, deploy or publish without authorization. Keep secrets and user content out of Git, logs and client code. Do not add code comments or JSDoc.

Start with [README.md](README.md) for setup and current capability limits. Read only the guide for the area you change:

| Change                                                      | Guide                                              |
| ----------------------------------------------------------- | -------------------------------------------------- |
| Routes, persistence, queues, approvals, personal features   | [src/server/AGENTS.md](src/server/AGENTS.md)       |
| Agent tools, task segments and provider interfaces          | [src/runtime/AGENTS.md](src/runtime/AGENTS.md)     |
| Model, browser, integrations, media or credential providers | [src/providers/AGENTS.md](src/providers/AGENTS.md) |
| Web pages, controls and streaming                           | [src/web/AGENTS.md](src/web/AGENTS.md)             |
| Fixtures and validation                                     | [tests/AGENTS.md](tests/AGENTS.md)                 |

Shared HTTP types live in `src/shared/contracts.ts`. Capability interfaces live in `src/ports`. Providers are selected only in `src/server/composition.ts`. Read [architecture](docs/architecture.md) for ownership and [replacement guide](docs/replacing-modules.md) when swapping a capability. PostgreSQL is an explicit storage choice, not a generic provider interface.

Preserve a quiet conversation, the existing shadcn/Tailwind controls and palette. Keep developer details in `/dev`. Prefer narrow factory interfaces over globals or service locators. Run `npm run check`, `npm run test:integration` and `npm run build`; see [development](docs/development.md). Update the owning guide and affected contract when an entry point changes. Distinguish fixture results from live provider verification.
