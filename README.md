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

Press Ctrl-C to stop the server. Run `docker compose stop` to stop its containers. Task files stay in `.local/`. PostgreSQL, browser data, and installed workspace tools stay in Docker volumes. Keep these stores if you want to keep your local data.

## Hosted mode

Hosted mode signs users in with Google and keeps their work separate. It needs a dedicated PostgreSQL database, Google OAuth credentials, a model key, and either E2B or Cloudflare Containers for computer work. Docker computer mode is only for the private local setup.

For hosted development, use the [hosted environment example](deployment/hosted.env.example) and [development guide](docs/development.md#hosted-mode-on-your-computer). For deployment, use the [Cloudflare runbook](deployment/cloudflare/README.md) and [production requirements](docs/production.md). Cloudflare credentials are for deployment. They are not needed for the local setup.

Before enabling E2B, follow its [development acceptance procedure](deployment/e2b/README.md#opt-in-disposable-development-acceptance). The live probe requires separate isolation results for ordinary workspace and connected CLI users; offline fixtures do not establish provider acceptance.

At **18:51 UTC on 2026-09-28**, the Otto production pilot was running manual release `4c8f827f`. Google sign-in, onboarding, persisted chat and a public-only browser task have live evidence. All five Google apps connect through custom clients; production metadata results have UI and SQL completion evidence, with original tool receipt verification pending. Hosted computer work uses Cloudflare; the selected one-E2B-computer-per-user setup remains inactive. The [dated cutover record](docs/testing/results/2026-09-28-otto-cutover.md) separates the local development runtime, source/native fixtures, manual release and pending automatic merged-main publication.

The [system guide](docs/system-guide.md) describes product behavior and limits. [Architecture](docs/architecture.md) and the [API contract](docs/api-contract.md) describe the code.
