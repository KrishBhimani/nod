# Workspace browser compatibility checks

Date: 2026-09-25. These checks used new isolated profiles, public websites and a disposable browser container. No credentials were submitted and no normal browser profile was changed.

The normal X task failed before login inspection. A new profile reproduced `net::ERR_HTTP_RESPONSE_CODE_FAILURE` when opening `https://x.com/i/flow/login`. Ordinary HTTPS requests from the same container succeeded, ruling out a general internet or DNS outage.

| Browser configuration                                             | Observed result                                    |
| ----------------------------------------------------------------- | -------------------------------------------------- |
| Existing headless Chromium through the normal local proxy         | Navigation failed in 1.2 seconds.                  |
| Headless Chromium with the proxy removed                          | Chromium's error page reported HTTP 403.           |
| Headed Chromium on private Xvfb, with the original proxy retained | HTTP 200 and successful navigation in 3.7 seconds. |

The headed comparison retained the standard automation connection and browser defaults. It did not change the user agent, suppress automation indicators or bypass a website challenge.

The container factory now selects headed mode. The browser adapter creates a private display for each task, passes its display and authentication environment to the native CLI and closes it after confirmed browser closure. Native sign-in closes the automated display before opening its own; continuation creates a fresh automated display.

A disposable container using the new source and the normal image's isolation settings reached X in 4.9 seconds, produced a private native frame, returned through Continue and then read the expected Example Domains heading from IANA. Chromium and Xvfb were absent after disposal; the namespace daemon remained in the immediate process sample, and the disposable container was removed. The run used a writable private `/home/node`, as required by the normal Compose service. An initial diagnostic missing that mount failed to start the CLI and was discarded as an invalid environment comparison.

The local replay script is `.local/evidence/workspace-browser-headed-check.mjs`; the successful output is `/tmp/sidekick-headed-live.log`. It runs the real adapter inside a disposable `sidekick-local-browser` container with the current `src` mounted read-only, normal Docker networking, no published port, dropped capabilities, a read-only root and private writable runtime locations.

The focused Node.js 24.21.0 run passed 62 browser, native-handoff, transport, capacity and URL-redaction checks. New tests first failed without the launch change and then covered private display separation, reuse, native continuation, failed close and interrupted-launch cleanup. A separate failing URL-redaction test verified that common API and signed-URL credential parameters are now masked while ordinary navigation parameters remain visible.

This establishes X navigation, not X account authentication. The first immediate login inspection returned no fields; it did not prove that the sign-in form had finished rendering. Google may still reject automated sign-in: its [supported-browser guidance](https://support.google.com/accounts/answer/7675428) explicitly includes browsers controlled by software. A verified Google rejection requires the separate human sign-in handoff. Headed rendering does not remove that restriction.
