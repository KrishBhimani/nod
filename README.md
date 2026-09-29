# Otto

Otto is a personal assistant you use through one chat. It can browse websites, run commands, and create files in a Linux workspace. It can also track goals, run scheduled tasks, and use accounts that you connect.

- **Chat:** Send messages and files, follow task progress, and keep chat history between sessions.
- **Computer:** Let Otto use its own browser and workspace. In local mode, you can take control of the browser when a task needs your input.
- **Planning:** Keep goals and schedules in the app. Use the Vault to save website logins and payment cards.

## Start on your computer

Install Node.js **24.21.0 or newer** and Docker with Compose v2. You can use Node 26 locally. CI and Docker images use Node 24 LTS. On Mac, start Docker Desktop. Run this command from the repository root:

```sh
npm run dev
```

The first run installs dependencies, creates `.env`, and starts PostgreSQL and the Docker containers for the browser and workspace. Open [http://localhost:4310](http://localhost:4310) in your browser. Otto's browser runs inside Docker. It does not use a browser profile from your computer.

Chat needs a model key. For OpenAI, set `LLM_PROVIDER=openai` and `OPENAI_API_KEY`. For Anthropic, set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Put these settings in the ignored `.env` file or export them in the shell that starts Otto. If a setting is in both places, the shell value takes priority. Restart Otto after you edit `.env`. Keep keys out of chat and Git.

The local setup supports one owner and listens only on `127.0.0.1`. Chat and computer tasks need Docker and a model key. They do not need Cloudflare, E2B, or Google sign-in.

## Optional connections

- **Apps:** Connect Notion and Linear through their hosted MCP servers from **Apps** or chat. Gmail, Calendar, Drive, Sheets, Docs, and Slack use Composio; set `COMPOSIO_API_KEY` for those services and for existing Composio Notion accounts. For other services, Otto can research an HTTPS MCP, HTTP API, or installed CLI path. A discovered MCP path can use OAuth or a token; HTTP and CLI paths use a token. Local Docker and hosted E2B run saved CLI calls with a Vault grant. Vault holds discovered and direct Notion/Linear grants, and Apps lists saved website logins as browser paths. See [connections](docs/connections.md) and [Composio setup](docs/composio.md).
- **Channels:** Set up Telegram or WhatsApp from **Channels**. Telegram can poll locally. WhatsApp needs a Meta callback and an eligible account. See [channel setup](docs/channels.md).
- **Vault:** On macOS, Keychain supplies the encryption key. Other hosts need `OTTO_VAULT_KEY`. See [vault setup](docs/vault.md).

Invalid app tool searches can be corrected within the task. If an earlier external action has no confirmed outcome, Otto blocks repeating it; a later fix does not clear that protection. See [connection execution and recovery](docs/composio.md).

Press Ctrl-C to stop the server. Run `docker compose stop` to stop its containers. Task files stay in `.local/`. PostgreSQL, browser data, and installed workspace tools stay in Docker volumes. Keep these stores if you want to keep your local data.

## Hosted mode

Hosted mode signs users in with Google and keeps their work separate. The selected setup uses Cloudflare Containers, a dedicated PostgreSQL database, Google OAuth credentials and server-owned model/integration keys. One shared gateway serves up to eight total provisioned users. Each owner has a private application runtime and separate browser/workspace containers that start on first use; signup does not create those computer containers. E2B remains an optional, deferred adapter. Docker computer mode is only for the private local setup.

For hosted development, use the [hosted environment example](deployment/hosted.env.example) and [development guide](docs/development.md#hosted-mode-on-your-computer). For deployment, use the [Cloudflare runbook](deployment/cloudflare/README.md) and [production requirements](docs/production.md). Cloudflare credentials are for deployment. They are not needed for the local setup.

The production pilot is available at [otto.n8n-maintenance.workers.dev](https://otto.n8n-maintenance.workers.dev). Google sign-in, onboarding, all five Google metadata reads, public browser navigation and browser-to-chat PDF delivery have live checks at this origin. Gmail and Calendar events have reached the signed ingress and classification pipeline. Authenticated Via Verde statement retrieval and Telegram delivery remain unverified. Hosted computers use Cloudflare; E2B is deferred. The [dated cutover record](docs/testing/results/2026-09-28-otto-cutover.md) records exact releases, manual and automatic deployment results, legacy-resource retirement and remaining acceptance work.

Account and environment deletion are operator maintenance procedures. Follow the [scoped reset runbook](docs/environment-reset.md) to preserve other accounts and shared configuration; [the verified single-account reset](docs/testing/results/2026-09-29-owner-erasure.md) records the checks and retention limits. Deleting an account does not fix or replay a task with an unknown outcome.

The [system guide](docs/system-guide.md) describes product behavior and limits. [Architecture](docs/architecture.md) and the [API contract](docs/api-contract.md) describe the code.
