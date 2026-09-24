# Local development

Use Node.js 22.22.3 or newer and Docker Desktop. From the repository root:

```sh
npm run dev
```

The launcher installs missing dependencies, creates `.env`, starts PostgreSQL, the network guard, and the Linux workspace, installs agent-browser, and serves [localhost:4310](http://localhost:4310). The first run downloads images and browser binaries. Provider setup is in [README](../README.md), [Composio](composio.md), [channels](channels.md), and [vault](vault.md).

Ctrl-C stops the web process. `docker compose stop` retains data. Do not use `docker compose down -v` unless you intend to remove the database and installed-tool volumes. Never reset another project or the normal local profile to run a test.

## Code and local state

Read the relevant [area guide](../AGENTS.md), then use [architecture](architecture.md) and [API contract](api-contract.md) for cross-layer changes. Provider replacement starts in [replacing modules](replacing-modules.md). Keep provider keys in `.env` or the secure channel forms, never in React or model context.

The inspector opens beside the current page and shows task state, safe event summaries, and browser images. `/dev` opens it directly; `DEV_INSPECTOR=false` disables it. Last-known images and pending sign-in states must be shown distinctly from a live capture.

The Tools tab lists registered definitions even before a task runs. Choose a task to inspect redacted call inputs/results, status, duration, model token categories and SDK cost estimates. Filter by tool or status and load earlier records as needed. Data is retained for seven days, with 16 KiB per payload. Missing prices show as unavailable; provider fees, compaction, speech, triage and hosting are excluded. Existing tasks have no new recordings until they run again. Recording is best effort: a failed or slow inspector store can leave partial history and cost totals while the task continues. See [security](security.md) for capture and secret-masking limits.

The Linux workspace can install CLI packages with `npm install -g` and `pipx install`; `/home/node` persists in `workspace-tools`. Base OS packages belong in `Dockerfile.workspace`. Rebuild with `docker compose up -d --build --wait` after Dockerfile or guard changes. The workspace must never receive provider keys, the host Docker socket, or browser profile mounts.

## Checks

| Command                    | Scope                                                                |
| -------------------------- | -------------------------------------------------------------------- |
| `npm run check`            | TypeScript, import boundaries, formatting                            |
| `npm test`                 | Deterministic tests; database cases skip without `TEST_DATABASE_URL` |
| `npm run test:integration` | All fixtures, including PostgreSQL                                   |
| `npm run build`            | TypeScript and web bundle                                            |
| `npm run format`           | Repository formatting; avoid broad writes during parallel work       |

Database fixtures create random schemas and their own pg-boss schema, then remove only those. The integration command defaults to the local PostgreSQL service. Set `TEST_DATABASE_URL` to use a different development database.

Run focused checks while changing a boundary:

| Boundary                                      | Tests under `tests/`                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| App composition and replacement adapters      | `application-adapters`, `runtime-adapters`, `provider-adapters`                                                           |
| Task continuation, cancellation, and recovery | `task-continuation`, `task-durability`, `runtime-session`, `pi-agent`                                                     |
| HTTP, approvals, and access                   | `access`, `server-boundaries`, `chat-api`                                                                                 |
| Credential stages and browser recovery        | `vault`, `vault-staged`, `browser-login`, `browser-recovery`, `runtime-credentials`                                       |
| Google accounts and events                    | `integrations`, `provider-adapters`                                                                                       |
| Channel verification, polling, and delivery   | `channel-settings`, `channels`, `channel-application`, `messaging-transport`                                              |
| Personal learning and quiet work              | `personal`, `triage-preferences`, `task-durability`                                                                       |
| Web content, streaming, links, and audio      | `web-markdown`, `web-streams`, `message-links`, `web-speech`, `speech`                                                    |
| Inspector catalog, private records and usage  | `inspector-redaction`, `inspector-store`, `inspector-observations`, `runtime-session`, `pi-agent`, `application-adapters` |

Each name has a `.test.ts` suffix. For example:

```sh
TEST_DATABASE_URL=postgresql://sidekick:sidekick-local@127.0.0.1:54329/sidekick npx tsx --test tests/channel-settings.test.ts tests/channels.test.ts tests/channel-application.test.ts
```

Inject fake capabilities through ports and factories for feature tests. Test vendor request/response mapping separately. Fixtures must not send real messages, access real private files, buy services, or require real keys.

## Browser and live validation

After a UI change, check the real local app at desktop and narrow widths. Include empty/loading/error states, waiting questions, expired credentials, declined approvals, and unavailable providers. Chat checks include pasted images, sanitized Markdown/HTML, history, reactions, working state, and optional speech. Check that the inspector pauses for secure input and retains a labelled last-known image.

For network changes, use a synthetic task directory to verify public HTTP and registry access, private-address rejection, UID/capabilities, and persistent CLI installs. Container configuration inspection alone is weaker than an actual blocked connection.

Run live provider checks only within the authorized scope. Do not use reconnect/disconnect as a default repair for an SDK bug; preserve existing accounts. Record fixture evidence, live provider evidence, and unresolved steps separately in [verification](verification.md). A configured key, a mocked OAuth callback, or a synthetic login page does not prove the real service works.
