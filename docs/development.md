# Local development

Use Node.js 22.22.3 or newer and a running Docker Desktop. From the repository root run `npm run dev`. It installs dependencies if needed, creates `.env` from the example, starts PostgreSQL and the isolated workspace, installs the agent browser and starts the web/API server. Open http://localhost:4310.

The first run downloads container images and browser binaries. Later runs reuse them. Ctrl-C stops the web process. `docker compose stop` stops local containers without deleting data. Do not use `docker compose down -v` unless you intend to delete this app's database.

Put your OpenAI or Anthropic key in `.env`, set `LLM_PROVIDER`, and restart. Composio, speech and Jev are optional capabilities with their own keys. A key being present means configured, not verified. See composio.md and vault.md for their setup.

Use `/dev` for task state, safe tool event summaries and browser screenshots. The user chat does not expose execution plumbing. Set `DEV_INSPECTOR=false` to hide the inspector API and navigation.

`npm run check` checks TypeScript; `npm test` runs checks that do not require PostgreSQL; `npm run test:integration` includes all database fixtures against the local PostgreSQL service; `npm run build` checks and builds the client. Database fixtures create and remove their own isolated schemas. Set `TEST_DATABASE_URL` to use a different PostgreSQL service. Browser UI checks and live provider checks must be reported separately from deterministic fixtures.

For isolated database tests, use a separate PostgreSQL database or schema and keep all seed values synthetic. Never run reset commands against another project's containers or data.
