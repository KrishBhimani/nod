# Sidekick

A local personal assistant with a conversation, persistent tasks, a browser, a Linux workspace, secure sign-in, and optional Google and messaging connections. Built with TypeScript, React, Pi, Fastify, and PostgreSQL.

This is a single-owner prototype. It binds to `127.0.0.1` and has no public signup or app authentication. Do not publish or tunnel the full application.

## Run locally

Install Node.js **22.22.3 or newer** and start Docker Desktop:

```sh
npm run dev
```

The launcher installs missing dependencies, creates `.env`, starts PostgreSQL and the Linux workspace with its network guard, installs the browser, and opens the server at [localhost:4310](http://localhost:4310). The first run downloads container images and browser binaries.

Add provider keys to the ignored `.env`, then restart. Keep keys out of chat, source files, and screenshots.

| Configuration                                 | Purpose                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `LLM_PROVIDER=openai`, `OPENAI_API_KEY`       | OpenAI conversation and tools; also enables speech and fallback relevance checks |
| `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` | Anthropic conversation and tools                                                 |
| `LLM_MODEL`                                   | Optional model override from the installed Pi catalog                            |
| `COMPOSIO_API_KEY`                            | Optional Google consent and tools                                                |
| `COMPOSIO_WEBHOOK_SECRET`                     | Signed Google event forwarding                                                   |
| `TYPESAFE_API_KEY`                            | Optional Jev browser choices and relevance checks                                |
| `DATABASE_URL`, `PORT`                        | Local service settings; defaults are in `.env.example`                           |
| `DEV_INSPECTOR=false`                         | Disable the inspector and new debug recordings                                   |

macOS Keychain supplies the encryption key for the vault and saved channel settings. Other hosts require `SIDEKICK_VAULT_KEY`; see [vault setup](docs/vault.md). Telegram and WhatsApp credentials can be saved through **Channels**, outside chat. Telegram supports local polling without a tunnel; WhatsApp still requires Meta callback setup and an eligibility check.

Ctrl-C stops the app. `docker compose stop` stops containers without deleting data. PostgreSQL and installed CLI tools use named volumes; task files, artifacts, transcripts, and browser profiles use `.local/`. Deleting these loses local state.

## Use the app

The sidebar contains **Chat, Goals, Schedule, Connections, Channels, and Vault**. Setup and personal context are managed through conversation, with review where required.

- Chat supports streamed replies, file uploads, pasted images, downloadable artifacts, reactions, timestamps, and task continuation. Markdown and embedded HTML are sanitized. Speech playback is optional; there is no recording control.
- Each task has a browser session. The inspector opens alongside chat and refreshes its browser image about once a second. Pending secure steps pause observation; a labelled last-known image can remain visible.
- The inspector’s Tools tab lists available tool schemas, redacted call inputs/results, timing, and assistant-model token/cost estimates. Recordings expire after seven days; missing prices stay unavailable. Estimates exclude speech, compaction, integrations, browser services and hosting.
- Secure forms support observed identifier, password, and one-time-code steps. The trusted broker fills the website and resumes inspection; successful entry does not prove the website accepted the login.
- Explicit personal facts can be remembered from the current user's own quoted message. Profile learning requires an explicit statement or a matching answer. Other proposed personal changes and Google writes require review.
- Goals and schedules persist locally. Preferences, active goals, recent context, and feedback inform inexpensive hourly reviews before a main-agent task starts.
- Connections supports multiple accounts for Gmail, Calendar, Drive, Sheets, and Docs. Tools, approvals, disconnect, and watches bind to a specific account. Gmail/Calendar watches are requested by default; the UI reports when signed webhook delivery is unavailable or still pending.
- Channels supports one allowlisted owner through Telegram or WhatsApp Business Cloud, with text replies. Secure forms, approvals, and attachments remain in the local web app.

The Linux workspace can access the public IPv4 Internet and install CLI tools with `npm install -g` or `pipx install`. Node, Python, git, curl, and ffmpeg are included. Private/LAN/metadata destinations and external IPv6 are blocked by a separate network guard. The workspace runs without root privileges or Linux capabilities and has no provider keys, Docker socket, or authenticated browser profiles.

This is not native Mac control or a GUI desktop. Task directories and installed tools share one local-owner container; they are not tenant isolation. Public Internet access can transmit workspace content, so these controls do not prevent every prompt-injection or data-disclosure attack.

## Quiet work and current limits

Hourly reviews need Jev or an OpenAI relevance key, including when Anthropic runs the main agent. Default notification rules favor time-sensitive requests, meaningful calendar changes, and concrete goal progress. Quiet hours block automatic task starts; an hourly review can still save a decision for later. At most two automatic event/review tasks start per hour. Background work suppresses streamed prose and automatic final replies, with explicit messages reserved for useful results or necessary questions. There is no guaranteed digest delivery.

Schedules, polling, and reviews require the app and Mac to stay running. Interrupted external actions need review before retry. WhatsApp sends only within the accepted owner's 24-hour reply window; templates and delayed proactive messages are not implemented. Passkeys, hardware-key interaction, remote manual browser control, and payment-card storage are not implemented.

## Validation

The [validation record](docs/verification.md) separates automated fixtures, browser flows, and live providers. Existing live checks include OpenAI conversation/images, a browser task and artifact, inspector screenshots, speech and transcription APIs, a synthetic Keychain-backed vault entry, Gmail consent and label listing, and Calendar consent. Local workspace checks also verified public HTTP, npm/PyPI access, a CLI install, unprivileged writes, and blocked private destinations.

Calendar actions, Drive/Docs/Sheets account flows and actions, external Google event delivery, Jev, Anthropic, and Telegram/WhatsApp recipient delivery still require separate live verification. No new paid plan was purchased. Configuration and passing fixtures do not prove a live connection.

```sh
npm run check
npm run test:integration
npm run build
```

Database fixtures create disposable schemas. See [development](docs/development.md) for focused checks and [production requirements](docs/production.md) before hosting.

## Find or replace code

Start with [AGENTS.md](AGENTS.md). [Architecture](docs/architecture.md) explains ownership; [replacing modules](docs/replacing-modules.md) maps capability interfaces and migration limits. Vendor SDKs stay in `src/providers`; `src/server/composition.ts` selects implementations. Read [security](docs/security.md), [Google connections](docs/composio.md), and [channels](docs/channels.md) for their boundaries.
