# Compiled OpenCode boot experiment

## Objective

Remove compilation and `git clone` from sandbox cold boot without keeping idle
sandboxes.

Git remains the source of truth. The API compiles one exact commit into two
immutable artifacts:

- `checkout.tar.gz`: the project files and Git metadata.
- `server.mjs`: the verified daemon bundle, compiled agent configuration, and
  compressed project OpenCode configuration.

The sandbox downloads and verifies both artifacts. `server.mjs` starts the
OpenCode-based Kortix daemon that is already present in the sandbox image.
This design does not use Pi and does not change the OpenCode API.

Secrets are not compiled into either artifact. The sandbox receives secrets as
runtime environment variables through the existing provider integration.

## Rollout flag

Set `KORTIX_COMPILED_BOOT_MODE` in the API environment:

- `off`: Use the existing clone path. This is the default.
- `shadow`: Download and verify both artifacts, then use the existing clone and
  baked-agent paths.
- `prefer`: Use both artifacts. Fall back to the existing paths on failure.
- `required`: Require both artifacts. Fail the sandbox boot if either artifact
  is unavailable or invalid.

The flag applies only to new full-repository sessions. Resumed sessions,
replacement sandboxes, and runtime-only sessions keep their existing behavior.

## Boot path

1. The API resolves the requested branch to an exact commit SHA.
2. The API starts both builds while the provider creates the sandbox.
3. The sandbox downloads both artifacts with its session token.
4. The sandbox verifies each SHA-256, format, project, ref, and source SHA.
5. `server.mjs` extracts the OpenCode configuration to tmpfs and starts the daemon.
6. The daemon starts OpenCode while the checkout extraction continues.
7. The sandbox verifies Git HEAD and the clean working tree in the checkout.
8. The sandbox creates the local session branch.
9. The daemon permits the first directory-scoped OpenCode request.
10. The existing background Git history fetch continues after startup.

The artifact includes Git metadata. The sandbox sets `origin` to the Kortix Git
proxy. The sandbox does not receive an upstream Git credential.

An accepted Git push also prebuilds both default-branch artifacts. This work is
asynchronous and does not delay the Git response. The session route still
builds on demand when the requested ref has not been prebuilt.

## Local test

Add this machine-local setting to `apps/api/.env.local`:

```dotenv
KORTIX_COMPILED_BOOT_MODE=prefer
```

Restart the local stack and create a new session. The sandbox health response
must contain:

```json
{
  "compiled_boot_mode": "prefer",
  "compiled_checkout": true,
  "compiled_runtime": true,
  "compiled_runtime_format": "kortix.compiled-runtime.v1"
}
```

Set the value to `off`, restart the stack, and create another new session to
measure the existing clone path.

## Measured result

The checkout benchmark used one managed GitHub project and a ready Daytona base image.
Each sample created and then deleted a new sandbox.

| Mode                              | Repo materialization |
| --------------------------------- | -------------------: |
| Existing clone                    |             2,916 ms |
| Compiled checkout, cold API cache |             1,609 ms |
| Compiled checkout, warm API cache |               845 ms |

The warm checkout removes 2,071 ms, or 71%, from repository materialization.
A later local Daytona sample measured OpenCode spawn-to-ready at 5.96 seconds.
The compiled launcher preserves that process and therefore does not remove this
time.

The first full `server.mjs` session used the same managed GitHub project and a
new Daytona sandbox. The one-time content-addressed image build took 423.702
seconds and is excluded from the guest boot stages below.

| Guest stage | Cumulative time |
| --- | ---: |
| Compiled checkout materialized | 861 ms |
| Runtime process spawned | 1,074 ms |
| OpenCode ready | 6,795 ms |

The health response reported `compiled_runtime: true` and
`compiled_checkout: true`. Both artifacts reported source SHA
`536684344bc174c2068e0964bc20481182d604f4`. A real OpenCode session then
accepted a prompt and returned the expected response in 3,916 ms.

The installer originally executed Node once to inspect the MJS manifest. The
compiler now emits a base64url manifest marker. The installer validates that
marker after digest verification without executing the artifact. The focused
install test decreased from 74 ms to 1.44 ms.

A second session used the final ready Daytona image with warm project snapshots
disabled. End-to-end runtime readiness took 11,852 ms:

| Host or guest stage | Time |
| --- | ---: |
| API session response | 1,268 ms |
| Cached image lookup | 458 ms |
| Daytona VM creation | 2,302 ms |
| Compiled checkout materialization | 700 ms |
| Remaining daemon setup before OpenCode | 376 ms |
| OpenCode spawn to ready | 6,034 ms |

The compiler has reduced repository delivery below one second. OpenCode now
accounts for 84% of the 7,143 ms in-guest boot timeline. The next session-boot
optimization must target OpenCode initialization rather than Git.

The compiled-config overlap change was measured on 2026-08-25 with three new
Daytona sandboxes. Warm sessions and project snapshots were disabled. All
sessions used the same ready default image and the same seeded managed project.

| Measurement | P50 | Range |
| --- | ---: | ---: |
| API session response | 595 ms | 495–608 ms |
| Daytona VM created | 2,643 ms | 2,135–2,758 ms |
| Daemon reachable | 3,959 ms | 3,465–4,005 ms |
| Runtime ready | 9,548 ms | 5,614–10,281 ms |
| OpenCode process spawned in guest | 131 ms | 111–213 ms |
| Checkout ready in guest | 989 ms | 623–1,255 ms |
| Guest runtime ready | 6,116 ms | 1,764–6,381 ms |

OpenCode now starts 492–1,124 ms before checkout completion. The prior recorded
sample reached runtime readiness in 11,852 ms and guest readiness in 7,143 ms.
The new three-run median is 9,548 ms and 6,116 ms respectively. OpenCode's
remaining process and project initialization varies from about 1.6 to 6.2
seconds and is now the dominant boot cost.

The new artifact keeps the v1 wire-format marker. Existing Daytona images
contain the v1 installer. The bundled daemon SHA already changes the artifact
cache identity, so the config capsule does not require a wire-format bump.

## Current limits

- The API prebuilds on a managed Git push and overlaps on-demand builds with
  provider provisioning.
- The artifact cache uses local ephemeral API storage. Another API replica can
  rebuild the same content-addressed artifact.
- One compressed checkout cannot exceed 512 MiB.
- One compiled runtime cannot exceed 16 MiB.
- `server.mjs` does not package the OpenCode executable. The sandbox image
  contains OpenCode 1.18.19 at `/opt/kortix/opencode.current`.
- Compiled boot disables OpenCode's remote models.dev refresh. The embedded
  model snapshot and Kortix managed provider catalog remain available.
- Daytona SDK 0.184 supports disk-preserving stop/start. It does not expose a
  running-process memory checkpoint API. Daytona resume therefore restarts
  OpenCode instead of restoring its process memory.

The next compiler step is shared object storage. It will let every API replica
serve the artifact produced by the Git push. The next latency target after that
is OpenCode process initialization.

## Standalone MJS runtime prototype

`experiments/compiled-boot-mjs` contains an isolated runtime-update prototype.
The production session path now uses a separate compiled `server.mjs` launcher.

The prototype serves `server.mjs` through a stable reverse proxy. A runtime
update builds and starts a candidate in parallel. The supervisor verifies the
candidate, atomically routes new requests to it, drains requests assigned to the
previous process, and then stops the previous process. A build or health failure
leaves the previous process and artifact active. Candidate promotion is not yet
connected to the production session proxy.
