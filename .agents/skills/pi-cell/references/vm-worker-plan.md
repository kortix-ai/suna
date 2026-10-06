# Pi worker implementation plan and status

- Branch: `pi-worker`
- Preview: `https://pi.kortix.com`
- Architecture: [`PI_WORKER_ARCHITECTURE.md`](./PI_WORKER_ARCHITECTURE.md)
- Two-runtime audit: [`PI_P24_SCOPE.md`](./PI_P24_SCOPE.md)

This file records the implemented scope. Update it in the same commit as a
status change.

## Requirements from the design huddle

| # | Requirement | Status |
|---|---|---|
| 1 | A small Alpine worker hosts the agent harness separately from compute. | done |
| 2 | A full environment hosts the repository, tools, data, and user processes. | done |
| 3 | Pi is the server-side harness. Claude Code and Codex remain environment CLIs. | done |
| 4 | The API compiles agent configuration per Git commit. The worker does not clone the repository. | done |
| 5 | `kortix.yaml` is the agent-definition source of truth. | done |
| 6 | Messages use the durable Kortix store instead of an OpenCode process. | done |
| 7 | Default tools operate on the environment, never the worker filesystem. | done and isolation-tested |
| 8 | The worker has no project working tree or local tool fallback. | done and isolation-tested |
| 9 | Shared filesystems persist outside both boxes through S3 or PostgreSQL. | done across REST, SDK, CLI, and agent paths |

## Delivery phases

### Phase 0 — Pi spike

Status: done.

The spike proved tool replacement, LLM gateway compatibility, bundle startup,
durable history, and the required event stream. Its transport benchmark measured
16.0 ms p50 for multiplexed WebSocket, 19.2 ms for pooled keep-alive HTTP, and
20.3 ms for per-call HTTP through the provider edge.

### Phase 1 — worker and lazy environment

Status: done.

| Piece | Result |
|---|---|
| Pi worker service | HTTP and SSE around Pi with remote workspace tools |
| Compile pipeline | `kortix.yaml` at a commit becomes one content-addressed `.mjs` bundle |
| Worker image | small Alpine image with a supervisor and runtime fetcher |
| Session start | Pi sessions boot on the worker and stream before workspace readiness |
| Lazy environment | first prompt prewarms; first workspace tool creates or resumes the full box |
| Durable transcript | message and part mutations persist in PostgreSQL |
| Shared filesystems | content-addressed blobs through S3 or PostgreSQL |

### P2.1 — latency evidence

Status: done.

Measured on 2026-09-02:

| Path | Environment | Provider | Ready p50 | TTFT p50 | TTFT p95 | Runs |
|---|---|---|---:|---:|---:|---:|
| Pi worker, cold create | branch preview | Daytona | 2.90 s | 4.25 s | 8.76 s | 10/10 |
| OpenCode, cold create | dev | Platinum | 21.52 s | 29.19 s | 59.27 s | 13/13 |

The comparison uses different providers. It proves the end-to-end branch result,
not a provider-neutral speed ratio. A worker warm-pool hit was not available.
The worker pool stays an optional accelerator because correctness uses cold
create.

The previous in-guest clock reported 0.08 s p50 while wall-clock readiness was
2.90 s. External measurement is therefore the acceptance clock.

### P2.2 — environment readiness

Status: done.

`LazyKortixEnv.prewarm()` starts when the prompt arrives. A workspace tool joins
the same attach promise. The worker continues to stream model output while the
environment starts. A failed prewarm does not poison the lazy ensure path.

A branch-preview probe reduced a fresh prompt plus first Bash operation from
37.5 seconds to 9 seconds. This is one observation, not a percentile benchmark.

An environment warm pool is not part of the runtime contract. A pooled full
environment would already need a project image, session branch, runtime token,
and mutable working tree. Prompt prewarm preserves those ownership boundaries
and avoids a fleet of unowned full-compute boxes.

### P2.3 — worker-to-environment transport

Status: done.

The environment daemon serves `/kortix/env-rpc/rpc-ws`. The worker negotiates
one WebSocket and reuses it. It falls back to pooled HTTP for an older environment
image without the WebSocket route. A connection that fails after serving a call
is reported and reattached once; it does not silently change transport.

### P2.4 — remove single-runtime assumptions

Status: done.

The audit confirmed 28 defects across billing, lifecycle, credentials, proxy
routing, SDK, React, database identity, account deletion, and public shares.
All 28 are closed. [`PI_P24_SCOPE.md`](./PI_P24_SCOPE.md) records the closure
matrix and executable lifecycle policy.

### P2.5 — two independent lifecycles

Status: done.

`session-runtime-state.ts` defines every reachable worker and environment pair.
The worker owns the turn. A parked worker stops its environment. A stopped
environment resumes on demand. A removed environment rebuilds. A worker
transport failure discards the stale environment client and retries once.

Detached environment provisioning uses an attempt identity. It cannot publish
after session deletion or a newer attempt. Losing attempts remove their box and
close their compute window.

### P2.6 — separate runtime principals and secret boundaries

Status: done.

The worker and environment have distinct token rows and runtime UUIDs. Token
lease validation resolves the correct runtime table. Egress pins are stored and
verified per runtime. Environment teardown revokes only its token. Session
teardown revokes both.

Worker-to-environment RPC uses a random purpose-bound HMAC secret. The worker
PAT calls `environment/ensure`. The environment PAT calls the control plane.
Neither PAT authenticates RPC on a newly created environment.

Prompt sync and project-secret propagation target the worker and every active
environment. Environment pushes update secret and runtime state without
starting OpenCode or provisioning an unused environment.

### P2.7 — every invocation source

Status: done.

All creation sources enter `createProjectSession`. Pi selection uses the
project's `pi_worker` feature flag and `runtime: pi` at the selected Git ref.
It does not inspect the invocation source. The same path covers the UI, API,
Slack, Teams, Telegram, email, triggers, schedules, and sub-agents.

The branch preview is the rollout boundary. No change on this branch merges or
deploys to dev without explicit approval.

## Shared filesystems

Filesystems are mutable shared state. They are not the project Git repository.

- S3 is used when the full `KORTIX_FS_S3_*` configuration is present.
- PostgreSQL is the fallback and self-host backend.
- Blob addresses are SHA-256 content hashes.
- File rows record their storage backend, so a configuration change does not
  make earlier content unreadable.
- Blob garbage collection is leader-elected and uses a grace period to avoid
  racing a metadata write.

| Surface | Contract |
|---|---|
| REST | seven `/v1/projects/:projectId/filesystems*` routes |
| SDK | `kortix.project(id).filesystems.*` |
| CLI | `kortix fs ls\|create\|rm\|list\|put\|get\|del` |
| Agent | the environment image carries `/usr/local/bin/kortix` |

## Verification gates

Local gates:

```bash
pnpm test
pnpm test -- --sdk-only
pnpm test -- --packages-only
pnpm --filter kortix-api typecheck
pnpm --filter @kortix/db typecheck
pnpm --filter @kortix/db db:check
bun test packages/db/scripts/pi-runtime-identity-migration.integration.test.ts
```

Deployed branch gates:

1. `GET https://pi.kortix.com/v1/health` reports the exact branch tip SHA.
2. A new Pi session streams assistant text before its environment is ready.
3. Bash, read, write, glob, and grep execute against the environment.
4. A second tool call reuses the environment.
5. Stop and resume recover both runtimes.
6. Runtime projection accepts the worker and rejects the environment.
7. Browser files, terminal, preview, and service URLs target the environment.
8. Shared filesystem create, put, get, list, delete, and tenant isolation pass.

## Deliberate exclusions

- Filesystem version history is a later feature.
- Transcript compaction is separate from durable message storage.
- Durable Objects are not required for the micro-VM implementation.
- Arbitrary custom in-process code can access its own worker process. The
  supported extension pattern uses SDK-backed remote tools.

## Release boundary

The branch can prove local and preview behavior. Dev and production verification
require an approved merge and the documented release process. This branch must
not merge itself.
