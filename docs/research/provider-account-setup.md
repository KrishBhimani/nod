# Provider account preparation

Status date: **2026-09-26**. This record separates provider resources, implementation, fixture checks and live acceptance. See the [rollout research](cloud-rollout-plan.md) and [production guide](../production.md).

Cloudflare, Neon and Composio are selected. E2B is the implemented first remote-computer adapter, pending live evaluation of the trusted browser, isolated shell, pause/resume and account persistence.

## Current status

| Provider     | Development                                                                           | Production                                                                   | Live evidence and remaining setup                                                                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composio     | Existing `sidekick` project; new `sidekick-development-runtime-v2` scoped runtime key | Separate `sidekick_production` project and scoped runtime key                | Development account-list read succeeded; session/proxy probes reached input validation. No new live consent, event delivery or execution has passed. Auth configurations and webhook destinations remain to configure.                                                                                                  |
| Neon         | Separate `sidekick-development`, PostgreSQL 17, AWS Frankfurt                         | Separate `sidekick-production`, PostgreSQL 17, AWS Frankfurt                 | Both use the free plan. Development TLS, temporary two-tenant provisioning, private queue/object migrations and cross-user access denials passed; temporary resources were cleaned up. App databases remain unmigrated. Both direct connections are saved privately; production credentials have not been used locally. |
| E2B          | `sidekick-development` in the standard `Sidekick` workspace                           | Separate `sidekick-production` project in the same workspace                 | Production requires billing setup. No template, API key or sandbox has been created. Both projects currently use the default US region; EU availability and any paid plan need an explicit decision.                                                                                                                    |
| Cloudflare   | Deployment configuration targets Jan's account                                        | Separate production Worker, private container bindings and R2 bucket defined | Dashboard access verified. Local image build and deployment dry runs passed; no resource or deployment has been created. Scoped deployment credentials, actual hostname and plan eligibility remain to configure.                                                                                                       |
| Google login | Local callback planned at `http://localhost:4330/api/auth/callback/google`            | Callback depends on the selected production hostname                         | Work-account Google Cloud session requires a fresh Okta verification. OAuth clients have not been created. Personal Google is authorized for local and production acceptance testing.                                                                                                                                   |

Local environment files are ignored and owner-readable only. Development and production have separate Composio keys, authentication secrets and encryption roots. Existing operator model configuration was copied into those server files; it is never included in the frontend. Production credentials have not been used for local acceptance tests.

A first development Composio key was created with an incomplete scope set and replaced by `sidekick-development-runtime-v2`; the unused key still needs revocation. The pre-existing local application's runtime key remains in use by that application and must be preserved.

## Validation status

Real PostgreSQL fixtures use a separate disposable local service, schemas and roles. They prove role-level cross-user isolation and the real Better Auth persistence boundary. A separate live Neon development preflight also verified two restricted logins, isolated queues, private object-store migration and cross-user access denials in a temporary database, then removed its test resources. Two actual local tenant processes retained separate preferences across a graceful gateway restart without calling model or computer providers. These are synthetic-user checks, not completed Google login or live provider acceptance.

The initial Cloudflare configuration admits at most eight users and retains active runtimes for schedules and event processing. It is a bounded pilot with ongoing compute costs, not a scale-to-zero design. No paid plan has been purchased, no production deployment has occurred, and no live Sidekick login, integration webhook, Telegram conversation or remote-computer task is yet verified.

## Remaining setup

1. Complete Google Cloud verification and E2B billing/spending-limit decisions. Confirm the Cloudflare plan and actual production hostname.
2. Create OAuth clients and provider credentials, configure development consent and webhook routes, build E2B templates, then test the full local journey with the personal Google account.
3. Verify cross-user HTTP, database, files, jobs, integrations, browser and workspace isolation, including restart and uncertain-operation recovery.
4. Supply Albert and Johan's invitation email addresses, then verify their project access.
5. Configure production secrets and CI/CD, deploy only after local acceptance, and repeat the live journey in production. Keep fixture and live results separate in the acceptance record.

No personal email addresses or secret values belong in this record.

The detailed implementation and test evidence is maintained in the [hosted acceptance record](../testing/results/2026-09-26-cloud-hosting.md).
