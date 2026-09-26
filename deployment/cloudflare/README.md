# Cloudflare deployment adapter

The public Worker serves built web assets and sends `/api/*` to one private Node gateway. The gateway authenticates Google sessions, provisions a tenant SQL role and private schemas, and sends signed requests to that user's Node container. Application code stays in the ordinary Node image; Cloudflare lifecycle and object-storage bindings stay in this directory.

This is an always-running pilot for eight admitted users. Each environment allows one gateway and eight tenant containers. The tenant store defaults to eight users and rejects new provisioning atomically at capacity. Increasing admission also requires increasing container capacity and reviewing database connection and provider budgets; the provisioner has a hard ceiling of 400 roles. It does not implement scale-to-zero scheduling. A minute Cron wakes the gateway after an interruption, and gateway startup/periodic recovery must rehydrate the persisted registered owners. The actor's signed lease heartbeat controls whether it may continue work.

## Local checks

Use the repository's supported Node version and an available Docker engine.

```sh
npm ci
npm run build
npm --prefix deployment/cloudflare ci
npm --prefix deployment/cloudflare run check
npm --prefix deployment/cloudflare test
cd deployment/cloudflare
npx wrangler deploy --env development --dry-run --containers-rollout=none
```

The tests use synthetic identities, lifecycle substitutes and an in-memory object-store substitute. On 2026-09-26, type checks, all 20 package tests and both environment dry runs passed after the private bind-host and fixed-error proxy changes. The dry run validates bundling and configuration; it does not start Cloudflare containers, verify a real R2 write, authenticate Google or deploy anything. Track the separate root and live checks in the [acceptance record](../../docs/testing/results/2026-09-26-cloud-hosting.md).

For the actual container stack, use `wrangler dev --env development` with a local `.dev.vars.development` secret file. Set `SIDEKICK_PUBLIC_URL` to the local Wrangler origin and use development provider accounts. Cloudflare's virtual-host outbound handlers keep the same HTTP adapter interface in local container development. The Node gateway's ordinary process transport remains the simpler way to test providers without deploying.

## Environments and secrets

`wrangler.jsonc` has separate `development` and `production` Workers, Durable Object namespaces, EU R2 buckets and container applications. The repository is configured for Sidekick's verified account subdomain: `https://sidekick-development.n8n-maintenance.workers.dev` and `https://sidekick-production.n8n-maintenance.workers.dev`. These are configured destinations; neither app has been deployed there. The account's existing Workers Paid plan includes Containers, and no plan change was made for this work.

For self-hosting in another account, change the Worker/resource names as needed and replace each `SIDEKICK_PUBLIC_URL` with that deployment's canonical HTTPS origin. Keep the corresponding `GATEWAY_ENV`, Google OAuth callbacks, integration callbacks and GitHub environment variable consistent with it. Set the selected Cloudflare account through the deployment environment, rather than committing account credentials. Create both private R2 buckets in the configured EU jurisdiction.

Store one `GATEWAY_ENV` Worker secret per environment. Its value is the JSON object of server environment variables used by the Node gateway: the control-plane database URL, auth settings, tenant key material and operator-selected provider configuration. The Worker overrides process mode, canonical origin, environment, data directory and port. Never use build arguments, Vite variables or checked-in Wrangler `vars` for secrets.

Keep the compact JSON under 5 KiB including the injected `SIDEKICK_RELEASE`: this is Cloudflare's per-variable limit. Include only the provider keys actually used, rather than copying an entire shell environment. The deployment script rejects an oversized secret before publishing. [Worker limits](https://developers.cloudflare.com/workers/platform/limits/#environment-variables).

The gateway builds each tenant's environment explicitly. Required fields are `SIDEKICK_OWNER_ID`, `SIDEKICK_ENVIRONMENT`, `SIDEKICK_MODE=tenant`, `SIDEKICK_RUNTIME_GENERATION`, `SIDEKICK_RUNTIME_SECRET`, `SIDEKICK_RUNTIME_LEASE_EXPIRES`, `DATABASE_URL` and `PGBOSS_SCHEMA`. The Worker checks that the SQL role and jobs namespace match the opaque hash of the supplied owner/environment. Only derived tenant credentials and the configured runtime provider keys belong in that environment. The control database credentials, Google login secret and tenant derivation master key stay in the gateway.

Both process roles run `node --import tsx src/server/index.ts`; bootstrap forces `SIDEKICK_BIND_HOST=0.0.0.0` and port 4310 inside the private container. They use `/data` as an ephemeral working directory. The Docker build copies only source, package manifests and public build assets. It never copies `.env`, `.local`, browser profiles or database files. The image runs as the unprivileged `node` user.

## Private transport

Only the fixed gateway Durable Object may call `http://sidekick.runtime`. The handler verifies the platform-supplied class and container ID. These operations have no public Worker route:

| Request                         | Input                                                | Result                                                                 |
| ------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `POST /runtime/start`           | `{ownerId, env}`                                     | `{ok:true, generation}` after startup                                  |
| `POST /runtime/status`          | `{ownerId}`                                          | `{generation, stopped, status}`                                        |
| `POST /runtime/stop`            | `{ownerId, generation}`                              | `{ok:true, generation, stopped:true}` only after confirmed termination |
| Any method `/<ownerId>/api/...` | Original body and signed `x-sidekick-runtime` header | Tenant HTTP response, including streaming bodies                       |

The handler removes the owner prefix before the actor verifies the signed request target. Startup stores only owner/environment/generation, a configuration digest and stopped state in the Durable Object. It does not persist the bootstrap environment or credentials. A changed generation requires an explicit stop of the exact prior generation and a larger generation number. Stale cleanup cannot stop a replacement. A stopped actor is not automatically started by forwarding an ordinary request. HTTP forwarding uses the platform TCP-port Fetcher inside fixed-error handlers; SDK helpers continue to manage lifecycle/startup monitoring, but the proxy does not return or log their raw HTTP errors.

Only tenant containers may call `http://sidekick.control`, and only `POST /api/internal/channels/claim` or `/release`. The handler checks the platform identity, forwards the signed runtime header and body, and fixes the owner and canonical Host. The gateway independently verifies the owner's signature, request body and current SQL lease. Tenant containers cannot call runtime lifecycle operations.

Channel claim requests include a durable account revision. The registry retains released revisions to reject delayed mutations after cleanup or re-enabling. An upgrade from the earlier unversioned protocol must drain and confirm termination of old gateway/tenant processes before activating this version. Existing claims migrate at revision zero; keep tenant counters and control tombstones together during recovery.

## Private files

`http://sidekick.storage/v1/objects/<encoded-key>` is a tenant-only outbound binding to the private `TENANT_FILES` R2 bucket. The trusted calling container determines the environment/owner prefix; caller-supplied owner headers do not select storage. There is no listing operation, public route, or R2 credential in the Node process.

Accepted keys are `artifacts/<uuid>` and `sessions/<task-uuid>.jsonl`. GET returns bytes plus `ETag`, or 404. PUT is bounded to 16 MiB and requires `If-None-Match: *` for a new object or the previous quoted `If-Match` ETag; a stale writer receives 412. Successful writes return 204 and the new ETag. Unconditional DELETE removes only that owned key. Conditional DELETE returns 501 without deleting because R2 has no atomic conditional delete API; cleanup must retain the orphan for reconciliation rather than silently ignore a precondition. Objects always use private no-store response metadata. Durable session writers must retain and compare the returned ETag.

## Rollout and verification

`.github/workflows/ci.yml` runs root checks, PostgreSQL fixtures, the web build, this package's checks/tests, both Wrangler dry runs, and an amd64 image build with a non-root/filesystem check. `.github/workflows/deploy.yml` starts only after successful CI on this repository's current `main` commit. It checks out that exact SHA, rebuilds it without production secrets, and serializes production deployment through the GitHub `production` environment. It does not consume build artifacts from pull-request jobs.

Configure the following GitHub environment values:

| Kind     | Name                    | Value                                                       |
| -------- | ----------------------- | ----------------------------------------------------------- |
| Secret   | `CLOUDFLARE_API_TOKEN`  | Scoped deployment token for the selected account            |
| Secret   | `CLOUDFLARE_ACCOUNT_ID` | The selected account's 32-character ID                      |
| Secret   | `GATEWAY_ENV`           | Compact JSON of the production gateway's server environment |
| Variable | `SIDEKICK_PUBLIC_URL`   | Canonical HTTPS application origin                          |

The initial account-scoped provisioning token needs Workers Admin (or legacy Workers Scripts Edit), Containers Edit, and Workers R2 Storage Edit for bucket creation. No zone, DNS, or Workers Routes permission is needed for workers.dev. After bootstrap, Workers Editor scoped to the existing Worker plus Containers Edit is sufficient for the deployment operations; direct R2 provisioning uses a separate operator token. Supplying the account ID avoids account discovery. The actual account policy must be tested before declaring CI operational. [Workers roles](https://developers.cloudflare.com/workers/authorization/workers/), [permission catalog](https://developers.cloudflare.com/fundamentals/api/reference/permissions/), [R2 permissions](https://developers.cloudflare.com/r2/api/tokens/).

After approval and rebuilding, the final CI step rechecks that the validated release is still the current `main` SHA. A superseded revision skips publishing, and a failed lookup stops the job. It then runs `scripts/deploy.mjs production`. The script validates environment/origin/release, creates private temporary configuration and secret files, pushes the already-built `sidekick-production:<SHA>` image, then calls `wrangler deploy --secrets-file` referencing that image. Worker code and `GATEWAY_ENV` enter the same version activation; there is no earlier `secret put` deployment. Logs are fixed phase messages, and private files and Wrangler logs are removed in `finally`. The script suppresses subprocess output because deployment failures can contain provider configuration. Investigate the Cloudflare deployment status using metadata-only diagnostics before retrying. [Code and secrets together](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code), [prebuilt images](https://developers.cloudflare.com/containers/guides/image-management/).

For an authorized manual development deployment, first run the same checks, build `sidekick-development:<SHA>` with `--platform linux/amd64 --build-arg SIDEKICK_RELEASE=<SHA>`, and supply the values above plus `SIDEKICK_RELEASE=<SHA>` through a private environment file or secret manager. Then run `npm --prefix deployment/cloudflare run deploy:development`. The public origin and gateway JSON must identify development, and use the development database/provider projects. The script expects the verified image to exist locally; it never builds an image with production credentials in scope.

Worker activation and container rollout are not atomic. Pre-pushing avoids activating a Worker before an image build/push failure, but mixed old/new runtime versions can still exist during rollout. Keep private transport, storage formats and database changes backward-compatible. A full development deployment is required to test this path; `wrangler versions upload` alone does not publish a container image. [Container deployment behavior](https://developers.cloudflare.com/containers/guides/deploy/).

The smoke check waits for `/api/health` to report the exact new image commit, then verifies that an anonymous session has no user/settings/developer access, ordinary state returns 401, private control/bootstrap routes return 404, and a foreign-origin login POST returns 403. It never signs in or contacts a user's integrations. A smoke failure fails the job and leaves rollback to an operator; it is not evidence that Google, R2, E2B or webhook delivery worked.

Before rollback, inspect the deployed Worker version, image reference, gateway health release, tenant leases and container generations. Confirm that the previous code supports the current SQL schema, object format and secret version. Stop the exact current actor generation and confirm termination before any replacement; never bypass fencing or run a second actor to recover faster. Preserve prior image tags and encryption/derivation keys. Worker rollback does not revert PostgreSQL, R2, E2B state or completed external actions, and incompatible Durable Object migrations can prevent rollback. Prefer a forward fix when compatibility is uncertain. A secret rotation also needs a controlled container restart/new image rollout because an already-running gateway retains its startup environment. [Worker rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

The checked-in configuration uses EU placement, private buckets, a 60-second active rollout grace period and disabled automatic request/container logs. Use fixed sanitized health/error reporting rather than recording headers, bodies, connection URLs or startup environment values. Record live Google, provider, webhook, streaming, persistence and cross-user checks separately from the automated substitutes.

References: [container bindings](https://developers.cloudflare.com/containers/configuration/workers-connections/), [outbound handlers](https://developers.cloudflare.com/containers/guides/outbound-traffic/), [per-instance secrets](https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/), [deployment behavior](https://developers.cloudflare.com/containers/guides/deploy/), [local containers](https://developers.cloudflare.com/containers/guides/local-dev/).
