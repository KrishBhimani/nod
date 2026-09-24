# Provider adapters

Implement the smallest applicable interface in `../ports`. Factories accept credentials and configuration explicitly. `../server/composition.ts` chooses implementations. Provider SDKs, protocols, transport parsing and vendor defaults stay here.

| Provider                  | Capability                                                               |
| ------------------------- | ------------------------------------------------------------------------ |
| `pi`                      | OpenAI/Anthropic agent sessions and persisted transcripts                |
| `agent-browser`           | Browser actions, public-web proxy, observations and credential injection |
| `docker`                  | Workspace execution, files and guarded public Internet                   |
| `composio`                | Google authorization, tools and signed event normalization               |
| `chat-sdk`                | Telegram/WhatsApp webhook protocols and message transport                |
| `openai`                  | Speech and cheap event classification                                    |
| `jev`                     | Optional browser chooser and relevance classifier                        |
| `keychain`, `environment` | Vault encryption key source                                              |

Adapters must not import feature modules or runtime implementations. Normalize errors and output shapes. Never expose keys, OAuth tokens, raw SDK sessions or plaintext vault contents to the runtime, model or web client. The key-store port returns key bytes only to trusted vault and channel-settings services. SDK state that must persist needs an explicit reference and migration policy.

Before swapping an adapter, follow [replacing modules](../../docs/replacing-modules.md). Test its protocol mapping separately from product behavior. Browser work must retain exact-origin credential checks, observation locks, bounded output, private-address denial and cleanup. Workspace subprocesses must not inherit provider keys. Review [security](../../docs/security.md).

`agent-browser/login.ts` owns trusted login inspection and method selection scripts. `credentials.ts` owns typed secure entry. Support identifier, password and one-time-code stages using observed fields; never request those values through the model. Method selection must recheck the origin and current control. Passkeys, separate windows, split-digit codes and remote manual control remain unsupported. `hold` retains a waiting browser only to its bounded expiry.

`agent-browser/screens.ts` stores masked screenshots and bounded metadata in private files. The optional `screenStatus` describes the preceding `screenshot` result as live, last-known or unavailable. Inspector recovery must not navigate, launch a browser or replay credentials. The socket recovery path is bound to agent-browser 0.38.1's protocol; keep its mapping tests when changing that dependency. A restarted credential-bearing session uses its cached image until an explicit reopen because secret redaction values stay in memory only.

Run the focused browser/vault checks with `npx tsx --test tests/browser-login.test.ts tests/browser-recovery.test.ts tests/runtime-credentials.test.ts tests/runtime-adapters.test.ts tests/vault-staged.test.ts tests/vault.test.ts`. The vault tests require `TEST_DATABASE_URL` for a disposable schema. The staged DOM fixtures and synthetic Chrome pages do not prove a live provider login works.
