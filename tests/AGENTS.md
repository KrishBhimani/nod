# Validation

`npm test` runs deterministic tests and skips PostgreSQL cases without `TEST_DATABASE_URL`. `npm run test:integration` runs every fixture with the local database by default. Each database fixture creates a random schema, sets its own pg-boss schema, and removes only those schemas afterward. Never reset the normal local profile or database.

| Boundary                                                      | Tests                                           |
| ------------------------------------------------------------- | ----------------------------------------------- |
| Runtime, tools, lifecycle and provider replacement            | `runtime-*`, `pi-agent`, `application-adapters` |
| Dispatch, recovery, cancellation and revisions                | `task-durability`                               |
| HTTP ownership, artifacts and approvals                       | `server-boundaries`                             |
| Credentials, stale forms and encryption                       | `vault`, `runtime-credentials`                  |
| Google consent, events and provider migration                 | `integrations`, `provider-adapters`             |
| Messaging authentication, inbox/outbox and uncertain delivery | `channels`                                      |
| Goals, schedules and memory                                   | `personal`                                      |
| Audio policy and cancellation                                 | `speech`, `provider-adapters`                   |
| Streaming, schedule forms and safe links                      | `web-streams`, `personal`, `message-links`      |

Inject fakes through ports and factories. Avoid global transport mocks when testing feature policy. Keep adapter protocol tests separate. No real email, channel delivery, paid action or personal data in fixtures. A passing substitute stack is not a live provider check.

Run `npm run check` for type, import-boundary and formatting checks; `npm run build` validates the client bundle. Broaden testing only when a change affects another boundary or a failure requires it.
