# Native browser sign-in checks

Date: 2026-09-25. All changes and checks are local. The normal owner's accounts, browser profiles and chat were not used or reset.

## Problem and change

Some sites reject an automated browser during sign-in. Moving the browser capture into a separate app window keeps the same automated browser and does not resolve that rejection.

**Sign in in browser** pauses the task, drains its tools and closes its automated browser. It opens the same private profile with the exact matching Chrome binary, without automation or debugging flags. **Continue in Sidekick** waits for that process to exit, then resumes automation. Captures, login inspection, credential injection and browser input stay blocked during the handoff. Expiry and cancellation do not resume work.

Both modes use the same cookie storage settings and session restoration. The browser profile remains separate from the normal Chrome profile. Browser cookies use the adapter's local profile storage, not the Vault's encrypted credential store.

## Real browser with synthetic authentication

A disposable HTTPS fixture reproduced the rejection when `navigator.webdriver` was true. Its non-automated login form accepted only synthetic credentials and issued a session-only, HttpOnly cookie. Native computer use entered those credentials in a separate Chrome for Testing 154.0.8037.57 window. No automation client was attached to that window.

| Check                                   | Observed result                                                          |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Initial automated navigation            | Fixture rejected the browser.                                            |
| Native sign-in window                   | Automation check was false; the form accepted the synthetic account.     |
| Continue into automation                | The authenticated page remained accessible with the session-only cookie. |
| Second native handoff                   | The native window was already signed in.                                 |
| Second return to automation             | The authenticated page remained accessible.                              |
| Immediate return after a fresh login    | Normal browser shutdown preserved the newly issued session-only cookie.  |
| Browser service disposal and recreation | Explicit reopen retained the authenticated session.                      |

Live checks found that returning to automation could lose the login. The two modes needed matching `password-store=basic` and `use-mock-keychain` settings, together with session restoration. A later immediate-return check exposed a separate shutdown issue: process termination could discard a recently issued cookie before Chrome saved it. Continue now requests normal browser shutdown and waits for its exit. A timeout leaves the task paused; it cannot force-kill the browser and report a successful handoff. Forced cleanup is limited to paths that do not resume the task. No cookie was exported or supplied directly to the test.

The fixture used an ephemeral certificate trusted only through a certificate-specific test launch argument. Production certificate checks and the public-network guard were not disabled. Its browser profile, local fixture server and certificate were removed after the run.

The shutdown change follows the pinned Chromium implementation: [SIGINT requests normal exit while SIGTERM ends the session](https://github.com/chromium/chromium/blob/154.0.8037.57/chrome/browser/chrome_browser_main_posix.cc#L80-L100), and [normal cookie-store closure commits pending changes](https://github.com/chromium/chromium/blob/154.0.8037.57/net/extras/sqlite/sqlite_persistent_store_backend_base.cc#L233-L241). A retry waits for the original quit request rather than sending SIGINT again.

## Automated checks

The focused tests cover exact browser-version selection, private profiles, process exit, failure cleanup, failed native launch, task cancellation, expiry, stale revisions, restart fences, redacted return URLs and retry after an orphaned native process exits. Trusted DOM fixtures cover browser-security rejection detection. Runtime and Vault checks verify that a recognized rejection does not create another credential request.

- `npm run check`: passed TypeScript, architecture and formatting.
- `npm run test:integration`: 473 passed, zero failures and zero skipped, in 63.901 seconds.
- `npm run build`: passed. The existing client chunk-size warning remains.
- `git diff --check`: passed.

## Limits

This is real browser execution with a synthetic site, not a Google, X or other live-account sign-in. Provider acceptance, passkeys and live 2FA remain unverified. Session restoration does not guarantee preservation of in-memory page state. A native window left running after an app crash must be quit before another process can use that profile. Recognized English rejection messages have fixture coverage; the detection is not an exhaustive provider or language catalogue.
