# Replacing a capability

Sidekick has one composition file: `src/server/composition.ts`. It selects adapters and connects them to feature factories. The web client consumes HTTP types; feature modules depend on small capability interfaces. Tests substitute these interfaces without starting vendor services.

## Replacement map

| Replace                              | Implement                                            | Change at composition                                 | State to consider                                                                                    |
| ------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| OpenAI / Anthropic model             | No new adapter for these two                         | `LLM_PROVIDER`, matching key and optional `LLM_MODEL` | Pi transcripts include prior tool results and model messages                                         |
| Pi or another agent harness          | `Agent` in `src/ports/agent.ts`                      | `agent`                                               | Migrate transcripts or start an explicitly fresh segment with history; do not replay external writes |
| Browser engine or remote computer    | `Computer` in `src/ports/computer.ts`                | `computer`                                            | Browser profiles, current page, protected selectors and secret-entry locks                           |
| Local Docker workspace               | `Workspace` in `src/ports/computer.ts`               | `workspace`                                           | Files, sandbox paths, cancellation and published artifact resolution                                 |
| Composio / direct Google APIs        | `IntegrationProvider` in `src/ports/integrations.ts` | `integrations`                                        | Provider-tagged connection/session/event references; users normally reconnect OAuth                  |
| Speech service                       | `SpeechProvider` in `src/ports/speech.ts`            | `speech`                                              | Audio metadata and artifact bytes; no vendor state in the web flow                                   |
| Cheap event model                    | `RelevanceClassifier` in `src/ports/relevance.ts`    | `relevance`                                           | Existing preferences and notification history remain in PostgreSQL                                   |
| Jev browser chooser                  | `BrowserChooser` in `src/ports/computer.ts`          | `chooseBrowserAction`                                 | Only proposes actions against the supplied observation; no direct browser access                     |
| Keychain / cloud key service         | `CredentialKeyStore` in `src/ports/key-store.ts`     | `keyStore`                                            | Preserve the existing key or explicitly re-encrypt stored entries before switching                   |
| Chat SDK / another messaging service | `MessagingTransport` in `src/ports/messaging.ts`     | `messaging`                                           | Inbox/outbox identities, sender binding and uncertain delivery states                                |

These interfaces hide transport and SDK details, not migration costs. A different provider cannot necessarily reuse another provider's OAuth account IDs, transcript format or browser profile. Never treat the presence of a new key as a completed migration.

## Add an adapter

1. Read the port and its focused tests. Put the implementation in `src/providers/<provider>/` and accept keys/configuration as factory arguments.
2. Map vendor data into the port's types. Preserve cancellation, bounded input/output and fixed public errors. Do not expose SDK instances or credentials through the port.
3. Select it in composition. Keep routes, product policy and React components unchanged when behavior is equivalent.
4. Test vendor protocol mapping with synthetic transport fixtures, then run the same feature and application tests with the replacement.
5. Plan existing-data handling and run a bounded live check against a development account. Record what was actually verified.

Google is the initial integration domain. The current feature catalog defines five service IDs and canonical action IDs. A replacement backend maps those IDs and returned tool schemas into its own API. The read allowlist remains product policy; other actions require review. Adding a new service also requires a catalog entry and explicit event/permission policy.

The messaging feature stores verified normalized messages, enforces owner binding and reply windows, then submits durable tasks. A transport verifies original webhook bytes and performs outbound delivery. Adding a public webhook route also requires an explicit exception in `src/server/access.ts`; a generic transport must not broaden HTTP access on its own.

## Replacing a product feature

Feature factories own their routes and persistence. For example, replace `createPersonalService` at composition to change goals or scheduling while preserving its runtime operations and HTTP contract. If the user-visible contract changes, update `src/shared/contracts.ts`, the page and `docs/api-contract.md` together.

PostgreSQL and pg-boss are deliberate infrastructure choices. Moving to another database or durable workflow engine requires data and execution migration. There is no generic repository layer pretending this is a one-line swap. Local artifact storage similarly needs an ownership-preserving migration before an object-store implementation can replace it.

`npm run check` enforces import directions. `application-adapters.test.ts` exercises the full HTTP-to-worker path with replacement agent, computer, workspace, integration, speech and key-store adapters. Provider protocol tests and live checks answer different questions and remain separate.
