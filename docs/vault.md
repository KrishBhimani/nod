# Website credential vault

The vault stores website passwords in PostgreSQL and sends plaintext only to the trusted browser injection callback. Google OAuth credentials belong to Composio, not this vault. The current form accepts username/password pairs or an expiring verification code. It has no payment-card fields, card autofill, stored CVV, or TOTP-seed support.

## Encryption and setup

Each password record uses AES-256-GCM with a random 96-bit nonce. The authenticated data binds the ciphertext to its owner, exact website origin, and record ID. Moving ciphertext between records, accounts, or websites fails authentication. Only the label, origin, a short username hint, and timestamps are returned to the UI.

The master key is outside PostgreSQL. On macOS, the app reads or creates the `dev.sidekick.vault` / `master-key-v1` generic-password item in the user's Keychain. Keychain access can require an OS prompt. It fails closed when the key is unavailable. On other systems, or when an explicit key is preferred, provide `SIDEKICK_VAULT_KEY` as exactly 32 random bytes encoded in base64. Do not commit it or put it in a browser-exposed variable. Back up the key separately from the database; losing it loses the saved passwords. Key rotation is not yet implemented.

PostgreSQL encryption at rest alone does not isolate secrets from a running database or application. The app must decrypt passwords when it fills a website. This local design protects database copies; it is not protection against a compromised trusted server or another process with equivalent OS access. The current Keychain command-line bridge also briefly passes a generated key to the `security` process during creation. Strong isolation needs a distinct trusted broker identity and an agent execution environment that cannot read its memory, environment, browser profile, or key store. [PostgreSQL encryption options](https://www.postgresql.org/docs/current/encryption-options.html), [Apple Keychain](https://developer.apple.com/documentation/security/keychain-services).

## Credential requests

The runtime supplies a task, website origin, form selectors, and request kind. The vault issues a random 256-bit form token, stores only its hash, and expires it after ten minutes. The secure form is a local same-origin route. Its API responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

Only one submission can be in flight for a request. The broker verifies the current page's exact origin and fills the supplied fields while browser observations are locked. Selectors target the top-level page; iframe login fields require a future explicit broker flow. Successful password entry saves an encrypted vault record. A successful request is consumed, and a durable pending flag retries task continuation if scheduling fails. The resume callback must be idempotent. Failed injection returns a fixed error and requires freshly entered values; the request can be retried until expiry. After a server restart, an interrupted form submission returns to pending and requires fresh input. No password or code is restored from a request record.

The broker-only `fillSaved()` method decrypts a selected record only for the matching owner and origin. The caller should use automatic reuse only when the account choice is unambiguous. A durable ledger permits one automatic fill per task and origin. It records the attempt before injection and also blocks automatic reuse after a password form has already been completed for that task and origin. A rejected login therefore leads to a fresh user form instead of repeatedly submitting the saved password. A form completion or successful injection confirms that fields were filled; it does not prove the website accepted the login. The agent must inspect the resulting page and request another user step when necessary.

OTP values are passed directly to the broker and never written to either vault or request records. SMS or email codes still require the user to obtain and enter them. Push prompts, passkeys, hardware security keys, CAPTCHA, and unsupported iframe flows require human interaction. Entering a code does not defeat the provider's additional verification requirements.

Passwords can become visible to page JavaScript after injection, and session cookies are credentials too. Suppressing normal tool output alone is insufficient: the agent must not have arbitrary browser JavaScript, CDP, profile-file, or trusted-process access. Browser pages can also echo credentials into visible content. These limits must remain explicit when describing the local build's guarantees. [Browser Use secret injection limits](https://docs.browser-use.com/cloud/guides/secrets), [agent-browser security](https://agent-browser.dev/security).

## Validation

Tests check tamper rejection, cross-owner/origin/record binding, metadata-only responses, hashed request tokens, one concurrent submission, expiry, safe failure messages, password encryption, and absence of OTP values from PostgreSQL. They use synthetic passwords and disposable database schemas. Live websites and Keychain authorization are separate checks and are not implied by passing these tests.
