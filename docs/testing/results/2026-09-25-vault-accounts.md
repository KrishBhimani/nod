# Vault sign-in and named accounts

Date: 2026-09-25. Local checks use separate profiles and disposable database schemas. The normal owner's credentials and chat were not changed.

## Reported failure

The reported X bookmarks request failed navigation and then recommended manual sign-in without inspecting a reachable login form. A navigation error is not evidence that a website rejected the browser for security reasons.

The runtime now inspects the current login page before recommending manual sign-in. Supported fields produce a Vault link. Navigation or inspection errors receive bounded recovery. Manual sign-in remains available for a verified browser-security rejection or an explicit request for manual help.

macOS now starts the isolated task Chrome in headed mode with a start-minimized hint. The existing profile, network guard and secure injection boundary remain in use. Linux remains headless.

## Public X page

These checks use an empty isolated profile and no X credentials.

| Check                                       | Result                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Headless login navigation                   | HTTP 403 in 2.10 seconds.                                                                                       |
| Headed login navigation                     | Reachable username form in 8.70 seconds.                                                                        |
| Headed plus start-minimized                 | Reachable username form in 6.36 seconds; trusted field inspection and screenshot succeeded.                     |
| Real app/model: “get my bookmarks on x.com” | A Vault invitation appeared after 16.918 seconds. Its link opened the secure username form for `https://x.com`. |

The app run used GPT-6 Sol with the actual browser adapter and Vault. No password or username was submitted to X. X authentication and bookmark retrieval are therefore not verified. The minimize flag is a launch hint, not verified focus behavior.

## Named accounts

Saved logins have a user-defined name and exact website origin. A bare domain in the manual form is stored as HTTPS. The broker never treats another scheme, subdomain or port as the same origin. Multiple saved accounts use separate entry IDs. A secure request offers named account choices and preserves the selected account through staged sign-in. New password entry asks for its own name. OTPs are never saved as credentials.

The focused UI fixtures verify named account choices, the selected entry ID, a fresh named login, a rejected saved login, fixed destination, code-only fields, and two same-host entries after reload. PostgreSQL fixtures also cover identifier/password continuity across restart, different owners/origins, deletion, expiry, stale revisions, token reuse and a delayed-key race.

## Real app and synthetic website

Run `e2e_2c590edd84f04383` used GPT-6 Sol, the real browser adapter, the actual Vault pages and a fake HTTPS sign-in site. Its isolated operator timing log is `sidekick-e2e-t6uWet/timings.jsonl` in the system temporary directory.

| Case                               | Result                                                                                                                                                                                            | Timing                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| New login from chat                | Password form showed the fixed website and required a login name. A rejected password produced a fresh token, preserved the name and cleared credentials. Corrected details saved Northstar work. | 12.911 seconds from message receipt to Vault invitation.                                                         |
| Verification and task continuation | A rejected code stayed in Vault. The correct code resumed the original task and returned invoice NS-1042, awaiting review, EUR 240.00.                                                            | 4.597 seconds from accepted code to saved answer; 106.091 seconds total including operator input and inspection. |
| Second account on the same website | The manual form accepted bare `example.com` and saved Northstar personal. Both names remained visible with their domain and separate entries.                                                     | Verified through the real UI and stored metadata.                                                                |
| Choose a saved account             | A fresh conversation preserved both logins. The next sign-in offered both names. Choosing Northstar work submitted its stored password and continued to verification.                             | 13.077 seconds from message receipt to the secure invitation.                                                    |
| Saved-account completion           | Correct verification resumed the task and returned paid invoice NS-1043, EUR 85.00. Vault still contained exactly the two named entries.                                                          | 3.451 seconds from accepted code to answer; 119.112 seconds total including operator input and inspection.       |

The first code retry followed a browser-control timeout while entering the fixture code. The rejection and subsequent recovery were verified, but that entry is not evidence of an application typing failure. Total times include test-operator pauses; they are not model latency measurements.

A bounded scan found zero supplied password/code matches in 10 messages, 44 task events, 36 inspector records, 7 prompt records, 60 provider records, 6 credential request rows, 2 encrypted selection rows and 3 model-session files. Browser cookies and profiles were excluded. This scan does not prove protection against every hostile website or transformed secret.

## Automated validation

- `npm run check`: passed TypeScript, architecture boundaries and formatting.
- `npm run test:integration`: 505 passed, zero failures and zero skipped, in 68.871 seconds.
- `npm run build`: passed; the existing client chunk-size warning remains.
- `git diff --check`: passed.

Real provider authentication, X bookmark retrieval and provider-specific 2FA are not proven by the fake sign-in site. The normal owner's profile and credentials were not used.
