# Otto cutover — 2026-09-28

This dated snapshot separates the running legacy Sidekick pilot from the new Otto resources. Repository `n8n-io/sidekick` was renamed to `n8n-io/otto`; repository identity and existing commits were retained. The application cutover also changes resource and authentication namespaces, so the repository rename alone does not migrate users or establish a working Otto deployment.

## Legacy service remained available

Release `b7057dbb4547933b37e178bf456953ed87e833de` passed [main CI 36389613524](https://github.com/n8n-io/otto/actions/runs/36389613524) and its automatic [production deployment 36390657462](https://github.com/n8n-io/otto/actions/runs/36390657462). The legacy `https://sidekick.n8n-maintenance.workers.dev` service remained healthy.

At 16:03 UTC, one fresh ordinary chat submission returned HTTP 200 in 2.315 seconds. Read-only completion confirmed one owned persisted reply and zero tool events; the existing in-app browser displayed the reply without reloading. At 16:05 UTC, the legacy Apps UI showed Slack and Notion connected. This is connection-state evidence, not a new app read, signed event or Slack delivery check.

The production reset completed at 01:06 UTC before subsequent signup and user activity. Existing accounts, sessions, connected apps and current data must be preserved; this cutover does not authorize another reset. Earlier multi-account, file and browser evidence remains scoped to its [dated releases](2026-09-27-production-chat.md).

## Initial Otto deployment stopped before publication

Main `6f2c3b0995350e4244675ab4d40fa1aa8773a4e0` passed [CI 36429968460](https://github.com/n8n-io/otto/actions/runs/36429968460), but [deployment 36431310032](https://github.com/n8n-io/otto/actions/runs/36431310032) failed during R2 bucket preparation, before image publication, deployment preparation or Worker publication. Its fixed error did not expose the underlying provider status. A separate local read using the saved CI credential returned HTTP 403, supporting a permissions diagnosis; the remote GitHub secret value was not readable, so this does not establish the exact CI response. At that point, the Otto origin returned HTTP 404 and had no live acceptance.

The operator subsequently created `otto-production-files` and `otto-development-files` through the dashboard. Each bucket's settings showed EU jurisdiction, no custom domains and a disabled Public Development URL. A read-only settings request for the existing Sidekick Worker returned HTTP 200 with that locally saved scoped deployment credential and included its R2 binding metadata. This confirms that credential's access to the existing Worker's settings; it does not establish the new Otto binding or application access.

## Repair contract and remaining checks

The repair separates one-time storage provisioning from routine CI. Each environment must select exactly one explicit EU `TENANT_FILES` binding. A separate operator helper uses `CLOUDFLARE_R2_OPERATOR_TOKEN` and the account ID to create only that missing bucket, then checks its jurisdiction and disabled managed/custom-domain access. It never changes privacy settings or uses the deployment credential as an operator-token fallback. Denied or unknown reads stop the operation.

Routine deployment has no R2 administration requirement, uses `wrangler deploy --experimental-provision=false`, and verifies the exact published Worker bucket binding before completing deployment or recovery. The existing image, natural-drain, rollout and health/authorization gates remain required. [Operator setup and deployment procedure](../../../deployment/cloudflare/README.md#storage-bootstrap).

Otto uses `otto_auth`, `otto_control`, a new login cookie prefix and changed tenant/key derivation labels. Existing Sidekick users, sessions, files and encrypted grants are not copied by the environment-name adapter. Keep the legacy installation intact. Verify the new Google callback, app callbacks and webhook origins explicitly; an old origin's successful consent is not Otto acceptance.

Local root validation of the repair passed 1,372 of 1,376 tests, with four native-only skips and no failures. The web build and root type, architecture and formatting checks passed; Gitleaks reported zero findings. Under Node 24, Cloudflare type checks and all 422 package tests passed with zero skips, and both development and production Wrangler dry runs exited successfully. The validator follow-up repeated the 422 passing Cloudflare tests, type checks and both dry runs. These local checks do not establish acceptance of a later deployed revision.

## Manual publication and Google callback gate

Manual deployment of `4088eed` completed at 16:27:03.383 UTC. Actual Worker publication, exact EU binding readback, every container-role rollout, exact-release health and anonymous authorization checks passed; the Otto frontend rendered. The legacy Sidekick service remained healthy on `b7057dbb` in parallel. These results are scoped to `4088eed`; [PR #16](https://github.com/n8n-io/otto/pull/16) tracks subsequent CI and follow-up publication evidence.

At 16:28 UTC, a real Continue with Google attempt returned HTTP 400 `redirect_uri_mismatch` for the new Otto callback. No new user or completed signup was observed. Updating and verifying that callback requires administrator reauthentication through Okta. Google signup, connected-app return/read, owned files and computer work at the Otto origin remain unverified.

At 16:11 UTC, the production E2B dashboard still showed Hobby, 20 concurrent computers, zero credits and a missing payment method. Live E2B remains gated on funding, keys, templates and acceptance; no concurrency upgrade is needed and the eight-user application admission limit is unchanged. Cloudflare remains the interim computer option and does not support the new connected CLI path. Gmail authorization, Telegram delivery, signed integration events, the requested demo/Slack delivery and operator privacy requirements remain separate gates.
