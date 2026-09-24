# Provider adapters

Implement the smallest applicable interface in `../ports`. Factories accept credentials and configuration explicitly. `../server/composition.ts` chooses implementations. Provider SDKs, protocols, transport parsing and vendor defaults stay here.

| Provider                  | Capability                                                               |
| ------------------------- | ------------------------------------------------------------------------ |
| `pi`                      | OpenAI/Anthropic agent sessions and persisted transcripts                |
| `agent-browser`           | Browser actions, public-web proxy, observations and credential injection |
| `docker`                  | Offline workspace execution and files                                    |
| `composio`                | Google authorization, tools and signed event normalization               |
| `chat-sdk`                | Telegram/WhatsApp webhook protocols and message transport                |
| `openai`                  | Speech and cheap event classification                                    |
| `jev`                     | Optional browser chooser and relevance classifier                        |
| `keychain`, `environment` | Vault encryption key source                                              |

Adapters must not import feature modules or runtime implementations. Normalize errors and output shapes. Never expose keys, OAuth tokens, raw SDK sessions or plaintext vault contents to the runtime, model or web client. The key-store port returns key bytes only to the trusted vault service. SDK state that must persist needs an explicit reference and migration policy.

Before swapping an adapter, follow [replacing modules](../../docs/replacing-modules.md). Test its protocol mapping separately from product behavior. Browser work must retain exact-origin credential checks, observation locks, bounded output, private-address denial and cleanup. Workspace subprocesses must not inherit provider keys. Review [security](../../docs/security.md).
