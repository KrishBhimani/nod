# E2B computers

The server selects E2B through `createE2BAdapters` in `src/providers/e2b/index.ts`. The factory is bound to one authenticated owner and receives credentials, template IDs, a local cache root and a durable `ComputerAllocationStore`. Its browser and shell use separate sandboxes. No API key or sandbox traffic token is exposed to an agent or web client.

The trusted browser template runs the existing Chromium/Xvfb worker with its private Unix socket. Credential input and native sign-in frames use the existing private bridge methods. The workspace template runs commands through the same Python process-group supervisor as local Docker. Commands and file contents travel over stdin; artifact reads retain descriptor-based traversal and size checks.

## Build templates

Use Node 24.21 or later and install the repository lockfile with `npm ci`. The builder uses the pinned `e2b` 2.51.0 SDK. First run the offline preflight without loading credentials:

```sh
node --import tsx deployment/e2b/build.ts browser --check
node --import tsx deployment/e2b/build.ts workspace --check
```

Preflight prepares exactly the context the live builder will use, parses the Dockerfile through the SDK and hashes its inputs. It prints source paths, sizes and hashes, makes no network request and creates no provider resource. Browser source is limited to the worker, stdin bridge, readiness probe and their approved TypeScript import closure. Server, runtime, UI, environment files and user data are excluded. Symlinks, out-of-scope imports and oversized inputs fail before a build can start. The temporary context is removed on success or failure.

After confirming which E2B project owns the development key, store it as `E2B_API_KEY` in the ignored development environment file and run the two builds explicitly. Use unique, versioned names so rebuilding does not silently change a previously released template name:

```sh
node --env-file=.local/cloud/development.env --import tsx deployment/e2b/build.ts browser sidekick-browser-development-v1
node --env-file=.local/cloud/development.env --import tsx deployment/e2b/build.ts workspace sidekick-workspace-development-v1
```

These commands contact E2B and create provider resources subject to the project's pricing. Each request has a 30-second timeout and the overall build wait is bounded to 30 minutes. A timeout can leave a provider build running: inspect its state in the dashboard before retrying. The JSON result contains the template ID, build ID, name, role and source hash; errors use fixed text without raw provider bodies. Copy the browser result's `templateId` into `E2B_BROWSER_TEMPLATE` and the workspace result into `E2B_WORKSPACE_TEMPLATE`, with `COMPUTER_PROVIDER=e2b`, in the same development environment file. A successful build is not a runtime or sign-in acceptance check.

Build production templates separately with the production project's key and versioned `sidekick-browser-production-v1` / `sidekick-workspace-production-v1` names. Template names do not verify the key's project or change its permissions. Keep the returned IDs with that environment's configuration; never substitute a development key or allocation for production. The builder uploads package manifests and approved source, not host environment variables. Registry/package downloads use public Docker, Debian and npm sources; do not add private registry credentials or package URLs to the template context.

The browser template has two virtual CPUs and 2 GiB memory; the workspace has two virtual CPUs and 1 GiB memory. Browser build checks require Chromium, Xvfb, xauth, xdotool, ffmpeg, the Linux x64 agent-browser executable and the bridge source. Readiness validates the owned mode-0600 Unix socket and completes a bounded protocol exchange with the worker; it neither opens Chromium nor creates an account namespace. The SDK's regular-file readiness helper cannot check a Unix socket. Workspace checks validate the generated Python supervisor, required executables and writable workspace. Its explicit PATH avoids unexpanded Dockerfile variables in the SDK parser.

The browser worker starts during template construction, with no owner identity, credentials or authenticated profile. Templates and allocations are recorded by ID; changing server configuration does not migrate an existing computer automatically. At runtime the SDK disables public sandbox traffic and uses separate browser/workspace allocations. This is an inbound-access restriction, not an outbound Internet firewall. Commands retain the server-selected provider policy, and shell access never shares the trusted browser's files or socket. [Template start/readiness reference](https://e2b.dev/docs/sdk-reference/js-sdk/v2.4.3/template-readycmd).

## Ownership and lifecycle

`ComputerAllocationStore.compareAndSwap` must atomically match owner, role and expected version. A missing record uses expected version `null`. Only trusted server code may read or write resource IDs. Keep this store in PostgreSQL for hosted environments; an in-memory implementation is suitable only for isolated fixtures.

An allocation has a generation, exclusive lease and monotonically increasing version. New allocations are lazy. The default lease lasts 90 seconds and renews every 30 seconds. Commands also renew ownership before execution. A failed heartbeat, interrupted transport or missing terminal acknowledgement fences the allocation. A second actor cannot claim a leased or uncertain record, including an expired lease, until recovery has confirmed the old work stopped. Do not clear that state merely to make a retry succeed.

Normal shutdown drains accepted commands, closes the browser namespace and pauses each allocated sandbox before releasing its lease. Reconnection restores the same resource ID and generation. A failed pause retains ownership and supports a cleanup retry. An unused role creates no sandbox during shutdown. The allocation heartbeat renews the database lease and the running sandbox's default 30-minute timeout. With no command handles active, a role pauses after two idle minutes. The next request explicitly resumes its existing sandbox and generation. After 45 minutes of continuous operation, new requests wait for existing commands to drain before a pause/resume cycle; this keeps the default below the Hobby plan's continuous runtime limit. Never pause in-flight commands or repeat an uncertain operation.

The SDK creates sandboxes with `lifecycle: { onTimeout: 'pause', autoResume: false }`: loss of the actor heartbeat preserves provider state on expiry without allowing incoming traffic to resume it. Browser bridge commands are separate, single-request processes with a 180-second transport bound; the browser worker is the persistent template process. The Python supervisor continues to enforce its independent 120-second command limit and drain acknowledgement. E2B can fall back to a filesystem-only auto-pause after a prolonged snapshot backlog, so restored disk does not guarantee restored processes. Missing acknowledgements or unavailable runtime state remain fenced. [Provider lifecycle reference](https://docs.e2b.dev/sandbox/persistence).

Paused sandboxes retain private data at the provider. The operator must implement retention, deletion and explicit recovery for uncertain resources. Provider snapshots are not an artifact backup or a transcript store. Keep publication metadata and durable copies in the application's owned storage.

## Validation

```sh
node --import tsx --test tests/e2b-templates.test.ts
node --import tsx --test tests/e2b-adapters.test.ts tests/e2b-client.test.ts tests/container-browser.test.ts tests/workspace-command.test.ts
```

Template fixtures exercise the actual worker readiness exchange and reject regular files, unsafe permissions, silent/malformed services and symlinked source. The remaining fixtures exercise the real local Unix-socket bridge and Python supervisor through an injected E2B transport. They cover owner separation, credential/frame routing, process-group drain, output acknowledgement, lease races, idle heartbeat/pause, command drain before runtime recycling, same-resource reconnect and fixed error messages. They do not create E2B resources or establish live Google sign-in, native browser restoration, provider isolation or production readiness. Run those checks with development templates and synthetic accounts before enabling production.

The live development gate must create one browser and one workspace through the adapter, inspect a synthetic page, exercise private input and masked screenshots, cancel a shell process with a child process, import and publish a bounded artifact, pause/resume both roles with the same IDs, and confirm profile restoration after an actor restart. Rejected or uncertain commands must stay fenced without replay. Keep sandbox IDs and private frames out of public test reports, and pause or delete only the test resources owned by that run. Only then repeat the approved production journey using production configuration.
