# Sidekick

A local personal assistant with a quiet web conversation, persistent tasks, a browser, files, a credential vault, and optional Google and messaging connections. Built with TypeScript, React, Pi, Fastify, and PostgreSQL.

This is a working single-owner prototype. It binds to `127.0.0.1` and has no public signup or user authentication. Do not publish the app or tunnel its full interface.

## Run locally

Install Node.js **22.22.3 or newer** and start Docker Desktop. From this directory:

```sh
npm run dev
```

The launcher installs missing dependencies, creates `.env`, starts PostgreSQL and the Linux workspace, installs the browser, and starts the app at [localhost:4310](http://localhost:4310). The first run downloads images and browser binaries.

Add your provider keys to the ignored `.env`, then restart. Keep keys out of chat, source files, and screenshots.

| Environment | Purpose |
| --- | --- |
| `LLM_PROVIDER=openai` and `OPENAI_API_KEY` | OpenAI conversation and tools; the same key enables speech |
| `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` | Anthropic conversation and tools |
| `LLM_MODEL` | Optional model override from the installed Pi catalog |
| `COMPOSIO_API_KEY` | Optional Google consent and API connections |
| `COMPOSIO_WEBHOOK_SECRET` | Optional signed Google event forwarding |
| `TYPESAFE_API_KEY` | Optional Jev browser decisions and notification relevance checks |
| `DATABASE_URL`, `PORT` | Local service configuration; defaults are in `.env.example` |
| `DEV_INSPECTOR=false` | Hide the developer inspector |

On macOS, the vault encryption key uses Keychain. Other hosts need `SIDEKICK_VAULT_KEY`; see [vault setup](docs/vault.md). Telegram and WhatsApp require additional explicit opt-ins and owner bindings in [channel setup](docs/channels.md).

Ctrl-C stops the app. `docker compose stop` stops its containers while retaining data. PostgreSQL uses a named volume; files, artifacts, task sessions, and browser profiles use `.local/`. Do not delete either if you want to keep the workspace.

## What is available

- Streaming conversation, multiple tasks, cancellation, persistent files, image/file uploads, voice transcription, and speech playback.
- A separate browser session per task. `/dev` shows browser screenshots and task events, not your whole Mac screen.
- Secure credential entry that pauses a task and resumes it after the broker fills the login. Passwords are not submitted through chat.
- Profile and preference editing, searchable task history, goals, recurring schedules, and quiet hourly reviews. Active goals enable reviews; notification preferences separately decide which connected events can start work.
- Gmail, Calendar, Drive, Sheets, and Docs through Composio. Google writes require review. Automatic change notifications are available only for Gmail and Calendar.
- Optional Chat SDK Telegram and WhatsApp text messages. Media and secure forms remain in the web app.

The Linux shell has **no network access**. Node, Python, and ffmpeg are preinstalled. Add packages to `Dockerfile.workspace` and rebuild when needed. Task folders share one container for this local owner; they are not a multi-tenant security boundary. The shell does not control native Mac apps or the authenticated browser profile.

## Validation status

As of **2026-09-24**, live checks passed for OpenAI conversation, image understanding, a browser task with a downloadable artifact, the developer browser screen, speech generation and transcription, an audio reply requested in chat, and saving/removing a synthetic credential with the macOS Keychain-backed vault. Gmail consent and a real label-listing action passed. Google Calendar consent passed. The one-command launcher started the database, workspace, browser installation and app successfully.

Google Calendar actions, Drive/Docs/Sheets consent and actions, external Google event delivery, Jev, Anthropic, and recipient delivery on Telegram/WhatsApp remain unverified. These providers need their own account configuration; no new paid plan was purchased. A configured key is not proof of a working provider connection.

Hourly reviews need either Jev or an OpenAI triage key, including when Anthropic runs the main agent. Quiet hours block automatic task starts, and at most two automatic event/review tasks start per hour. Background tasks suppress streamed prose and automatic final replies; an explicit useful message or necessary question can still be sent. Saved updates can be reconsidered during later reviews, but there is no guaranteed digest delivery. Schedules run while the local machine and app are running.

Deterministic tests cover task dispatch/recovery, runtime boundaries, secure credential handling, OAuth/event ownership, and messaging retries with synthetic data. They do not prove a live account or production deployment.

```sh
npm run check
npm run test:integration
npm run build
```

The integration command uses the local PostgreSQL service and creates disposable schemas. Set `TEST_DATABASE_URL` to use another service. `npm test` skips database fixtures unless that variable is set. See [development](docs/development.md), [architecture](docs/architecture.md), [security](docs/security.md), [Google connections](docs/composio.md), and [production requirements](docs/production.md).
