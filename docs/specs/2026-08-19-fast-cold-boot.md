# Fast cold boot experiment

Status: staged for a two-rollout dev upgrade behind
`KORTIX_FAST_COLD_BOOT_ENABLED`.

## Problem

A five-session dev sample on 2026-08-20 measured repository materialization at
7,983 ms p50 and 17,251 ms p90. The sandbox image already contains the canonical
starter repository at `/opt/kortix/scaffold.git`, but the API did not send the
fresh-session or base-tip hints that activate its local fast path.

The daemon therefore performed two avoidable network operations:

1. It fetched clone credentials from the API.
2. It fetched the fresh session branch after repository materialization.

For a project whose base tip equals the baked scaffold, it also performed an
unnecessary Git negotiation for zero objects.

Managed projects normally have one customization commit above the deterministic
scaffold. The base-tip equality check cannot remove that project's fetch.

## Design

When `KORTIX_FAST_COLD_BOOT_ENABLED=true`, the API sends these hints for a new
branch workspace:

- `KORTIX_SESSION_FRESH=1`
- `KORTIX_BASE_SHA=<server-resolved base tip>` when SHA resolution completes
  within its existing two-second deadline
- `KORTIX_GIT_DELTA_BUNDLE_BASE64=<bounded exact commit bundle>` when the base
  tip is one commit above its parent and the encoded bundle is at most 24 KiB
- `KORTIX_GIT_DELTA_PARENT_SHA=<bundle prerequisite commit>` and
  `KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64=<raw prerequisite commit>` when the
  storage provider rewrites the scaffold commit metadata

The same flag also enables stopped, content-addressed per-project images for the
shared default template. Each image adds the exact default-branch tip at
`/workspace`. A session that finds the active image skips repository cloning. A
missing, stale, building, failed, or unavailable image uses the current
shared-image and authenticated-clone path. The miss requests one deduplicated
background bake for a later session. Managed-git pushes request the same bake
without blocking the push. Cooldown, in-flight, recent-cluster, and capacity
gates can defer an optional build. In explicit FAST mode, a push prebuilds only
the project's enabled provider pin. An unpinned project waits for session
provider selection and then bakes only on that provider. The legacy WARM rollout
keeps its existing multi-provider fanout. Custom-template project images remain
available only through `KORTIX_WARM_SNAPSHOT_ENABLED=true`.

FAST writes use the 64-character identity
`kpp2-<data-plane12>-<project12>-<template16>-<content16>`. The data-plane key
derives from the normalized public Supabase endpoint and deployment environment.
It contains no credential. Reads check this scoped identity first, then the
existing template-scoped `kortix-ppwarm-*` identity, then the oldest
template-less identity for the shared default. This ordered fallback preserves
all active images during a rolling migration.

Every non-meta agent can use a project image when its workspace mode is
`branch` or the legacy unset mode. Meta agents and `read` or `runtime` workspace
modes continue to use the shared image. A Platinum external-template pin is used
only when its provider and snapshot name match the resolved image exactly. A
missing project image removes only that exact image, whether its name uses the
legacy `kortix-ppwarm-*` format or the scoped `kpp2-*` format. The API then
re-resolves and boots the intact shared base. Standard-image recovery keeps its
existing slug-based rebuild path.

After a managed project seed completes, the API stores the verified bundle in
`projects.metadata.git.fast_boot`. A later session validates the cached SHA
against the authoritative remote branch tip before it reuses the bundle. A
missing or stale entry starts a mirror refresh and preserves the authenticated
network fallback.

The cache is available to every API instance. The project serializer removes
the internal `fast_boot` field from provision, list, and detail responses.

The provider-specific parent payload makes the thin bundle portable across
identical scaffold trees with different commit metadata. The bundle and parent
payload share the existing 24 KiB limit. Cache version 2 invalidates earlier
entries that do not contain the parent payload.

Project-image misses and ineligible workloads continue to use the standard
sandbox image. The standard image
fingerprint includes `packages/starter`, because that directory produces the
baked `/opt/kortix/scaffold.git`. A starter change therefore forces a full image
rebuild. It cannot use the agent-only image swap. This keeps the baked scaffold
tree equal to the bundle prerequisite tree.

The API stages the pinned checkout outside the provider build. It scrubs Git
credentials, archives `.git` once, and removes the duplicate `.git` directory
from the staged working tree. The image extracts that archive directly into
`/workspace`; the final root filesystem contains no second tar copy. OpenCode
indexes the project tree during the build with the canonical Kortix config.
Repository-controlled `.kortix/opencode` plugins and tools remain hidden during
this build step. Git reset and clean restore the exact checkout afterward.

FAST builds reap only exact `kpp2` predecessors with the same data-plane,
project, and template keys. They never select unscoped or foreign-plane images.
Older API replicas do not recognize the `kpp2` prefix, so they cannot delete a
new scoped image during a rolling deployment. Daytona quota cleanup applies the
same ownership boundary and blocks every `ppwarm` deletion when the provider
view, template references, or active-pin lookup is incomplete.

Optional FAST builds also reserve provider capacity. Platinum reads the
authoritative organization template quota and keeps the greater of 10 slots or
10 percent of the cap free. Daytona performs a complete, deletion-free quota-GC
assessment before it admits a build. A failed or incomplete capacity check
skips only the optional image build. The session continues through the existing
shared-image path. E2B keeps its existing project-image behavior because it has
no shared hard-cap endpoint. Provider-transition builds bypass optional
admission so a routing change cannot lose an existing feature. Each API process
also permits only one optional FAST build per provider at a time. Provider
organizations span data planes, so this local semaphore is not the capacity
authority. It bounds the observe-then-build race by the number of live API
replicas while the provider reserve absorbs that bounded overlap.

Platinum now admits a template build through one control-plane transaction.
The transaction evaluates the current count and quota before it creates the
template. Concurrent API replicas cannot oversubscribe the reserved capacity
through separate list and create calls. The dev control plane serves this
contract from commit `d3741b01995e1b8b670d7047e2cb46d2ef0a01b6`.

Activation re-reads the project before it publishes an image pin. An archived
project cannot acquire a new pin after an in-flight build completes. Archived
pins do not block later garbage collection. A failed build-history read blocks
predecessor deletion. A failed build always cleans its staged context. These
rules make build, archive, and cleanup races fail closed.

The daemon uses the hints as follows:

- A matching scaffold and base tip materialize from local disk.
- A one-commit managed-project tip imports from the API mirror bundle and must
  resolve to `KORTIX_BASE_SHA` before checkout.
- A new session branch is created locally from base.
- Clone credentials resolve only if a network fetch is required.
- A missing SHA, a different base tip, an imported repository, or a local
  scaffold failure uses the existing shallow-clone fallback.
- In-place restarts keep the existing workspace and branch behavior.
- Replacement project-image boots restore the remote session branch once.
- A transient restore fetch fails closed. It never adopts a base-only local
  branch that could hide remote session commits.
- A genuinely absent remote session branch keeps the existing local-branch
  fallback.

The bundle is transported with the sandbox creation environment. The daemon
recomputes the parent commit SHA before it writes the object. It also verifies
that the parent tree already exists in the baked scaffold. The daemon then
validates the bundle, imports it, and verifies the resulting base SHA. Any
validation failure uses the authenticated fetch path.

This design creates no sandbox pool. The per-project image uses `capture: none`.
It contains no running VM, memory state, or live OpenCode process. It requires no
schema migration. It changes no Git history or push behavior.

## Rollback

Set `KORTIX_FAST_COLD_BOOT_ENABLED=false` to disable the experiment for normal
sessions. It stops project-image selection, session-driven bakes, managed-push
bakes, and FAST cleanup. This explicit value overrides
`KORTIX_WARM_SNAPSHOT_ENABLED=true`. When the FAST flag is absent, the legacy
WARM flag preserves its prior behavior. Provider-transition preparation remains
active while the flag is `false`. It consumes provider capacity because an
in-flight routing change must retain its existing behavior. The daemon uses the
previous shared-image and network-clone path for normal sessions after rollback.
Existing content-addressed images remain inert. Provider-specific maintenance
can remove them later. FAST rollback does not run an unsafe provider-wide
deletion.

The API also omits `KORTIX_OPENCODE_BINARY_PREFETCH` when FAST is disabled. The
daemon then keeps the legacy root-resolution behavior, including a full
five-second timeout for an HTTP request started before the 20-second polling
boundary. The strict polling boundary applies only to the FAST path.

Deploy a naming-format change with the flag set to `false`. Wait until every API
replica runs the same task definition and image digest. Require every replica to
log the same structured `[snapshots] project image rollout` scope. Enable the
same flag in a second rollout. This prevents old and new replicas from creating
different provider-transition identities during one mixed-version deployment.

## Verification

The sandbox regression test materialized an exact scaffold-plus-bundle checkout
in 79 ms. It observed zero clone-credential requests and verified the resulting
branch, content, and commit. The current managed starter's bundle stays below
the 24 KiB delivery cap.

The dev deployment for PR #6650 served merge commit
`de015e17510d52af2165e31a8c9dbf7c69923429`. One image warm-up was excluded,
then five new Platinum sessions ran with `warm_sessions=false` against a new
`general-knowledge-worker` project.

| Milestone | Before | After | Change |
| --- | ---: | ---: | ---: |
| Repository materialized, p50 | 7,983 ms | 265 ms | -96.7% |
| Runtime ready, p50 | 25,000 ms | 18,348 ms | -26.6% |

Three of five sessions imported the bundle and materialized the repository in
257-265 ms. Two sessions exceeded the API's two-second mirror deadline and used
the existing network fallback in 4,910-5,313 ms. The fallback preserved
correctness.

PR #6652 persisted the verified bundle before the first session. Deploy Dev run
`32366930298` deployed merge commit
`9865b3bd6604e26e99acdda9f63f821c71906d88`. Dev health reported that exact
commit. One image warm-up was excluded, then five new Platinum sessions ran with
`warm_sessions=false` against a new `general-knowledge-worker` project.

| Milestone | Before durable cache | After durable cache | Change |
| --- | ---: | ---: | ---: |
| Repository materialized, p50 | 265 ms | 258 ms | -2.6% |
| Repository materialized, max | 5,313 ms | 260 ms | -95.1% |
| Runtime ready, p50 | 18,348 ms | 17,813 ms | -2.9% |
| Runtime ready, max | 24,382 ms | 20,618 ms | -15.4% |

All five sessions imported the bundle. Repository materialization measured
255-260 ms. A separate managed-project provision completed in 10,487 ms. Its
`201` provision response and `200` detail response did not expose `fast_boot`.

PR #6674 fixed a later regression in the standard image fingerprint. The
non-agent fingerprint excluded `packages/starter`, so an agent-only image swap
could reuse a stale `/opt/kortix/scaffold.git`. The API delivered the correct
provider parent commit, but its tree was absent from that stale scaffold. The
daemon correctly used the authenticated network fallback.

The API deploy job in Deploy Dev run `32398509102` deployed merge commit
`53bc3d24cec692a38226feb3cbda2f28dd918938`. Dev health reported that exact
commit. One image warm-up was excluded. Five new Platinum sessions then ran
with `warm_sessions=false` against a new `general-knowledge-worker` project.

| Milestone | Stale standard image | Corrected standard image | Change |
| --- | ---: | ---: | ---: |
| Repository materialized, p50 | 6,514 ms | 264 ms | -96.0% |
| Repository materialized, max | 10,239 ms | 266 ms | -97.4% |
| OpenCode ready, p50 | 17,034 ms | 10,077 ms | -40.8% |
| Runtime ready, p50 | 27,831 ms | 23,471 ms | -15.7% |

All five sessions used the local bundle path. Repository materialization
measured 261-266 ms. Runtime readiness measured 18,995-33,147 ms. OpenCode is
now the largest in-guest phase at 9,854-10,222 ms after daemon start.

## Isolated lifecycle verification on 2026-08-21

The final isolated Platinum run used one project and two sessions. The first
session booted from the shared image. Its miss built the project image in the
background. The second session booted from that exact image.

| Milestone | Shared image | Project image | Change |
| --- | ---: | ---: | ---: |
| Session create API | 1,231 ms | 1,123 ms | -108 ms |
| Provider create | 3,770 ms | 4,727 ms | +957 ms |
| Repository materialized | 313 ms | 174 ms | -139 ms |
| Runtime ready | 15,319 ms | 13,438 ms | -1,881 ms |

The project-image build took 222,228 ms outside the first session's critical
path. The pair saved 1,881 ms in runtime readiness. Provider and OpenCode
variance dominated the result, so this pair is evidence of correctness, not a
stable latency estimate.

Both sessions passed the same runtime contract:

- The repository had the exact branch, clean status, and valid object graph.
- The configured agent, tool, OpenCode config, and MCP config were present.
- The project secret reached the session without entering the Git remote URL.
- The OpenCode REST session endpoint returned `200`.

An in-place stop and start kept the same external sandbox identity. It became
ready in 3,667 ms. A committed file, a dirty file, and the session branch all
survived. A forced provider deletion followed by `/restart` returned `409`
`SESSION_RUNTIME_IDENTITY_UNAVAILABLE`. It preserved the original identity and
did not create a replacement sandbox. Cleanup removed both sandboxes, the exact
project image, the project, and the test user.

The final automated gates on this branch produced these results:

- API: 8,186 passed, 78 skipped, 0 failed across 703 files.
- Sandbox daemon: 837 passed, 0 failed across 67 files.
- Daemon Linux build: 95,676,544 bytes for `bun-linux-x64`.
- API route coverage: 587 of 599 routes covered, 12 allowlisted, 0 uncovered.
- Project-image lifecycle and transition tests: 40 passed, 0 failed.
- Session metadata contract: 70 passed, 0 failed. Reserved runtime routing
  fields cannot be changed through the metadata PATCH route.

## OpenCode root readiness

A five-boot probe measured process spawn to session-API readiness at
4.397-4.537 seconds, with a 4.4804-second mean. The successful session-API probe
then preceded the first root list by 2,185 ms on average and 2,155 ms at the
median. FAST mode now waits up to five seconds for that real probe before it
starts root resolution. Gate time is deducted from the existing 20-second
budget. A hanging request cannot extend that budget.

Readiness is scoped to the active OpenCode process. It survives planned
restarts, unplanned exits, respawn backoff, asynchronous spawn failures, and
verified port promotion. The callback still reports only the first ready mark.
The disabled path keeps the previous request and retry timing.

The OpenCode change has not yet received a post-deploy live A/B measurement.

## Dev rollout gates

The first deployment uses the automatic `main` push. This path always injects
`KORTIX_FAST_COLD_BOOT_ENABLED=false`.

1. Require the Deploy Dev job to reach `services-stable`. Require its reported
   running count to equal its desired count. Require the rollout state to be
   `COMPLETED`.
2. Require the `commit` field from `https://dev-api.kortix.com/v1/health` to
   equal the PR merge SHA.
3. List every running task in the `kortix-dev` service and cluster. Require one
   task definition revision and one API image digest across the complete list.
4. Inspect `/ecs/kortix-dev`. Require one startup rollout diagnostic for every
   running task. Every diagnostic must contain `fastConfigured=true`,
   `fastEnabled=false`, `formatVersion=kpp2`, and the same nonempty
   `projectImageScope`.
5. Read `/v1/runtime-assets/manifest` with dev authentication. Record the
   immutable agent `version` and `sha256`. The manifest does not guarantee a
   daemon source SHA, so it is not merge-SHA evidence.

Activate the second rollout only after all five checks pass:

```sh
gh workflow run deploy-dev.yml --ref main \
  -f surface=all \
  -f enable_fast_cold_boot=true
```

The workflow rejects activation unless `surface=all`. Repeat the complete task,
image, health, manifest, and startup-log checks. The startup diagnostics must now
contain `fastEnabled=true`.

Run 10 shared-image sessions and 10 exact project-image sessions in sequential,
alternating order. Do not keep a sandbox pool. Accept the rollout only when all
of these conditions hold:

- All 20 sessions pass the branch, content, object-graph, agent, tool, OpenCode
  config, MCP config, secret, remote-credential, and OpenCode REST contracts.
- Project-image repository materialization has a median of at most 300 ms.
- Project-image runtime readiness improves by at least 1,000 ms at the median.
- Project-image runtime-readiness p90 is no more than 10 percent slower than the
  shared-image p90.
- The controlled sample has zero unexpected session-create or restart errors.
- Free provider template capacity never falls below the greater of 10 slots or
  10 percent of quota.
- Logs show zero foreign-plane or unscoped project-image deletions.

Rollback immediately after any contract failure, sandbox identity replacement,
capacity-reserve breach, foreign-plane deletion, unexpected controlled-session
error, or latency-threshold failure:

```sh
gh workflow run deploy-dev.yml --ref main \
  -f surface=all \
  -f enable_fast_cold_boot=false
```

After rollback, repeat the all-task and startup-log checks. Require
`fastEnabled=false` on every replica. Provider-transition preparation can still
run, but normal sessions cannot select or build a project image.
