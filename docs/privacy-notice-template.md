# Privacy notice: operator template

**Draft, checked against the implementation on 2026-09-28. Do not publish unchanged.** The repository does not identify the operator of a deployment or establish its retention policy. Replace every bracketed placeholder, list the providers actually enabled, and remove features that deployment does not offer. Confirm how requests for access or deletion will be handled before inviting users. This template is not a legal compliance assessment.

## Configure the public notice

Copy only the notice draft below into `public/privacy-notice.md` and customize it. This file is intentionally public, including its raw Markdown: never include credentials, connection strings, internal configuration or private user information. Do not copy this document's operator instructions or publish its placeholders.

For local development, set the gateway environment value:

```dotenv
OTTO_PRIVACY_NOTICE_FILE=public/privacy-notice.md
```

The build copies this file to `dist/web/privacy-notice.md`, which the Cloudflare image includes. Set `OTTO_PRIVACY_NOTICE_FILE=dist/web/privacy-notice.md` in that environment's `GATEWAY_ENV`. Only the path belongs in the gateway JSON, whose 5 KiB limit still applies; do not embed the notice text there. Keep the file containing the rest of the gateway configuration ignored and owner-readable. See the [Cloudflare runbook](../deployment/cloudflare/README.md#environments-and-secrets).

The gateway reads the UTF-8 file at startup, with limits of 128 KiB and 32,000 characters. A configured file that cannot be read or fails validation prevents startup with a fixed error. Omitting the setting returns `content:null`, not a default policy. Anonymous `GET /api/privacy` serves `{content:string|null}` and `/privacy` displays it before sign-in. Neither the path setting nor the notice is forwarded to tenant runtimes. Changing the notice requires rebuilding the image and restarting the gateway for hosted deployment; this optional setting is not an automatic production-readiness gate.

Before sharing a hosted signup link, open `/privacy` while signed out, confirm it contains the reviewed operator/contact details and current practices, and set the Google OAuth client's privacy-policy URL to that HTTPS page. Test login separately. See [production requirements](production.md#privacy-and-google-sign-in).

## Notice draft

```markdown
Effective date: [YYYY-MM-DD]

[OPERATOR NAME] operates this Otto service at [SERVICE URL]. Contact [PUBLIC CONTACT EMAIL] about your information or this notice.

## Information we handle

Google sign-in provides your account identifier, name, email, verified-email status and profile picture. Otto stores authentication tokens, login sessions and browser user-agent information. It uses session cookies to keep you signed in; Otto sessions expire after seven days.

We store your chats, uploaded and generated files, task history, saved profile details and memories, goals, schedules, notification preferences and account settings to provide the assistant and continue your work. Connected apps can provide messages, documents, calendar details and other content needed for your requests. Background updates can create stored event summaries and notifications.

The assistant's remote browser and workspace can retain task files, screenshots and website sessions, including cookies. If you use Vault, it stores the login or payment-card details you choose to save in encrypted form. Telegram setup stores encrypted bot credentials and your configured sender ID; messages and delivery records are stored separately.

## How information is used and shared

We use this information to sign you in, carry out your requests, remember relevant context, run scheduled work and connected-app updates, and operate the service.

Hosting, database and file-storage providers: [ACTUAL PROVIDERS AND RELEVANT LOCATIONS]. AI providers: [ACTUAL PROVIDERS, INCLUDING SEPARATE SPEECH OR RELEVANCE SERVICES]. Relevant messages, files, images, personal context and tool results can be sent to these AI services to perform the work. Remote-computer provider: [ACTUAL PROVIDER]. Websites and services the assistant contacts receive information submitted to them.

Google handles sign-in. Composio manages connected-app authorization and tools; it and the selected app providers process connection information and requested operations. Connecting Gmail or Calendar is separate from signing in to Otto. If you use Telegram, Telegram processes the messages and files exchanged with your bot. These providers also handle information under their own terms and privacy policies: [LINKS FOR ACTUAL PROVIDERS].

Access is scoped to your Otto account. The service operator controls the infrastructure and can access stored data and decrypt credentials when operating the service. This is not end-to-end encrypted storage that hides information from the operator.

## Retention and your choices

[STATE THE ACTUAL RETENTION PERIODS OR CRITERIA, BACKUP PRACTICES, AND PROCESS FOR ACCESS OR DELETION REQUESTS.]

Starting a new chat archives the previous conversation; it does not erase its history. Disconnecting an app stops that connection but does not erase earlier conversations, files or event records. Disconnecting Telegram does not revoke its bot token or remove Telegram's copies. Pausing a remote computer preserves its state.

Otto does not currently provide complete self-service account deletion. Contact [PUBLIC CONTACT EMAIL] to request access, correction or deletion; this requires operator action across the relevant systems. [DESCRIBE HOW REQUESTS ARE HANDLED AND ANY ACTUAL RETENTION LIMITATIONS.] Deleting Otto data does not itself establish deletion from a provider's systems or backups.

Developer diagnostics are optional and can contain prompts and tool content. When enabled, these records are pruned after seven days. Ordinary hosted accounts do not record these diagnostic payloads; this limit does not apply to ordinary chat, file or task history.

Failed message routing can retain a private diagnostic record for seven days even when optional developer diagnostics are disabled. It contains a fixed failure code, optional HTTP status and bounded model, timing and usage information, without prompts, outputs, raw errors or credentials.
```

## Implementation basis

Review the [security boundaries](security.md), [authentication adapter](../src/providers/better-auth/index.ts), [stored application records](../src/server/db.ts), [integration lifecycle](../src/server/integrations.ts), [channel settings](../src/server/channel-settings.ts) and [provider selection](../src/server/composition.ts) when adapting the draft. In particular, encryption does not remove operator access, an idle computer is not deleted, and app/channel disconnect is not full historical-data deletion. The code does not establish providers' training policies, retention periods, human access, regional confinement or backup deletion. Do not add those promises without separate evidence.

Google requires an accurate published privacy policy describing access, use, storage and sharing of Google user data, independently of an app's verification exception. Its brand-verification requirements also cover public homepage access, privacy links and domain ownership. Sources checked **2026-09-27**: [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), [authentication verification requirements](https://developers.google.com/identity/verification/authentication-verification).
