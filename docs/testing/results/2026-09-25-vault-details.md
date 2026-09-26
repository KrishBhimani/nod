# Saved Vault details validation

Date: 2026-09-25. These checks cover the saved credential details view, not a new website authentication flow.

## Result

Opening a saved login shows its name, exact website origin and full username. Passwords start hidden and use a separate request after Show or Copy. Copy does not expose a hidden password. The list remains masked, and details stay outside the shared page cache and agent tools.

## Automated checks

- `npm run check` passed: TypeScript, architecture boundaries and formatting.
- `npm run test:integration` passed all 548 tests with no skips in 65.5 seconds.
- `npm run build` passed. Vite retains its existing bundle-size warning.
- New service checks cover owned reads, malformed IDs and bodies, cross-site requests, encryption binding, unavailable keys, restart and ownership changes during key access.
- UI checks cover explicit reads, masked copying, clipboard failures, close and navigation cancellation, account changes, blur and tab hiding, stale responses, retries and focus return.
- Two independent code reviews found no actionable issues.

## Rendered browser checks

The actual app ran on port 4320 with disposable PostgreSQL schemas and a separate workspace container. Two fake accounts were created through Add login for the same website, with different names, usernames and passwords. No normal-owner credentials were opened.

| Flow                                  | Observed result                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| Open each saved account               | Correct name, full username and exact scheme, host and port                                 |
| Open without Show or Copy             | Network observation contained only the details POST; no password request                    |
| Show, Hide and show the other account | Correct password for each account; hidden value absent from the rendered DOM                |
| Copy username and hidden password     | Browser clipboard calls succeeded and displayed confirmation; hidden password stayed masked |
| Enter and Escape                      | Keyboard opened the details; Escape closed them and restored row focus                      |
| Reload and reopen                     | Both saved accounts persisted; password started hidden again                                |
| Offline details read                  | Fixed error and Try again; restoring the connection and retrying loaded the account         |
| Offline password read                 | Fixed error and hidden password; the next Show succeeded after recovery                     |
| 390px viewport                        | 358px dialog, no horizontal page or dialog overflow, all controls visible                   |

Clipboard contents were not read back from the operating system. The automated clipboard test checks the exact supplied value; the rendered check confirms the real write resolves and the UI state is correct.

Masked screenshots are in `.local/evidence/vault-details/desktop.png` and `.local/evidence/vault-details/narrow.png`. They contain only fake account data and are excluded from Git. Browser network and viewport overrides were removed. The test tab, container and both schemas were removed. The normal app remained healthy.
