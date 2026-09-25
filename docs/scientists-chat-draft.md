# Scientists-chat announcement

The original announcement was verified posted on 2026-09-25: https://n8nio.slack.com/archives/C0BT5S8CV42/p1790351646964669. The text below is the refreshed brief; later changes are shared as a follow-up instead of posting the full introduction again.

---

TL;DR: Sidekick is a local assistant that can do work from one chat: use connected apps, browse websites in its own computer, create files, remember context, and follow goals and schedules. The basic flows are working, with recorded examples below. It is still a prototype; Google/X sign-in and live integration coverage need more work.

**How it works**

- React chat → Node/Fastify server → Pi model/tool loop. PostgreSQL keeps conversations, task state and scheduled jobs so a follow-up can continue the same work.
- Three Docker containers: database, Linux workspace and browser. The browser runs inside the workspace environment, not in your own Chrome. The shell and browser have internet access; browser profiles and server keys stay separate from the shell.
- Apps use Composio for account connections and actions. A clear request can authorize ordinary work. A request to draft does not authorize sending; destructive or unclear actions ask a question in chat.
- Website passwords and verification codes go through a private Vault form, outside the chat and model. Sidekick resumes after submission. You can also take over the container browser when a site needs human interaction.

**What you can try**

Public browsing and screenshots; file creation and attachment previews; named logins and cards in Vault; goals with active/completed views; one-off and recurring schedules; mobile navigation and light/dark themes; and Inspector for tool calls, activity and estimated costs. Gmail, Calendar, Drive, Docs, Sheets, Slack and Notion adapters are present, with optional Telegram/WhatsApp channels. Each provider still needs its own live validation.

**Run it**

The code is in https://github.com/n8n-io/sidekick, currently on branch `feat/sidekick-workspace` / PR https://github.com/n8n-io/sidekick/pull/1. Install Node 24.21+ and Docker Desktop, check out that branch and run `npm run dev`. Add an OpenAI or Anthropic key to the ignored `.env`; add a Composio key if you want Apps. The launcher prepares the three containers and opens localhost:4310. macOS uses Keychain for the Vault key; other hosts need `SIDEKICK_VAULT_KEY`. The app and machine must stay running for schedules.

**Current state and next work**

The current local run passed 741 tests with no skips, checks and build. CI repeats PostgreSQL tests, type/import checks, build and secret scans; the PR has its current result. The review fixed command cancellation, artifact boundaries, scheduled action authority, recovery races and slow Apps reads. Desktop/mobile themes have been visually checked and recorded.

The login and 2FA recordings use synthetic accounts. They do not prove Google or X login. Headed workspace Chromium now reaches the real X sign-in page. Email and password are collected in one form across staged site pages; sign-in method selection happens in chat. Google can still reject automated sign-in, with private container-browser takeover available. Provider authentication remains separate validation.

Next priorities: reliable provider sign-in and recovery, live connection/message-delivery tests, review findings, and better coverage of task continuity, memory and cost reporting. This is a single-owner local app; public authentication, tenant isolation, operational recovery and hosting remain unfinished. Payment-card autofill and general desktop control are not implemented.

**Recordings:** https://n8nio.slack.com/archives/C0BT5S8CV42/p1790351018250929 — four playable examples plus the full gallery: 12 current clips and 17 earlier recordings, each with its result and limits.

The README and `docs/system-guide.md` cover setup and architecture. Feedback on the actual workflows and rough edges is welcome.
