# Sidekick

A local personal assistant with a conversation, persistent tasks, a browser, a Linux workspace, secure sign-in, and optional Google, Slack, Notion and messaging apps. Built with TypeScript, React, Pi, Fastify, and PostgreSQL.

This is a single-owner prototype. It binds to `127.0.0.1` and has no public signup or app authentication. Do not publish or tunnel the full application.

The [system guide](docs/system-guide.md) is the living reference for product behavior, the exact stack, data flows, trust boundaries, costs, validation gaps, and module replacement. The [internal team brief](docs/team-brief.md) summarizes the implementation and remaining work.

## Run locally

Install Node.js **24.21.0 or newer** and start Docker Desktop:

```sh
npm run dev
```

The launcher installs missing dependencies, creates `.env`, starts PostgreSQL, the Linux workspace and the browser container, then opens [localhost:4310](http://localhost:4310). The launcher also creates a random PostgreSQL password in `.env` at mode 0600 and updates the existing local role without recreating data. The first run builds and downloads container images. Chromium is installed inside the browser image; Sidekick does not install or launch Chrome on your Mac.

Add provider keys to the ignored `.env`, then restart. Keep keys out of chat, source files, and screenshots.

| Configuration                                 | Purpose                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `LLM_PROVIDER=openai`, `OPENAI_API_KEY`       | OpenAI conversation and tools; also enables speech and fallback relevance checks |
| `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` | Anthropic conversation and tools                                                 |
| `LLM_MODEL`                                   | Optional model override from the installed Pi catalog                            |
| `COMPOSIO_API_KEY`                            | Optional Google, Slack and Notion Apps consent and tools                         |
| `COMPOSIO_WEBHOOK_SECRET`                     | Signed connected-app event forwarding                                            |
| `TYPESAFE_API_KEY`                            | Optional Jev browser choices and relevance checks                                |
| `DATABASE_URL`, `PORT`                        | Server database and port; the launcher generates local database credentials      |
| `DEV_INSPECTOR=false`                         | Disable the inspector and new debug recordings                                   |

macOS Keychain supplies the encryption key for the vault and saved channel settings. Other hosts require `SIDEKICK_VAULT_KEY`; see [vault setup](docs/vault.md). Telegram and WhatsApp credentials can be saved through **Channels**, outside chat. Telegram supports local polling without a tunnel; WhatsApp still requires Meta callback setup and an eligibility check.

Ctrl-C stops the app. `docker compose stop` stops containers without deleting data. PostgreSQL, installed CLI tools and browser state use the `postgres-data`, `workspace-tools` and `browser-data` volumes. Task files, artifacts and transcripts use `.local/`. Deleting these loses local state. Existing host browser profiles are not copied into the container.

## Use the app

The sidebar contains **Chat, Goals, Schedule, Apps, Channels, and Vault**, with the optional Inspector below. Setup and personal context are managed through conversation, with review where required. Outside editable fields, Cmd on Mac or Ctrl elsewhere plus J opens Chat, G Goals, S Schedule, E Apps and D Channels. Vault, Inspector and sidebar collapse use their buttons. Hold the modifier for 650 ms to show letter hints; hints stay hidden while editing. Navigation also supports arrow keys, Home and End, with labelled links and focus states. On phone screens, Chat stays directly accessible in a compact top bar. The top-right navigation menu contains the other pages, theme switch, Inspector and Get started.

- One chat supports streamed replies, quoted replies, uploads, pasted images, artifacts, Unicode emoji reactions, grouped timestamps and history. Six common reactions open beside the message; More loads the searchable emoji picker. Selecting the same reaction removes it. Tiptap renders Markdown while editing, with no toolbar or preview switch. Enter sends; Shift-Enter creates the next list item, exits an empty item, or inserts a line elsewhere. A slim rail jumps to loaded user turns. Eligible public links can show cached metadata and proxied image cards as messages approach the viewport; secure or unavailable links remain ordinary links. Markdown and embedded HTML are sanitized; there are no recording or Read aloud controls.
- Images, audio, video and PDFs use the same attachment viewer before and after sending. Galleries show up to four tiles with an overflow count. Viewer controls show a counter without filename or size metadata; arrow keys change the item without moving focus. Supported media use native controls, while unsupported files remain downloads.
- **Get started** archives the current web conversation, cancels its pending work and starts setup in a fresh generation. It preserves accounts, Vault, saved preferences, profile/memory, goals, schedules and other channels. Archived messages remain stored; no restore button or permanent deletion is implemented. The current flow has fixture coverage; no live owner reset was executed.
- Live typing shows ongoing work. Longer requests get a concrete agent update when useful; elapsed time alone never inserts a canned reply.
- Each task has an isolated profile in the Linux browser container. The `/browser` window follows current browser activity and remains available when Inspector is disabled. Normal captures are masked; pending secure steps pause observation and hide the browser image.
- The inspector has **Screen, Activity, Tools, Models, Costs and Prompts**. Activity shows current work and execution history. Tools opens recent calls, with separate grouped usage and available-tool views; Models shows request and token details. Message inspection narrows diagnostics. Costs keeps owner-wide provider and operation summaries visible; tool cost covers only directly attributed provider operations. Unknown prices stay unavailable. Private prompt snapshots show effective instructions and context for an execution, with redaction and seven-day retention. Only raw payloads, schemas, metrics and instruction text require expansion. These are recorded estimates and usage, not a provider invoice.
- **Take control** is always available in the browser view. It opens the private workspace browser, including when no task has started. Active work pauses; **Resume agent** returns control after a normal browser shutdown. Finished work keeps its existing page and profile; **Done** releases control without restarting the task. With no browser session, **Done** closes the standalone browser. Private control frames never become model screenshots or saved artifacts. Website acceptance is not guaranteed.
- Secure forms support observed identifier, password, and one-time-code steps. The trusted broker fills the website and resumes inspection; successful entry does not prove the website accepted the login.
- **Vault** has one Add to Vault action for logins and payment cards. Its list shows login names, websites and full usernames, or card names, brands, last four digits and expiry. Entries open directly as editable forms, with Save changes shown after an edit and confirmed deletion inside the modal. Saved passwords, card numbers and optional CVC/CVV stay masked; Show or Copy retrieves them only when requested. Change opens an empty replacement field. Copying a hidden value keeps it hidden, and closing the view or leaving the window clears revealed values.
- Explicit personal facts can be remembered from the current user's own quoted message. Profile learning requires an explicit statement or a matching answer. Known ordinary actions execute from a clear request; destructive or unclear actions ask for a specific confirmation in chat. Draft-only requests never authorize sending.
- **Goals** separates Active and Completed, with paused goals grouped under Active. **Schedule** separates Upcoming and History for one-off and recurring work. Create, update, pause and resume controls prepare chat drafts; the agent can apply validated local plan changes without a second confirmation. Delete uses one confirmation on the page. Saved data stays visible during background reads, with Try again after a failed read. Preferences, active goals, recent context and feedback inform inexpensive hourly reviews before a main-agent task starts.
- **Apps** supports multiple accounts for Gmail, Calendar, Drive, Sheets, Docs, Slack and Notion in a simple service list. Each row offers Connect or Add account; connected accounts have their own actions. Tools, confirmations, disconnect and watches bind to a specific account. Gmail/Calendar watches are requested by default; the API retains pending/unavailable delivery state without notification setup copy in the rows. A configured account is not proof of event delivery.
- Channels supports one allowlisted owner through Telegram or WhatsApp Business Cloud. Telegram can upload owned task images/files; WhatsApp retains text replies and a local-app attachment fallback. Secure credential forms remain in the local app; action confirmations use text replies in the originating chat. Media delivery has fixture coverage, not live recipient proof.

The Linux workspace can install CLI tools with `npm install -g` or `pipx install`. Node, Python, git, curl, and ffmpeg are included. Browser and shell traffic use normal Docker networking, with no Sidekick private-address, port or IPv6 deny policy; actual reachability follows Docker and host routing. The workspace runs without root privileges or Linux capabilities and has no provider keys, Docker socket, or authenticated browser profile mounts.

The trusted browser has a separate container and private data volume, with no published port. The server uses a fixed Docker-exec bridge; the shell cannot access its profile, control socket or display. The sign-in view controls only that browser, not your Mac or a general desktop. Task directories and installed tools share one local-owner workspace; they are not tenant isolation. Network access can transmit workspace content or reach other accessible services, so these controls do not prevent every prompt-injection or data-disclosure attack.

## Quiet work and current limits

Hourly reviews need Jev or an OpenAI relevance key, including when Anthropic runs the main agent. Default notification rules favor time-sensitive requests, meaningful calendar changes, and concrete goal progress. Quiet hours block automatic task starts; an hourly review can still save a decision for later. At most two automatic event/review tasks start per hour. Background work suppresses streamed prose and automatic final replies, with explicit messages reserved for useful results or necessary questions. There is no guaranteed digest delivery.

Schedules, polling, and reviews require the app and Mac to stay running. Interrupted external actions need review before retry. WhatsApp sends only within the accepted owner's 24-hour reply window; templates and delayed proactive messages are not implemented. Vault stores encrypted website logins and payment cards, including an optional card security code, with explicit secret reveal. Passkeys, hardware-key interaction and card autofill are not implemented. Manual browser takeover supports bounded click, typing, keys and scroll after pausing agent work; it uses a revision-bound lease and explicit resume. Synthetic fixtures cover the container transport and private desktop lifecycle. They do not establish real website login or 2FA acceptance.

## Validation

The [validation record](docs/verification.md) separates automated fixtures, browser flows, and live providers. Historical checks include OpenAI conversation/images, browser/file work, Inspector, speech APIs, synthetic Keychain storage and Google consent/reads. Earlier workspace checks covered public HTTP, registry access, CLI installation and the now-removed network guard. Those dated results describe their source versions; earlier host-browser and synthetic authentication runs do not validate the new container browser. Check the validation record for current container evidence.

Calendar actions, Drive/Docs/Sheets account flows and actions, Slack/Notion actions, external app event delivery, Jev, Anthropic, and Telegram/WhatsApp recipient delivery still require separate live verification. No new paid plan was purchased. Configuration and passing fixtures do not prove a live connection.

```sh
npm run check
npm run test:integration
npm run build
```

Database fixtures create disposable schemas. See [development](docs/development.md) for focused checks and [production requirements](docs/production.md) before hosting.

## Find or replace code

Start with [AGENTS.md](AGENTS.md). [Architecture](docs/architecture.md) explains ownership; [replacing modules](docs/replacing-modules.md) maps capability interfaces and migration limits. Vendor SDKs stay in `src/providers`; `src/server/composition.ts` selects implementations. Read [security](docs/security.md), [Apps](docs/composio.md), and [channels](docs/channels.md) for their boundaries.
