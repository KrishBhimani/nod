# Staged sign-in acceptance — 2026-09-25

This run used the real local app, OpenAI `gpt-6-sol`, task workers and headed Chromium in a disposable workspace browser container. Northstar, its credentials, verification code and invoice were synthetic. The normal local profile was not reset.

## Observed flow

1. The user asked Sidekick to open the Northstar staged sign-in page and read invoice NS-1043.
2. The page offered email, Google and Apple. Sidekick asked which method to use in chat, without creating a Vault request first.
3. The user answered “Use email.” The same task continued and provided an **Add login** link.
4. One secure form collected the item name, email and password. The site first accepted the identifier, then showed a separate password page. Sidekick filled that password stage from the encrypted, bounded pending value without another password form.
5. Sidekick requested the separate verification code. After it was submitted, the original task reported **NS-1043: EUR 85.00, Paid**.

Database verification found exactly two filled secure requests: `identifier` and `otp`. No password request was created. The named login was saved with its Email label and exact website origin. The original task completed at revision 3. Container fixture events recorded accepted identifier, password and verification-code submissions; the portal was read after verification.

The same fresh app then opened the real X sign-in page in its workspace browser. Sidekick reported the available methods and did not select one or enter credentials. The workspace browser frame was available. This confirms navigation recovery, not X account authentication. The [headed-browser report](2026-09-25-headed-browser.md) records the isolated headless/headed comparison and native takeover/continuation checks.

## Checks and limits

- The full PostgreSQL-backed integration run passed **693 tests, zero failures and zero skips**. An earlier concurrent run picked up the new draft-authority regression before its fix; the final run used the completed source.
- TypeScript, architecture checks, formatting and the production web build passed. The existing large-bundle warning remains.
- Focused tests cover staged-password restart, expiry, exact owner/origin/revision binding, rejected credentials and uncertain injection. They also cover chat method selection and draft requests that must not authorize sending.
- The recordings use synthetic login data. Real Google/X account login, real 2FA, provider OAuth and external recipient delivery remain separate, unverified acceptance cases.
- Local evidence lives under `.local/evidence/sign-in-followup-2026-09-25/`. Raw frames and runtime data remain outside Git.
