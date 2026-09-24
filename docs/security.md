# Trust and local access

This version binds to loopback and serves a single approved development account. It is not a multi-user authentication system. Normal application requests reject foreign Host and Origin headers. Do not expose the app with a tunnel or reverse proxy before adding real user sessions and tenant authorization. The signed Composio webhook endpoint has a separate policy when configured.

Never put provider keys in prompts, React configuration, task files, artifacts or logs. The model may use bounded tools; it does not receive a tool that reads arbitrary host files or reveals a vault value. Tool arguments and raw exceptions are not logged by the main server. This does not make conversation content non-sensitive: local messages, memories and task transcripts still need private backups and retention limits.

Prompt instructions are not a secrecy boundary. The model receives operating instructions and can make mistakes about disclosing them or following hostile content. Keep secrets out of its context, constrain tools on the server, and require review for Google writes and persistent personal-data changes. This prototype does not claim complete prompt-injection resistance. An approved browser destination can receive typed values and observe actions; never treat all page content as trusted.

## Vault

AES-GCM protects stored credentials. The encryption key lives outside PostgreSQL: Keychain on macOS, or an explicitly provided environment key on another machine. A cloud deployment should use KMS envelope encryption and workload identity. A non-exportable KMS key still lets an authorized running service decrypt data. Ordinary cloud KMS does not hide credentials from an administrator who controls that service or its host.

Keeping secrets from the infrastructure operator requires a different architecture, such as a local user-controlled broker or attested confidential execution with externally controlled key release. This repository does not implement that claim. The website receiving a login and the trusted broker necessarily handle the credential. Composio holds the OAuth credentials for connections it manages.

The agent cannot have unrestricted shell access to the authenticated browser, its profile, CDP or the vault. The task container therefore has no network access. The broker rejects private-network browser destinations and keeps credentials out of snapshots and screenshots during injection. Site scripts and phishing remain risks: bind entry to an exact origin and require a new request after navigation to another origin.

No credit-card PAN or CVV storage is implemented. Use saved merchant payment methods or user checkout for early tests. An encrypted password table does not turn the product into a payment vault.

## Files

Uploads have a 15 MB limit. Artifacts are copied from a verified task workspace path into a private store. HTML and other active files download as attachments with sandbox response headers. Do not expose the whole workspace as static files. Keep `.env`, `.local`, browser profiles and database volumes out of Git.
