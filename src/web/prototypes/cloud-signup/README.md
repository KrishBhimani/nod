# Cloud signup prototype

Question: which signup and account-management flow makes hosted Sidekick easy to start using while preserving its quiet, chat-centered interface?

**Selected on 2026-09-26: A.** Keep ordinary screens concise. The login has no privacy reassurance, login-versus-app-access explanation, host credit or preview label. Connection screens use account identity and actionable states; provider consent contains the permissions review. Event-processing details stay in developer diagnostics.

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

The computer provider is selected when the server starts, through composition. Ordinary users see the assistant, not a Computer page, desktop stream or provider picker. A developer preview can expose simulated computer diagnostics; its client-side flag is not authorization. Production must authorize these routes server-side. A necessary private credential request is a scoped form, not general browser access.

The sidebar account control uses a portrait, name and email, with an initials fallback. Profile, Appearance and Preferences belong in a simple account dialog. Production will use the verified Google picture claim through normalized, bounded safe image handling; the prototype uses synthetic local portraits and does not exercise Google claims or remote avatar loading.

Desktop navigation remains vertically centered with subtle hover animation and a visible collapse/expand control. On mobile, prioritize chat and a menu for navigation and settings. Preserve two independent demo identities to review account-switch UX; this is not a server isolation test.

Onboarding offers Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, Slack and Notion on one optional screen. The simulated consent flow returns to that screen with current connection status and preserves the other apps. Production must bind each return to its owned attempt and allowlisted app destination, handling cancellation, expiry and failure without arbitrary redirects. Subscription receipt and processing are independently tracked backend states; ordinary rows do not expose watch configuration or diagnostic timestamps.

## Review route

1. Continue with Google and choose a synthetic account.
2. Connect any of the seven apps, return to the same setup screen with updated status, then continue or skip.
3. Try Apps, reconnect/disconnect, and cancelled or failed consent without losing the setup screen.
4. Pair the synthetic Telegram bot, confirm identity and simulate a reply.
5. Open the avatar account control, edit the profile and change appearance.
6. Collapse and expand the desktop sidebar; review navigation hover states.
7. On a narrow screen, open the menu from chat and reach profile/settings.
8. Switch demo users and inspect the separate state; exercise session expiry.
9. Separately review the developer-only computer simulation and event diagnostics. Their visibility is a prototype affordance, not an authorization test.

Validation results are recorded in [the prototype verification note](../../../../docs/testing/results/2026-09-26-cloud-prototype.md). The implementation proposal and official sources are in [the cloud rollout plan](../../../../docs/research/cloud-rollout-plan.md).

After design review, implement the selected behavior with the real auth/tenant/provider contracts. Keep prototype code on its review branch; do not merge it as production behavior.
