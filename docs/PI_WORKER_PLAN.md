# Pi worker implementation plan and status

- Branch: `pi-worker`
- Preview target: `https://pi.kortix.com`
- Architecture: [`PI_WORKER_ARCHITECTURE.md`](./PI_WORKER_ARCHITECTURE.md)
- Two-runtime audit: [`PI_P24_SCOPE.md`](./PI_P24_SCOPE.md)

This file records implementation scope in the canonical working tree. A phase
marked done is not deployment proof. See [the verification record](./PI_WORKER_VERIFICATION.md)
for committed source, exact preview SHAs, live checks, and remaining gaps.

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
| Lazy environment | text-only prompts leave compute off; the first workspace tool creates or resumes the full box |
| Durable transcript | append-only Pi entries and turn-admission transitions persist in PostgreSQL with stable wire identities |
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

`KORTIX_ENV_STARTUP` defaults to `lazy`. The first workspace tool starts or resumes
compute. Setting it to `prewarm` starts attachment when the model turn starts.
Concurrent tools join the same attach promise. A failed prewarm does not poison
the next ensure attempt. A live text-only prompt left the environment absent.

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

Environment RPC authorization can expire while the worker remains live. Fetch,
keep-alive, WebSocket upgrade, and established WebSocket calls classify a
pre-execution `401`. The worker then re-ensures the environment and retries once.
Cancellation replies and ambiguous mutation failures never enter this replay
path. Concurrent stale calls share one renewed client.

### P2.7 — every invocation source

Status: done.

All creation sources enter `createProjectSession`. Pi selection uses the
manifest's `kortix_version: 3` at the selected Git ref. Version 2 selects
OpenCode. An explicit runtime must match the version.
It does not inspect the invocation source. The same path covers the UI, API,
Slack, Teams, Telegram, email, triggers, schedules, and sub-agents.

A missing manifest or v1 manifest preserves OpenCode compatibility. Git, read,
parse, and invalid-runtime failures return
`409 PI_WORKER_RUNTIME_RESOLUTION_FAILED` before session persistence.

Selection produces one durable runtime identity. Pi overrides the requested
provider with Daytona and stores that effective provider with the immutable Git
ref and SHA. The create response, database row, audit attribution, and provider
request use that same provider. Restart and cold-open replacement rebuild from
the stored ref and SHA with the Pi-only environment. They fail closed when the
stored identity is incomplete or names another provider.

Pi replaces only the harness image. It preserves the resolved request, agent,
or project sandbox template as `environment_sandbox_slug`. The lazy compute
environment builds that template from the stored Pi commit SHA. A custom
Dockerfile, image, dependency set, and resource profile therefore remain part of
the compute runtime instead of being replaced by the platform default.

`pi-worker` is a server-owned sandbox slug. Session requests, custom-template
creation, manifest template declarations, manifest defaults, and per-agent
sandbox selectors cannot claim it. Authorization runs before these semantic
checks, so an unauthorized session-create request remains `403`.

The branch preview is the rollout boundary. No change on this branch merges or
deploys to dev without explicit approval.

### P2.8 — durable multi-worker turn ownership

Status: done locally.

The admission journal serializes accepted turns across workers. It enforces one
durable head, a globally sortable wire-message floor, and exact retry matching.
A started turn has one lease owner. Heartbeats, reclaim, Stop, and completion
use compare-and-append fences against the owner and revision.

The owner writes assistant metadata and terminal status in one `completed`
record. A replacement worker claims an unchanged expired lease. It records the
existing terminal result or branches before unsafe partial tool context and
adds one interruption. It never repeats the model or an unknown side effect.
Boot restores the Pi tree and journal from one log snapshot. Legacy pending
repair runs only after `started` commits, and its lane move uses the owner lease
fence. Lease-loss reconciliation removes rejected live output from both message
reads and connected event clients.

Stop is also durable. Any worker can request it. The owner acknowledges it only
after calling Pi abort. The HTTP route returns success only after that durable
acknowledgement or a terminal completion.

Prompt routes reject unsupported agent, model, part, and attachment fields.
They reject bodies larger than 512 KiB as soon as the limit is known. Benchmark
routes are unavailable when the worker runs with a project identity.

The web composer treats the compiled worker as immutable. It locks agent and
model selection for Pi sessions. It blocks unsupported context, file, image,
data URL, paste, and drop inputs. Prompt, command, and retry payloads omit stale
agent, model, and variant fields. Unsupported slash actions are hidden.

### P2.9 — OpenCode product compatibility

Status: in progress.

The architecture plan did not include a complete OpenCode replacement gate.
[`PI_OPENCODE_PARITY.md`](./PI_OPENCODE_PARITY.md) is now the executable
compatibility scorecard and release boundary.

The local worker implements the core session protocol, global SSE, Stop,
questions, permissions, project commands, project skills, and the six
environment-backed workspace tools. It exposes the selected compiled agent and
the effective built-in tool schemas through the installed OpenCode client. The
SDK routes workspace reads to the environment and conversation reads to the
worker.

Full compatibility is not complete. Durable blocking interactions, complete
command behavior, custom tools, plugins, hooks, MCP, subagents, todos,
compaction, rewind, forks, attachments, web tools, LSP, and parts of the agent
contract remain partial or missing. The branch cannot replace OpenCode until
the P0 rows in the scorecard are green on a branch preview.

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
pnpm --filter @kortix/worker test
pnpm --filter @kortix/worker typecheck
pnpm --filter @kortix/sdk run smoke:install
pnpm --filter kortix-api typecheck
pnpm --filter @kortix/db typecheck
pnpm --filter @kortix/db db:check
bun test packages/db/scripts/pi-runtime-identity-migration.integration.test.ts
```

Deployed branch gates:

1. `GET https://pi.kortix.com/v1/health` reports the exact branch tip SHA.
2. A new Pi session streams assistant text before its environment is ready.
3. Bash, read, write, edit, glob, and grep execute against the environment.
4. A second tool call reuses the environment.
5. Stop and resume recover both runtimes.
6. Runtime projection accepts the worker and rejects the environment.
7. Browser files, terminal, preview, and service URLs target the environment.
8. Shared filesystem create, put, get, list, delete, and tenant isolation pass.
9. Two workers preserve prompt order and expose the same durable status.
10. Stop sent to a non-owner reaches and is acknowledged by the owner.
11. A replacement worker resolves an expired started turn without rerunning it.

Current delivery status:

| Gate | Status |
|---|---|
| Local implementation and focused suites | done |
| Full repository suite at the current branch tip | in progress |
| Draft pull request | open |
| Branch preview stack | `0ea36cfd55` deployed; compatibility working tree pending commit and redeploy |
| Preview target-full managed Git flows | blocked by managed Git repository credentials |
| Dev merge and deployment | requires explicit approval |

The preview GitHub App can write repository contents but cannot create a
managed repository. It needs repository Administration read/write permission.
Alternatively, a repository administrator can add a machine-owned fine-grained
token as `PREVIEW_MANAGED_GIT_GITHUB_TOKEN`. Personal user tokens from another
environment are not valid preview credentials and must not be copied.

## Deliberate exclusions

- Filesystem version history is a later feature.
- Rewind and restore require one durable mutation across Pi's model tree and
  the HTTP transcript. Pi sessions hide these controls. The raw endpoints
  return `501 feature_not_supported` without changing either state.
- Durable Objects are not required for the micro-VM implementation.
- Arbitrary custom in-process code can access its own worker process. The
  supported extension pattern uses SDK-backed remote tools.

## Release boundary

The branch can prove local and preview behavior. Dev and production verification
require an approved merge and the documented release process. This branch must
not merge itself.


## Current checkpoint — 2026-09-09

The remaining work continues on `pi-worker`; no merge is approved.

- Version 3 selects Pi without a feature flag. Version 2 selects OpenCode.
- The Pi environment boots an execution-only daemon. Files, Git, PTY, and
  previews have no OpenCode process dependency.
- Environment recovery preserves working files and the selected branch.
- The provider bootstrap verifies artifacts and uses an execution-capable fallback.
- Local proof: real daemon boot, provider-bootstrap process, dirty-workspace
  recovery, authenticated workspace routes, negative readiness, and version selection.
- The deployed proof verifies zero Pi and OpenCode servers in the environment,
  unchanged working files, and history while both sandboxes are stopped.
- Custom per-agent code, hooks, questions, permissions, streaming, images,
  compaction, reasoning variants, structured output, and connector tools are
  implemented. See the capability matrix for exact verification and limits.
- The same-environment Pi/OpenCode benchmark has 60 passing samples; worker
  mode is restored. The full three-path lifecycle benchmark remains open.
- Continue the missing capabilities and host checks in `PI_OPENCODE_PARITY.md`.
