# E2B computers

The hosted E2B adapter assigns one private sandbox to each authenticated owner. Its browser and workspace share that sandbox while using separate Linux users: `sidekick-browser` (UID 1001) owns the browser, and `node` (UID 1000) runs workspace commands. The server holds the E2B key, selects the template and chooses the execution user. Users do not choose providers or receive sandbox credentials.

The browser uses the existing Chromium/Xvfb worker and `/data/control.sock`. Its home and profile root are mode 0700; the socket and Xauthority files are mode 0600. App source and helpers are root-owned. Workspace files live under `/workspace`, with user-installed tools under `/home/node/.local`. Credential input, masked frames, supervised process-group cancellation and bounded artifact reads retain the existing adapter protocols.

## Build and local validation

Use Node 24.21 or later, Docker, and `npm ci`. The builder uses E2B SDK 2.51.0. Check the exact bounded context without loading credentials:

```sh
node --import tsx deployment/e2b/build.ts computer --check
node --import tsx --test tests/e2b-templates.test.ts
```

The context contains package manifests, the browser worker/bridge/readiness import closure, the generated Python workspace supervisor and the root-only computer guard. It excludes server/runtime/UI code, environment files and user data. Symlinks, unapproved imports and oversized source fail before any upload. Preflight prints only source paths, sizes and hashes and removes its temporary context.

Build the same combined image locally, then pass the returned image tag to the boundary fixture:

```sh
node --import tsx deployment/e2b/build-local.ts
node deployment/e2b/validate-computer.mjs sidekick-e2b-computer:<source-hash-prefix>
```

The build downloads public Docker, Debian and npm dependencies; it does not forward application environment variables into Docker. The fixture creates only its own temporary Docker container, with NET_ADMIN as the only added capability, no host network or bind mounts, and synthetic files. It checks real Chromium CDP and authenticated Xvfb access as the browser user; workspace denial of CDP, IPv4/IPv6 loopback, the container's own address, synthetic metadata addresses, the control port, browser files/socket, process access, helper writes and privilege escalation. Workspace DNS, HTTPS and ordinary file writes must still work. Missing NET_ADMIN and a changed firewall must fail readiness. The fixture removes only its own container. These checks do not prove the live E2B kernel, networking or pause/resume behavior.

On 2026-09-27, the combined linux/amd64 image passed that local fixture, including the positive browser and workspace checks, six denied network targets, eight denied file/process operations, and both readiness failures. The six template/readiness tests and TypeScript check also passed. No live E2B template or sandbox was created for this evidence.

After confirming the development key's project, build a versioned template explicitly:

```sh
node --env-file=.local/cloud/development.env --import tsx deployment/e2b/build.ts computer sidekick-computer-development-v1
```

This contacts E2B and creates billable provider resources according to the project's plan. Requests have a 30-second timeout; the whole build wait is bounded to 30 minutes. A timeout can leave a build running: inspect its existing state before retrying. Store the returned `templateId` as `E2B_COMPUTER_TEMPLATE`, with `COMPUTER_PROVIDER=e2b`, in that development configuration. Build production separately using its own project key and versioned name. Never substitute development keys or allocations for production. The template has two virtual CPUs and 3 GiB memory. Old `browser` and `workspace` build targets remain for legacy fixtures; the combined hosted configuration rejects their old template environment keys and does not adopt their allocations.

## Startup and isolation gate

`computer-guard.py start` runs as root, installs a dedicated nftables `inet` OUTPUT chain, records its exact accepted rules, then drops groups and switches to `sidekick-browser` before starting the browser worker. The rules match workspace UID 1000 across IPv4 and IPv6. They reject local interface addresses, loopback, private/link-local/metadata networks and TCP port 49983. Only DNS on port 53 to the sandbox's configured resolvers is exempted before those denies. Browser traffic uses its existing trusted browser policy.

The image removes setuid/setgid bits and file capabilities and contains no sudo. Workspace execution additionally uses `setpriv --no-new-privs`. The workspace cannot change root-owned files or firewall rules. Public sandbox traffic is disabled separately by the SDK; that setting alone does not isolate processes inside a sandbox.

Before making a created or resumed sandbox available, the trusted client runs this fixed command as root:

```sh
python3 /opt/sidekick/computer-guard.py check
```

Only exit zero, exactly `{"ready":true}` plus a newline, and empty stderr establish readiness. The check verifies private/root-owned paths, current interface/resolver inputs, unchanged firewall rules and an actual browser-worker socket exchange as the browser user. It does not reinstall a lost firewall, restart a missing browser, clear an uncertainty fence or adopt another resource. A filesystem-only provider resume may lose processes and network rules; that case must fail readiness.

The E2B runtime's published default kernel configuration enables nftables and `NFT_META`, while legacy `NETFILTER_XT_MATCH_OWNER` is disabled. This is why the guard uses native nftables `meta skuid`. Published source is not proof of the deployed project's guest capabilities: a live development build must verify NET_ADMIN, the complete deny matrix, DNS/Internet and pause/resume before enabling the template in production. Missing support is a blocker; never skip the guard. E2B's in-VM `envd` exposes process/file control on port 49983, which must remain unreachable by workspace commands. Sources checked 2026-09-27: [E2B runtime architecture](https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md), [default kernel selection](https://github.com/e2b-dev/runtime/blob/main/packages/shared/pkg/featureflags/flags.go), [kernel configuration](https://github.com/e2b-dev/runtime/blob/main/firecracker/fc-kernels/configs/x86_64/6.1.158.config).

## Ownership, recovery and acceptance

The durable allocation store binds owner, resource, generation and version. Shared browser/workspace activity must use that single allocation's lease and active-command accounting. A lost heartbeat, interrupted transport, failed readiness check or missing terminal acknowledgement fences the allocation. Never create a replacement, adopt an expired lease or clear uncertainty merely to make a retry succeed.

Normal shutdown drains accepted commands and closes the browser namespace before confirming pause and releasing ownership. Reconnect must retain the same sandbox ID and generation. Idle pause and continuous-runtime recycling must wait for both browser and workspace commands. SDK creation disables traffic auto-resume and selects pause on timeout. Provider disk or memory snapshots do not replace owned transcript/artifact storage. Operators still need retention, deletion and explicit uncertain-resource recovery procedures. [E2B persistence reference](https://docs.e2b.dev/sandbox/persistence).

Local fixtures and image checks establish only their tested boundaries. Live development acceptance must verify one sandbox ID across browser and shell, the full isolation matrix, synthetic navigation and private input, cancellation with a surviving child, artifact publication, same-resource pause/resume and profile recovery after an actor restart. A readiness or receipt failure must remain fenced without replay. Only then repeat the approved journey with production keys. Keep sandbox IDs, credentials, private frames and user content out of public reports.
