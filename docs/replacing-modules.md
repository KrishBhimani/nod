# Replacing a capability

`src/server/composition.ts` selects adapters and binds feature factories. The web client consumes HTTP types; server features and the runtime depend on capability interfaces. Replacement tests can use the same routes and durable workers without vendor services.

## Replacement map

| Replace                   | Interface                                                 | Composition field                                  | State to preserve or migrate                                                   |
| ------------------------- | --------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| OpenAI / Anthropic model  | Existing Pi adapter supports both                         | `LLM_PROVIDER`, matching key, optional `LLM_MODEL` | Prior messages and tool results in transcripts                                 |
| Pi / agent harness        | `Agent` in `src/ports/agent.ts`                           | `agent`                                            | Transcript format, tool IDs, waiting segments, cancellation                    |
| Browser / remote computer | `Computer` in `src/ports/computer.ts`                     | `computer`                                         | Profiles, pending form inspection, protected fields, screenshot state, locks   |
| Linux workspace           | `Workspace` in `src/ports/computer.ts`                    | `workspace`                                        | Task paths, installed tools, artifacts, quotas, egress, cancellation           |
| Composio / Google backend | `IntegrationProvider` in `src/ports/integrations.ts`      | `integrations`                                     | Provider-tagged accounts, consent attempts, sessions, subscriptions, approvals |
| Speech                    | `SpeechProvider` in `src/ports/speech.ts`                 | `speech`                                           | Audio metadata and artifact bytes                                              |
| Event/goal classifier     | `RelevanceClassifier` in `src/ports/relevance.ts`         | `relevance`                                        | Preferences, decisions, feedback, pending dispatch                             |
| Jev browser chooser       | `BrowserChooser` in `src/ports/computer.ts`               | `chooseBrowserAction`                              | No direct browser state; chooses from an observation                           |
| Keychain / key service    | `CredentialKeyStore` in `src/ports/key-store.ts`          | `keyStore`                                         | Vault and channel-settings key/ciphertext compatibility                        |
| Messaging transport       | `MessagingTransport` in `src/ports/messaging.ts`          | `messaging` or `messagingSetup.create`             | Account/sender identity, inbox/outbox, polling offsets, uncertain delivery     |
| Channel account setup     | `ChannelSetupVerifier` in `src/ports/channel-settings.ts` | `messagingSetup.verifier`                          | Encrypted settings, public summaries, provider registration state              |

These interfaces hide SDK and transport details, not migration costs. A new provider key does not migrate OAuth account IDs, browser profiles, or transcript formats. The setup verifier currently covers Telegram/WhatsApp and returns a validated server-only configuration map; another channel requires an explicit setup schema and policy.

## Add an adapter

1. Read the applicable port and focused tests. Put the implementation under `src/providers/<provider>/`; accept configuration and keys as factory arguments.
2. Map vendor data to the port. Preserve cancellation, bounded output, and fixed public errors. Do not return SDK objects, credentials, or unrestricted execution handles.
3. Select it in composition. Keep product policy, routes, and UI unchanged when behavior is equivalent.
4. Run feature tests with an injected fake and protocol tests with synthetic vendor responses. Then exercise the HTTP-to-worker replacement fixture.
5. Plan existing-data handling and perform only authorized, bounded live checks. Record unresolved vendor behavior.

The key store returns key bytes only to the trusted vault and channel-settings services. Keep the same key when replacing its source, or re-encrypt both datasets deliberately. Envelope encryption, key rotation, and cross-host recovery are not implemented by the port alone.

## Keep policy outside providers

The integration feature owns the five Google service IDs, read allowlist, account selection, approvals, and watch intent. The adapter implements consent, verified account identity, scoped execution, subscriptions, and signed event normalization. It must honor the explicit provider account supplied for each action.

Disconnect/revoke connections under the old provider before switching integration backends. Existing references remain provider-tagged; the replacement must not reuse them. Pending approvals keep their local account binding and must fail when that account is unavailable. OAuth consent normally needs repeating with the replacement provider. Encrypted vault/channel records are independent and must remain intact.

The channel feature owns sender access, durable inbox/outbox, reply windows, and task routing. A transport verifies original webhook bytes, normalizes messages, optionally polls, and sends replies. Polling must await inbox acceptance before acknowledging an update. Replacement drains active delivery, then applies the new account/sender binding. Adding public ingress also requires a narrow exception in `src/server/access.ts`; an adapter cannot broaden HTTP access itself.

Saved channel setup is decrypted only for the trusted transport factory. Metadata endpoints must not expose its configuration map. A failed provider verification leaves current local settings active; a remote webhook mutation and database commit cannot be made atomic by this interface.

The classifier chooses relevance, but the feature keeps quiet hours, quotas, source identity, and dispatch deduplication. Browser adapters preserve exact-origin credential checks, observation locks, public-web restrictions, and non-navigating screenshot recovery. Workspace replacements preserve the separation from the host, provider environment, and authenticated browser.

## Replace a feature or storage layer

Feature factories own routes and persistence. For example, replacing `createPersonalService` changes personal context and scheduling while its HTTP/runtime contracts stay explicit. A visible contract change also requires `src/shared/contracts.ts`, the affected page, and [API contract](api-contract.md) to change together.

PostgreSQL, pg-boss, and local artifact storage are deliberate infrastructure choices. Replacing them requires a data and execution migration; there is no generic repository layer pretending otherwise. Multiple replicas also need ownership/lease changes beyond swapping an adapter.

`npm run check` enforces import directions. `application-adapters.test.ts` covers replacement agent, computer, workspace, integration, speech, and key services through HTTP and workers. `channel-application.test.ts` covers setup/transport replacement and channel continuation. Provider protocol fixtures and live checks answer different questions.
