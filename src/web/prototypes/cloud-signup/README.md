# Cloud signup prototype

Question: which signup and account-management flow makes hosted Sidekick easy to start using while preserving its quiet, chat-centered interface?

**Selected on 2026-09-26: A.** The user requested removing the account-privacy line, explanation of login versus Gmail/Calendar consent, host credit and design-preview label from the login screen. Those removals apply to the login surface; provider permissions are explained at connection time.

This is a disposable, in-memory UI preview on `prototype/cloud-signup`. It is not authentication, an isolation boundary, a running agent, provider consent, webhook processing, or a deployment. All identities and results are synthetic. Do not enter real credentials.

## Run

```sh
npm ci
npm run prototype:cloud
```

Use Node 24.21.0 or newer. Open [http://127.0.0.1:4318/?variant=A](http://127.0.0.1:4318/?variant=A). No database, Docker or service keys are required. The normal app and its routes are unchanged; this has its own Vite entry point and build output. State resets on reload.

## Directions

- **A: Quick start.** Optional app setup after sign-in; profile/settings in an account dialog. Recommended for the smallest change to the existing app.
- **B: Guided setup.** App and preference steps, with a dedicated account/settings page.
- **C: Chat first.** Immediate conversation, optional connection invitation, and an account drawer alongside chat.

Use the floating switcher or `?variant=A`, `B`, or `C`. Arrow keys switch directions outside editable fields and dialogs. The switcher is development-only. **Scenarios** exposes state and failure cases without real side effects.

## Design plan

Preserve Sidekick's existing visual language: Manrope for all text, pink for selected navigation, quiet app rows, ordinary chat and the existing logo. Use the existing semantic light/dark theme tokens rather than a second theme system.

| Role                | Existing light token |
| ------------------- | -------------------- |
| Canvas              | `#fefdfc`            |
| Sidebar             | `#fbf9f5`            |
| Foreground          | `#1b1924`            |
| Muted text          | `#6e697a`            |
| Selected navigation | `#bc3666`            |
| Primary control     | `#ff91ac`            |

The three directions differ in setup sequence and account layout, not only color. The app remains the context for the changes. Login is a separate new surface; the standalone preview avoids running or publicly exposing the single-owner backend.

```text
A: login -> optional apps -> familiar chat | account dialog
B: login -> apps -> preferences -> chat   | full account page
C: login -> chat + optional setup        | side drawer
```

Keep infrastructure/provider details in research/operator configuration, not the signup path. Make permission and actual delivery distinct. Preserve two independent demo identities to review account-switch UX; this is not a server isolation test.

## Review route

1. Continue with Google and choose a synthetic account.
2. Connect or skip Gmail/Calendar and enter the conversation.
3. Try Apps, reconnect/disconnect and the sample-event scenario.
4. Pair the synthetic Telegram bot, confirm identity and simulate a reply.
5. Start the simulated computer, take control and resume.
6. Open the account menu, edit the profile and change appearance.
7. Switch demo users and inspect the separate state; exercise session expiry.
8. Compare the three directions and narrow layouts.

Validation results are recorded in [the prototype verification note](../../../../docs/testing/results/2026-09-26-cloud-prototype.md). The implementation proposal and official sources are in [the cloud rollout plan](../../../../docs/research/cloud-rollout-plan.md).

After design review, implement the selected behavior with the real auth/tenant/provider contracts. Keep prototype code on its review branch; do not merge it as production behavior.
