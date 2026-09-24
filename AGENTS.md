# Sidekick

Standalone local assistant. Never push, deploy, or publish without user authorization. Keep provider keys and personal content out of Git, browser responses and logs. Do not add code comments or JSDoc.

Read docs/api-contract.md before changing boundaries. Read docs/architecture.md for runtime ownership and docs/security.md before touching credentials, uploads, tools or authentication. Read docs/development.md for commands and verification.

Use TypeScript, React, shadcn and Tailwind. Keep the main interface a quiet conversation. Development diagnostics belong in /dev. Use the palette in src/web/styles.css. Use small files with explicit imports; avoid hidden side effects and global service locators.

Persistence lives in src/server. Agent and computer tools live in src/runtime. Browser components live in src/web. Shared wire types live in src/shared/contracts.ts. Test boundaries and failure recovery, not implementation details.

A change is complete when npm run check, npm run test:integration and npm run build pass, its behavior is verified, and affected documentation is current. Start the local PostgreSQL service for integration tests. State clearly which live services were verified and which remain unconfigured. Never call a fixture a live integration.
