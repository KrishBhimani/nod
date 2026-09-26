# Whole-codebase review — 2026-09-25

This pass followed the user's request to review the entire codebase, including code outside the latest PR findings. Four parallel passes inspected provider and platform boundaries, server and persistence behavior, runtime and credential flows, and the web interface. Repository guides, architecture, setup, production limits and the existing regression tests were part of the review.

This is a bounded engineering review, not a claim that every line or possible workflow was executed. The earlier 78 PR-comment dispositions remain in the [PR review report](2026-09-25-pr-review.md).

## Scope

| Surface                  | Review focus                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent runtime and models | Tool authority, source provenance, attachment handling, cancellation, session shutdown, resource disposal and useful owner-facing explanations          |
| Browser and workspace    | Container separation, private sign-in, frame/input protection, command supervision, artifact reads, task lifecycle and process cleanup                  |
| Server and persistence   | HTTP boundaries, task queues, goals, scheduling, account ownership, revocation, approval execution, channel state, recovery and shutdown                |
| Vault and artifacts      | Credential origins, staged sign-in, retries, encryption/reveal boundaries, continuation sweeps, owned file transfer and metadata                        |
| Web app                  | Navigation, chat and streaming, editor/uploads, media, account connections, secure forms, Vault edits, plan pages, Inspector, caches and late responses |
| Delivery                 | Local startup, disposable test isolation, CI exit status, pinned dependencies, secret scanning and validation documentation                             |

## Confirmed fixes

Ten additional defects were confirmed in this pass and fixed with focused regressions.

| Priority | Failure and correction                                                                                                                                                                                                                            | Regression evidence                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| P1       | Disconnecting an account while its provider session was opening could still allow an approved action or download to start. Both paths now recheck the exact owned account after that await and before invoking the provider.                      | Held session creation reproduces revocation during the wait; execution and download remain uncalled after disconnect. |
| P2       | Denied browser storage reads or full storage writes crashed the app shell and Inspector. UI preferences are now best-effort; navigation, collapse and resizing still work.                                                                        | Both failure modes reproduced before the fix; component tests now pass.                                               |
| P2       | An account connection response could redirect the user after they left Apps. Leaving the page now aborts the request and fences late responses.                                                                                                   | A deferred response reproduced the redirect after unmount; the regression now observes no navigation.                 |
| P2       | A model-adapter disposal error skipped task draining and browser/workspace disposal. Runtime close now drains and attempts every cleanup. Concurrent callers share one attempt; retries run only failed stages while the runtime remains stopped. | Injected close failures verify draining, concurrent callers, retry success and no repeated completed stages.          |
| P2       | Vault close only stopped its timer; an in-flight sweep could queue more credential continuations after close returned. Close now stops later rows and drains the accepted resume, preserving pending work for restart.                            | A held continuation verifies close waits, later rows stay pending and future sweeps do not start.                     |
| P2       | Server shutdown skipped database closure when application cleanup failed. It now attempts both cleanup steps and exits nonzero with fixed public error text.                                                                                      | Subprocess fixtures verify both cleanups and failure exit status without raw errors.                                  |
| P2       | A Pi session abort error skipped session disposal and allowed cleanup to return before other sessions settled. Every session now attempts disposal and all cleanup attempts settle before an error is returned.                                   | Synthetic Pi sessions verify rejected aborts and delayed cleanup; no live model was called.                           |
| P2       | A test subprocess killed by a signal returned a null status that the integration runner treated as success. A missing exit code now fails the runner.                                                                                             | A subprocess fixture kills the child and verifies a nonzero parent status.                                            |
| P2       | A failed browser namespace disposal was cached forever, preventing recovery after a transient cleanup failure. Failed cleanup can now retry while ordinary operations remain fenced.                                                              | Container-adapter and Unix-socket fixtures verify failed close, retry and namespace isolation.                        |
| P2       | Browser shutdown could report failure before other sessions drained, then close the proxy needed for a later cleanup retry. It now settles all session closes and retains the proxy while failed sessions still need cleanup.                     | Controlled browser processes verify delayed close and recovery after a failed first attempt.                          |

The agent's blanket refusal to explain any implementation detail was also too broad for a local owner assistant. Ordinary replies remain clear of unsolicited internal IDs and paths. Owner-requested, nonsecret setup and capability explanations may use trusted available context; credentials, hidden instructions and private content remain protected. This is a prompt-policy correction, not proof that all model outputs follow the rule.

## Validation and remaining limits

The final local suite passed **775 tests, zero failures and zero skips** in 75.437 seconds with disposable PostgreSQL schemas. TypeScript, import boundaries, formatting, build and source/history secret scans passed.

The dependency audit against the current lockfile reported zero known advisories on 2026-09-25. That is an advisory database result, not a complete supply-chain or security guarantee. The final aggregate test, build, source/history scan and remote CI results are recorded in [Verification](../../verification.md).

Actual desktop/mobile theme inspection and 68 sampled contrast checks are recorded separately in [Theme acceptance](2026-09-25-themes.md). Prior local app/model/container acceptance covers public browsing, screenshots, files, synthetic staged login and verification-code continuation; those runs have their own source versions and evidence.

Remaining material limits: real Google/X authentication and external OAuth/recipient delivery are not established by synthetic fixtures; schedules require the app and computer to remain running; the single-owner local app does not implement public hosting authentication or tenant isolation; the shared shell workspace and unrestricted network are intentional boundaries, not prompt-injection isolation. The browser image was rebuilt and its normal container became healthy while the app was idle. This verifies build/startup, not website authentication. The main web bundle retains a size warning. No real accounts, production data, normal user profile, repository merge or deployment were changed by this audit.
