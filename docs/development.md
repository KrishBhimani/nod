# Local development

Use Node.js 24.21.0 or newer and Docker Desktop. From the repository root:

```sh
npm run dev
```

The launcher installs missing dependencies, creates `.env`, starts PostgreSQL, the Linux workspace and the trusted browser container, then serves [localhost:4310](http://localhost:4310). The first run builds and downloads images. Chromium and its desktop tools are installed only in `Dockerfile.browser`; no host Chrome install or launch is required. Provider setup is in [README](../README.md), [Composio](composio.md), [channels](channels.md), and [vault](vault.md).

Ctrl-C stops the web process. `docker compose stop` retains data. Do not use `docker compose down -v` unless you intend to remove the database, installed-tool and browser-data volumes. Existing host browser profiles are not migrated. Never reset another project or the normal local profile to run a test.

The launcher prepares PostgreSQL before browser/workspace services. It generates `SIDEKICK_POSTGRES_PASSWORD` only when absent, saves it with the matching local `DATABASE_URL` in private `.env`, starts PostgreSQL, updates only the `sidekick` role password through local psql stdin, verifies authentication, then starts the remaining services. Repeating startup retains the generated password. If rotation fails, startup stops before the app starts; retrying can repair the role through the same Unix-socket path. Existing tables and rows are not reset. An explicitly configured external server database is preserved. The launcher removes the old network-guard orphan after recreating services.

## Hosted mode on your computer

Hosted development uses the real Google login, account isolation and per-user runtime processes, with the web app at [localhost:4330](http://localhost:4330). It is separate from ordinary local mode on port 4310, the synthetic E2E harness on port 4320, and the design prototype on port 4318. Node.js 24.21.0 or newer is required. Install dependencies with `npm ci` first.

Create a private `.env.hosted.local` in the repository root, or keep it elsewhere and pass `--env /absolute/path/to/file`. The launcher reads only that file; it does not fall back to `.env` or inherit provider credentials from the shell. It creates local state under `.local/hosted`, starts the gateway on loopback, and starts tenant processes on private ephemeral ports as users sign in. It does not start Docker, create a tunnel or deploy anything.

Use a dedicated development PostgreSQL database. A separate Neon development branch works, as does a separate local PostgreSQL instance on port 54331. Its setup role must be able to create schemas and tenant roles; use the direct database connection for migrations and provisioning. Do not point hosted development at the ordinary local database or a production database. The launcher explicitly rejects local port 54329 and `SIDEKICK_ENVIRONMENT=production`.

For a new local database, this optional setup creates a dedicated container and volume. Run it once from the repository root; it refuses to overwrite existing configuration files:

```sh
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('.local', { recursive: true });
const password = randomBytes(32).toString('hex');
await writeFile('.local/hosted-postgres.env', `POSTGRES_USER=sidekick_hosted\nPOSTGRES_DB=sidekick_hosted\nPOSTGRES_PASSWORD=${password}\n`, { mode: 0o600, flag: 'wx' });
await writeFile('.env.hosted.local', `DATABASE_URL=postgresql://sidekick_hosted:${password}@localhost:54331/sidekick_hosted\nSIDEKICK_MASTER_KEY=${randomBytes(32).toString('base64')}\nBETTER_AUTH_SECRET=${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
JS
docker run --detach --name sidekick-hosted-postgres \
  --env-file .local/hosted-postgres.env \
  --publish 127.0.0.1:54331:5432 \
  --volume sidekick-hosted-postgres:/var/lib/postgresql \
  postgres:18-alpine
```

For Neon, create the private file yourself with your development connection string and independent random 32-byte `SIDEKICK_MASTER_KEY` and `BETTER_AUTH_SECRET` values. Retain those keys across restarts: replacing them does not migrate existing tenant credentials or encrypted data. Set file permissions to `600`; the launcher warns only when its owner or permissions are actually insecure.

Complete the file with your development provider configuration:

```dotenv
SIDEKICK_ENVIRONMENT=development
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
E2B_API_KEY=
E2B_BROWSER_TEMPLATE=
E2B_WORKSPACE_TEMPLATE=
LLM_PROVIDER=openai
OPENAI_API_KEY=
COMPOSIO_API_KEY=
COMPOSIO_WEBHOOK_SECRET=
```

The database, both server keys, Google credentials and all three E2B fields are required. Add `http://localhost:4330` to the Google OAuth client's JavaScript origins and `http://localhost:4330/api/auth/callback/google` to its redirect URIs. Google login grants only account identity; app connections use the development Composio project and its separate auth configurations. See [Composio](composio.md) for each `COMPOSIO_*_AUTH_CONFIG_ID` override.

```sh
node scripts/start-hosted.mjs --check
node scripts/start-hosted.mjs
```

`--check` validates configuration without connecting to a provider or database and reports field names without values. Ctrl-C stops the gateway and its tenant processes. Restart the command after changing server configuration. The web UI uses Vite during development. Local hosted mode stores durable artifacts and Pi checkpoints in each tenant's private PostgreSQL schema (`OBJECT_STORAGE_PROVIDER=postgres`); Cloudflare uses the private R2 broker (`OBJECT_STORAGE_PROVIDER=http`). Actor-local directories are caches in these modes. Each artifact and transcript is limited to 15 MiB. Keep development databases separate from production; these bytes count toward the database provider's storage allowance.

The explicit filesystem object adapter remains available for custom setups. A process crash while holding its exclusive lock leaves the object fenced until the operator confirms the old process stopped and reconciles that lock. Use PostgreSQL or the HTTP broker for automatic restart testing. Storage-provider changes require explicit byte and metadata migration, and an interrupted external action without a durable result receipt must be reconciled before resuming its task.

The server configuration selects the computer provider. Hosted mode currently requires E2B for isolated computers; ordinary local mode retains the Docker option. Users do not select providers or enter operator API keys. Model customization uses `LLM_PROVIDER`, `LLM_MODEL`, `ROUTING_MODEL` and `TRIAGE_MODEL`; set `ANTHROPIC_API_KEY` when selecting Anthropic. Missing model or integration keys leave those capabilities unavailable. `SIDEKICK_DEVELOPER_IDS` is a comma-separated list of signed-in user UUIDs allowed to inspect the computer; ordinary users see chat, apps, channels and account settings. [Replacing modules](replacing-modules.md) describes the adapter boundaries.

`SIDEKICK_MAX_USERS` controls admission to the hosted instance. The pilot default is 8; accepted values are 1–400. Existing users retain their accounts when admission is full.

### Receiving real webhooks locally

The optional relay listens on loopback port 4331 and forwards only `POST /api/webhooks/composio`, opaque Telegram/WhatsApp callback URLs, and WhatsApp's GET verification challenge to the gateway on 4330. It excludes login, account, chat, internal control and all other routes. It strips cookies and client identity headers and preserves the raw body and provider signature headers. The application still verifies provider authentication.

In separate terminals, start the relay and your chosen tunnel:

```sh
node scripts/webhook-relay.mjs
cloudflared tunnel --url http://127.0.0.1:4331
```

Copy the resulting HTTPS origin into `SIDEKICK_WEBHOOK_ORIGIN` in the hosted environment file and restart the gateway. Configure the development Composio webhook destination as `<tunnel-origin>/api/webhooks/composio` with the matching development webhook secret. Telegram setup through Channels uses the server-generated opaque callback URL. When a temporary tunnel URL changes, update the origin and re-register affected development callbacks. Google sign-in remains on localhost:4330; the tunnel exposes no login page. The launcher never starts a tunnel or changes provider webhooks automatically.

### What local checks establish

`tests/hosted-development.test.ts` verifies launcher isolation and the relay allowlist with synthetic values. `gateway`, `tenant-control`, `runtime-host`, `hosted-webhooks`, `channel-account-leases` and `better-auth-session` exercise ownership, signatures, revocation, lease races and SDK database behavior with injected providers or disposable PostgreSQL. They do not prove real OAuth consent, E2B availability, webhook registration or message delivery.

The separate `scripts/hosted-ui-fixture.ts` runs the actual web app against synthetic account and integration adapters on port 4346, with no database or real provider access. Use `node --import tsx scripts/hosted-ui-fixture.ts` for repeatable login, onboarding, settings and responsive UI review. Its simulated consent route exists only in that script and is never imported by the application. Real provider acceptance instead uses `start-hosted.mjs`, development accounts and actual callbacks; production verification remains a separate step.

## Code and local state

Read the relevant [area guide](../AGENTS.md), then use [architecture](architecture.md) and [API contract](api-contract.md) for cross-layer changes. Provider replacement starts in [replacing modules](replacing-modules.md). Keep provider keys in `.env` or the secure channel forms, never in React or model context.

The development sidebar Inspector button (or production More → Inspector) opens beside the current page and shows task state, safe event summaries, and browser images. It has no app keyboard shortcut. `/dev` opens it directly; `DEV_INSPECTOR=false` disables diagnostics but keeps `/browser` and its owned control routes available. Retained images show their capture time. Failed or private capture clears ordinary pixels and disables page input; Take control remains available. Native sign-in uses a separate transient owner-only frame route; it must never enter ordinary screenshot storage or agent context.

The Inspector has Screen, Activity, Tools, Models, Costs and Prompts. Activity shows current work and execution history directly. Tools starts with recent calls; use By tool for aggregate counts and paginated calls, or Available tools for descriptions and schemas even before a task runs. Models shows assistant requests, token categories and SDK estimates. Inspecting a message narrows Activity, Tools, Models and Prompts; Show all restores owner-wide diagnostics. Filter call status or search loaded payloads, then explicitly load earlier records as needed. Data is retained for seven days, with 16 KiB per payload. Costs stays owner-wide and groups visible operation/model summaries by provider, including auxiliary model work and adapter operations for browser, integrations, speech, relevance, channels and workspace access. Only raw data and detailed metrics require expansion. Costs appear only when reported by a provider or estimated by the model SDK; unknown prices stay unavailable. Operation counts are not billable requests, and hosting billing is not connected. Existing tasks have no new recordings until they run again. Recording is best effort: a failed or slow inspector store can leave partial history and cost totals while the task continues. See [security](security.md) for capture and secret-masking limits.

The Linux workspace can install CLI packages with `npm install -g` and `pipx install`; `/home/node` persists in `workspace-tools`. Base OS packages belong in `Dockerfile.workspace`. Rebuild with `docker compose up -d --build --wait` after Dockerfile changes. The workspace must never receive provider keys, the host Docker socket, or browser profile mounts.

`Dockerfile.browser` builds the trusted browser worker with Chromium, Xvfb, xauth, xdotool and ffmpeg. It mounts only private `browser-data` and uses a fixed Docker-exec stdin/Unix-socket bridge, with no published port. Keep its process, mount and network namespaces separate from the untrusted workspace. Rebuild the image after browser worker or adapter changes; copying new host source alone does not update the running worker. Production uses `/usr/bin/chromium` for both automation and native sign-in. Fixture proxy/certificate overrides belong only in the isolated E2E worker, never in the RPC contract.

## Checks

| Command                    | Scope                                                                |
| -------------------------- | -------------------------------------------------------------------- |
| `npm run check`            | TypeScript, import boundaries, formatting                            |
| `npm test`                 | Deterministic tests; database cases skip without `TEST_DATABASE_URL` |
| `npm run test:integration` | All fixtures, including PostgreSQL                                   |
| `npm run build`            | TypeScript and web bundle                                            |
| `npm run format`           | Repository formatting; avoid broad writes during parallel work       |

Database fixtures create random schemas and their own pg-boss schema, then remove only those. The integration command runs two test files at a time to leave PostgreSQL connections available for the local app. It uses explicit `TEST_DATABASE_URL` first, otherwise the configured loopback local `DATABASE_URL`. It does not fall back to a public password or automatically select a non-local database. Set `TEST_DATABASE_URL` explicitly for a different test database.

Run focused checks while changing a boundary:

| Boundary                                      | Tests under `tests/`                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Local database setup and role migration       | `local-database`                                                                                                                            |
| App composition and replacement adapters      | `application-adapters`, `runtime-adapters`, `provider-adapters`                                                                             |
| Task continuation, cancellation, and recovery | `task-continuation`, `task-durability`, `runtime-session`, `pi-agent`                                                                       |
| HTTP, approvals, and access                   | `access`, `server-boundaries`, `chat-api`                                                                                                   |
| Credential stages and browser recovery        | `vault`, `vault-staged`, `browser-login`, `browser-recovery`, `runtime-credentials`                                                         |
| Container browser and native desktop          | `container-browser`, `browser-desktop`, `browser-sign-in`, `browser-sign-in-handoff`, `browser-manual`                                      |
| Google accounts and events                    | `integrations`, `provider-adapters`                                                                                                         |
| Channel verification, polling, and delivery   | `channel-settings`, `channels`, `channel-application`, `messaging-transport`                                                                |
| Personal learning and quiet work              | `personal`, `triage-preferences`, `task-durability`                                                                                         |
| Web content, streaming, links, and audio      | `web-markdown`, `web-streams`, `message-links`, `web-speech`, `speech`                                                                      |
| Inspector catalog, private records and usage  | `inspector-redaction`, `inspector-store`, `inspector-observations`, `provider-usage`, `runtime-session`, `pi-agent`, `application-adapters` |

Each name has a `.test.ts` suffix. For example, use the configured local database for all integration fixtures:

```sh
npm run test:integration
```

For a focused PostgreSQL file, supply `TEST_DATABASE_URL` through the environment of your test runner. Do not put real credentials in a checked-in command or shared output.

Inject fake capabilities through ports and factories for feature tests. Test vendor request/response mapping separately. Fixtures must not send real messages, access real private files, buy services, or require real keys.

## Browser and live validation

After a UI change, check the real local app at desktop and narrow widths. Include empty/loading/error states, waiting questions, expired credentials, declined approvals, and unavailable providers. Chat checks include pasted images, sanitized Markdown/HTML, history, inline reactions, typing state, screenshot attachments and public link previews. Check that ordinary observation pauses for secure input, with a separate private native sign-in view only during an owned lease.

For network changes, use a synthetic task directory to verify the user ID, capabilities, persistent CLI installs and expected HTTP and registry reachability. Browser and shell traffic have no Sidekick private-address, port or IPv6 deny policy; reachability follows Docker and host routing. Check the separate public link-preview fetcher against its existing private-destination rejection tests. Do not report network isolation that the default Compose bridge does not provide.

For browser changes, use a disposable browser namespace and synthetic website. Check navigation, masked captures, private native frames/input, normal sign-in shutdown and explicit continuation, cancellation and worker restart. Verify that the shell cannot read browser profiles or reach its control socket, display or debugging interface, and that no host browser process launches. Exercise password and fake-2FA continuation without real credentials. These checks establish that controlled harness only; real website security decisions and authentication require separate evidence.

Run live provider checks only within the authorized scope. Do not use reconnect/disconnect as a default repair for an SDK bug; preserve existing accounts. Record fixture evidence, live provider evidence, and unresolved steps separately in [verification](verification.md). A configured key, a mocked OAuth callback, or a synthetic login page does not prove the real service works.

`scripts/e2e-sidekick.ts` mounts the current `src` directory read-only in its temporary browser container. The workspace container mounts only its temporary task directory. This keeps the worker and Docker command bridge on the same protocol during acceptance checks. Set `SIDEKICK_E2E_PORT=4341` to keep the normal app running on port 4320 during acceptance; the default test port is 4320. The override accepts integers from 1 to 65535 and applies to the listener, callbacks and manifest. It includes synthetic Telegram and WhatsApp setup through the real Channels forms and encrypted settings. Both start disconnected. The local `/e2e` operator page lists fixed fixture values; arbitrary credentials and callback URLs are rejected. The transport has no polling, accepts no incoming messages and rejects every delivery. Configured and pending-callback screens prove UI behavior only, not provider verification or delivery. `tests/e2e-harness.test.ts` checks these limits.
