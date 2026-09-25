# Local development

Use Node.js 24.21.0 or newer and Docker Desktop. From the repository root:

```sh
npm run dev
```

The launcher installs missing dependencies, creates `.env`, starts PostgreSQL, the Linux workspace and the trusted browser container, then serves [localhost:4310](http://localhost:4310). The first run builds and downloads images. Chromium and its desktop tools are installed only in `Dockerfile.browser`; no host Chrome install or launch is required. Provider setup is in [README](../README.md), [Composio](composio.md), [channels](channels.md), and [vault](vault.md).

Ctrl-C stops the web process. `docker compose stop` retains data. Do not use `docker compose down -v` unless you intend to remove the database, installed-tool and browser-data volumes. Existing host browser profiles are not migrated. Never reset another project or the normal local profile to run a test.

The launcher prepares PostgreSQL before browser/workspace services. It generates `SIDEKICK_POSTGRES_PASSWORD` only when absent, saves it with the matching local `DATABASE_URL` in private `.env`, starts PostgreSQL, updates only the `sidekick` role password through local psql stdin, verifies authentication, then starts the remaining services. Repeating startup retains the generated password. If rotation fails, startup stops before the app starts; retrying can repair the role through the same Unix-socket path. Existing tables and rows are not reset. An explicitly configured external server database is preserved. The launcher removes the old network-guard orphan after recreating services.

## Code and local state

Read the relevant [area guide](../AGENTS.md), then use [architecture](architecture.md) and [API contract](api-contract.md) for cross-layer changes. Provider replacement starts in [replacing modules](replacing-modules.md). Keep provider keys in `.env` or the secure channel forms, never in React or model context.

The sidebar Inspector button opens beside the current page and shows task state, safe event summaries, and browser images. It has no app keyboard shortcut. `/dev` opens it directly; `DEV_INSPECTOR=false` disables diagnostics but keeps `/browser` and its owned control routes available. Last-known images and pending sign-in states must be shown distinctly from a live capture. Native sign-in uses a separate transient owner-only frame route; it must never enter ordinary screenshot storage or agent context.

The Tools tab lists registered definitions even before a task runs. Choose a task to inspect redacted call inputs/results, status, duration, model token categories and SDK cost estimates. Filter by tool or status and load earlier records as needed. Data is retained for seven days, with 16 KiB per payload. The Provider usage section also counts model auxiliary work and adapter operations for browser, integrations, speech, relevance, channels and workspace access. It supports the selected task or all activity. Costs appear only when reported by a provider or estimated by the model SDK; unknown prices stay unavailable. Coverage notes distinguish operation counts from billable requests, and hosting billing is not connected. Existing tasks have no new recordings until they run again. Recording is best effort: a failed or slow inspector store can leave partial history and cost totals while the task continues. See [security](security.md) for capture and secret-masking limits.

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

`scripts/e2e-sidekick.ts` includes synthetic Telegram and WhatsApp setup through the real Channels forms and encrypted settings. Both start disconnected. The local `/e2e` operator page lists fixed fixture values; arbitrary credentials and callback URLs are rejected. The transport has no polling, accepts no incoming messages and rejects every delivery. Configured and pending-callback screens prove UI behavior only, not provider verification or delivery. `tests/e2e-harness.test.ts` checks these limits.
