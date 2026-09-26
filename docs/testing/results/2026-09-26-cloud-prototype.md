# Cloud signup research and prototype verification

Date: 2026-09-26. Branch: `prototype/cloud-signup`. Starting application revision: `1a471a0`.

## Scope and decision

Research and a standalone Vite UI prototype only. The user selected **A — Quick start** and requested removing four login-screen lines: the private-account reassurance, explanation of sign-in versus Gmail/Calendar consent, hosting credit, and design-preview label. These were removed and their absence checked in the rendered page.

During the initial research/prototype pass, no provider accounts or infrastructure were configured. The later account-preparation pass is recorded below. No production authentication, tenant isolation, live integration OAuth, webhooks, Telegram messages, remote computers, migrations, or deployments have been validated. This is not proof of the security or provider behavior described in the UI.

## Automated checks

- `npm run check`: TypeScript, architecture boundaries and repository formatting passed.
- `npm run build`: current application build passed. Existing dependency annotation and large-chunk warnings remained.
- `npx vite build --config src/web/prototypes/cloud-signup/vite.config.ts`: independent prototype build passed.
- Prototype imports the existing logo and semantic theme without changing application routes or provider/runtime code.

The shell default was Node 22.22.3, below the repository requirement. Checks and the preview were run with the already installed Node 26.7.0. No global runtime or dependency versions were changed. Dependency installation used the existing lockfile; no provider credentials were required.

## Browser exercise

The local preview was exercised with synthetic Alex and Sam identities:

| Flow                    | Observed result                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in and onboarding  | Demo account selection, optional app connection and skip path lead to chat                                                            |
| Sidebar account         | Profile and Settings open the selected direction's account dialog                                                                     |
| Profile                 | Editing and saving the name updates the sidebar within the preview                                                                    |
| Appearance              | Dark and light change the page; the selected control reflects the choice                                                              |
| Multiple Gmail accounts | Two fictional accounts appear independently, with separate disconnect controls                                                        |
| Event states            | Connection starts pending; setup advances to enabled with no events; sample Gmail delivery creates a matching chat update             |
| Telegram                | Demo token, one-time link, observed identity, explicit confirmation, and simulated reply confirmation reach the terminal success view |
| Computer                | Start, take control and resume expose distinct states                                                                                 |
| User switching          | Alex's unsent draft, connected apps, conversation and computer status do not appear in Sam's view                                     |
| Session expiry          | Returns to sign-in with a recovery message                                                                                            |
| Responsive layout       | Chat inspected at 390×844 with no document-level horizontal overflow; account controls remain reachable through mobile navigation     |

Keyboard activation was used where browser automation pointer targeting became inconsistent after viewport changes. Visual state was re-read between dependent actions. These are interactive preview checks, not a persistent automated end-to-end suite.

Inspection also found a React hot-reload warning from recreating a root after prototype edits. The preview now unmounts its root during Vite module disposal; a fresh reload clears old roots and resets the synthetic state. Reset/sign-out also clears the simulated authentication error.

Desktop login, dark appearance, app connection and Telegram terminal states were visually inspected. Local screenshots are under the ignored `.local/cloud-prototype/` directory, containing only synthetic content. The selected preview remains available at [localhost:4318](http://127.0.0.1:4318/?variant=A).

## Research review

Three independent research strands used official documentation and current source references. A second pass clarified cross-process owner-scoped events, durable worker wake-up/reconciliation, provisional computer-provider selection, aggregate pair-hour costs and separate project billing. The final [rollout proposal](../../research/cloud-rollout-plan.md) distinguishes known implementation gaps, documented provider capabilities, design choices and live verification still required.

The future local-live, staging and production acceptance suites are specified in the research reports. Existing backend integration fixtures were not rerun during the initial research pass; no backend behavior changed.

## Selected A refinement

The follow-up design keeps Computer behind the prototype's developer scenario and removes user provider selection. The rollout documents require server-authorized developer access and provider selection in startup configuration. Account settings now contain Profile, Appearance and Preferences; ordinary chat, Apps and onboarding omit routine privacy and event-processing explanations. The avatar component consumes the account picture field, with local fictional portraits standing in for Google's profile image until authentication is implemented.

Browser checks on the revised prototype confirmed:

- All seven supported integration cards appear on onboarding. Connecting Gmail returns to the same screen with its account and Connected status. Cancelling Google Docs consent keeps that screen and the existing Gmail connection.
- Desktop navigation stays vertically centered, and both collapse and expand remain available. CSS review confirmed icon hover transitions and a reduced-motion override.
- Editing and saving a name updates account identity. Appearance changes the rendered theme and selected control.
- At 390×844, chat uses a compact menu control. The menu shows the avatar, account and Settings; Settings opens directly and closes the menu. Chat, menu and settings had no document-level horizontal overflow. Review caught and fixed a missing column direction in the mobile menu.
- Computer is absent for ordinary users. The developer scenario reveals it with a read-only provider label; disabling that scenario returns to chat and removes Computer.

`npm run check`, `npm run build` and the independent prototype build passed again under Node 26.7.0. Existing application dependency-annotation and bundle-size warnings remain. `npm run test:integration` was attempted but stopped before running fixtures because this checkout has no configured local or explicit test database. No database was provisioned for the UI refinement. These checks do not establish live Google OAuth, account isolation, provider connections or production readiness.

The updated desktop screenshots are saved locally as `.local/cloud-prototype/refined-chat.png` and `.local/cloud-prototype/refined-settings.png`; they contain only synthetic data.

## Compact onboarding and account shortcuts

The next refinement replaces onboarding account rows with seven equal-height app buttons. Connected apps have a distinct fill, check and Connected state; onboarding contains no account identity, add-account or disconnect controls. Connect and Reconnect now simulate the direct provider round trip with an inline pending state and no Sidekick permissions modal. The existing production Apps page is unchanged. The sidebar no longer shows a connected-app count.

Browser verification covered direct connection and reconnection returning to the same onboarding screen, Light/Dark/System controls in the desktop account dropdown and mobile menu, and Cmd+, opening Settings. Closing Settings restores the account trigger when opened from the dropdown, or the composer and its unchanged draft when opened there. A review found and fixed focus return to an unmounted dropdown button. At 390×844, all seven onboarding cards measure 68px high and fit without horizontal overflow; mobile quick theme controls remain inside the menu.

`npm run check` and the independent prototype build passed. The earlier database prerequisite limitation still applies; no backend or live OAuth behavior changed or was validated. The final compact onboarding screenshot is `.local/cloud-prototype/compact-onboarding.png`.

## Settings, style parity and overnight-work sign-in

The next refinement retains the existing application's sidebar dimensions, icon treatment and hover behavior. The sign-in card now illustrates a supplier comparison and drafted follow-ups ready in the morning. Settings use a compact panel, existing underline tabs, one profile editor and one email row, chat-shaped theme previews, and aligned preference controls. Save and Cancel appear only for an edited name.

Browser verification covered profile edit/cancel/save, visible account-name updates, dark/light switching, Cmd+, opening Settings from the composer, and focus returning to the unchanged draft after close. Settings tabs support arrow navigation. Review caught a conflict with the prototype variant switcher; the global handler now respects already-handled key events. The B variant remained B when navigating from Profile to Appearance with ArrowRight.

At 320×740, Profile initially clipped its input inside the panel despite no document-level overflow. The grid now allows its column and input to shrink. Profile (including Save/Cancel), Appearance and Preferences were rechecked with no overflowing descendants inside the dialog. The viewport override was reset after testing. Temporary native-browser DevTools were closed.

`npm run check` and the independent prototype build passed under Node 26.7.0. This pass changes only prototype UI and documentation. The earlier backend integration prerequisite limitation remains; the newly created hosted database has not been used as a test database. Product screenshots are saved locally as `.local/cloud-prototype/settings-final.png`, `.local/cloud-prototype/settings-mobile-320.png` and `.local/cloud-prototype/overnight-signin.png`.

## Vertical settings refinement

The follow-up settings review replaced horizontal tabs with a vertical rail. Desktop uses labeled navigation and an independently scrolling content pane; mobile uses accessible icons and stacked theme previews. Appearance selection now uses border/background only, with no checkbox or checkmark indicators. Browser checks confirmed ArrowDown navigation and all three sections at 320×740 without overflowing descendants. Dark/Light updates the theme state and selected preview; the desktop viewport was restored afterward. Screenshots: `.local/cloud-prototype/vertical-settings-appearance.png` and `.local/cloud-prototype/vertical-settings-mobile.png`.

## Provider account preparation

Live browser access was established for all four consoles. Cloudflare access to the requested account was verified after the user completed two-factor sign-in. E2B email verification completed and its dashboard showed zero sandboxes. A free Neon `sidekick` project/database was created in AWS Frankfurt on PostgreSQL 17, matching local Compose; its production branch dashboard confirmed those settings. An empty Composio `sidekick_production` project was created alongside the existing development project.

No paid plans, deployments, migrations, application data, additional Neon services, API keys, integration auth configs or webhooks were configured. No provider credentials were copied. Account/dashboard access is not live-provider execution proof. See [provider account setup](../../research/provider-account-setup.md) for the remaining configuration and validation work. Provider screenshots are kept in the ignored local artifact directory and are not committed.
