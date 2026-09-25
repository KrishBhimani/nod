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

## Scope and limits

The cancellation contract covers the supervised command process group. It is not a new per-task sandbox or a guarantee against a deliberately detached process creating another session. Sidekick retains its documented shared single-owner shell workspace. A missing terminal acknowledgement produces an unavailable state instead of claiming a successful stop.

Provider tests use synthetic accounts, temporary directories, Unix sockets, fake transports and a fake key-store process. No live Telegram message, real Keychain entry, real login, OAuth flow or provider billing was exercised. The Docker proof establishes local command and artifact behavior only. Full-suite and build results belong to the final aggregate verification report.
