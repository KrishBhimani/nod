# Provider boundary review fixes

Date: 2026-09-25. Runtime: Node 24.21.0. This report covers the provider and infrastructure findings from the PR 1 review of `a0a9c8e` and the subsequent focused fixes. It does not replace full application acceptance.

## Changed behavior

| Boundary             | Fix and regression coverage                                                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace Stop       | A fixed supervisor runs inside the workspace container. Abort, timeout and output overflow stop the command process group, drain its streams and return a terminal acknowledgement. Missing acknowledgement fences the adapter. Tests include a child that ignores TERM and a lost connection. |
| Artifact reads       | Descriptor-relative reads inside the container reject symlinks, traversal, nonregular files and oversized content. Only accepted bounded bytes cross to the server. Runtime image attachments use the same capability. There is no host path fallback.                                         |
| Login scope          | A focused candidate-containing form takes precedence over unrelated recognized fields. Fresh entry and submit checks reject new-window, named and inherited target contexts.                                                                                                                   |
| Manual input         | Accessible focused iframe fields receive the same field and reflected-text masking as the main document. Inaccessible frames require the separate native sign-in view. Frame traversal is bounded; unreadable frames are hidden when protected values exist.                                   |
| Browser lifecycle    | Host disposal cancels and drains pending bridges before disposing the namespace. Polling responses cannot overwrite accepted action activity. Socket text uses streaming UTF-8 decoding.                                                                                                       |
| Telegram polling     | A failed offset-table initialization can retry on the next poll.                                                                                                                                                                                                                               |
| Local database setup | Ordinary local query options survive generated-password replacement. A query override to another endpoint is not silently changed to the local database.                                                                                                                                       |
| Key storage          | Concurrent first reads share one initialization. Duplicate creation by another process rereads the stored key. Failed reads remain retryable.                                                                                                                                                  |
| Link-preview images  | Static PNG, JPEG and WebP remain supported. Animated PNG chunks, malformed PNG boundaries and unsupported GIF advertisement are rejected or removed. Sensitive approval, consent and reset URLs remain ineligible.                                                                             |
| Architecture guard   | Static template-string imports receive the same boundary checks as quoted imports.                                                                                                                                                                                                             |

## Isolated Docker proof

At `2026-09-25T22:09:09.865Z`, the actual Docker workspace adapter ran against a temporary container with no network, a read-only root filesystem, dropped capabilities and only a disposable workspace mount. No normal workspace or browser container was restarted.

- A command with a TERM-resistant child was cancelled in 2,078 ms.
- Cancellation returned after the process group stopped. Its delayed file write did not occur.
- A subsequent command completed successfully.
- A bounded binary artifact read returned the expected bytes.
- An artifact symlink was rejected.
- The temporary container was removed after the check.

The proof used synthetic files and commands. Raw local evidence is `/tmp/sidekick-workspace-stop-proof.log`; it is not a shipped application artifact.

The follow-up review confirmed duplicate database routing parameters, pending-command cancellation and normal parent exit with a surviving child. New regressions reproduced all three before the fixes. Every routing value is now validated before inserting the generated local password, and uncertain workspace failure cancels and drains other pending commands. The strengthened traversal test proves that rejection occurs before launch. The focused follow-up set passed all 29 checks, and TypeScript passed.

At `2026-09-25T22:37:10.889Z`, another isolated, network-disabled Docker container confirmed that a normally exited shell waits for its remaining child. A TERM-resistant child hit the one-second deadline, was fully drained in 3,221 ms, produced no delayed write and allowed a subsequent command. This temporary container and its workspace were removed. Raw local evidence is `/tmp/sidekick-workspace-child-proof.log`.

## Scope and limits

The subsequent whole-provider pass reviewed the browser and container bridges, shell supervisor and artifact reads, Pi sessions and routing, integration downloads, channel adapters, speech and relevance adapters, key stores, public previews, local startup/database scripts, fixture launchers, Docker images/Compose and CI configuration. This was a bounded source audit, not exhaustive state-space or live-provider testing.

Four additional cleanup and validation defects were fixed: Pi now disposes sessions even when abort fails and waits for all sessions; browser shutdown drains all sessions before reporting a failed close and retains the proxy required for cleanup retry; container cleanup can retry a failure while keeping its namespace unavailable; and the integration runner reports signal termination as failure instead of exit code zero. The focused set passed 26 tests using real Pi sessions without model requests, private Unix sockets, fake browser processes and an isolated signal-killed test runner.

The cancellation contract covers the supervised command process group. It is not a new per-task sandbox or a guarantee against a deliberately detached process creating another session. Sidekick retains its documented shared single-owner shell workspace. A missing terminal acknowledgement produces an unavailable state instead of claiming a successful stop.

Provider tests use synthetic accounts, temporary directories, Unix sockets, fake transports and a fake key-store process. No live Telegram message, real Keychain entry, real login, OAuth flow or provider billing was exercised. The Docker proof establishes local command and artifact behavior only. Full-suite and build results belong to the final aggregate verification report.
