# Cloud signup research and prototype verification

Date: 2026-09-26. Branch: `prototype/cloud-signup`. Starting application revision: `1a471a0`.

## Scope and decision

Research and a standalone Vite UI prototype only. The user selected **A — Quick start** and requested removing four login-screen lines: the private-account reassurance, explanation of sign-in versus Gmail/Calendar consent, hosting credit, and design-preview label. These were removed and their absence checked in the rendered page.

No production authentication, tenant isolation, provider accounts, live OAuth, webhooks, Telegram messages, remote computers, migrations, or deployments were executed or validated. This is not proof of the security or provider behavior described in the UI.

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

The future local-live, staging and production acceptance suites are specified in the research reports. Existing backend integration fixtures were not rerun for this documentation/standalone UI change; no backend behavior changed.
