# Session boot — 1-second threshold gap analysis + attack sequence

> Goal §1: *Performance: Kortix minimal harness + session boot optimization —
> **1-second threshold**.* This doc is the grounded scoping step before any
> code: where are we today, what's the 1s target, and what's the attack
> sequence to close the gap.
>
> Status: SCOPING (Mirko AGI cycle 25, 2026-07-19). No code changes yet.

## Current boot path — instrumented stages

The sandbox-agent-server (`apps/kortix-sandbox-agent-server/src/main.ts`)
records a `BootMark[]` timeline (ms since process start) on every boot,
exposed via the `/health` route (`apps/kortix-sandbox-agent-server/src/routes/health.ts`).
The stages, in order:

| # | Stage label | What happens | Cold vs warm |
|---|---|---|---|
| 1 | `static-web` | Static web server bound | Always |
| 2 | `git-identity` | Git identity configured for repo materialization | Always |
| 3 | `repo-materialized` | Project repo cloned/seeded into the sandbox | Cold: full clone; warm: snapshot restore |
| 4 | `config-deps` | OpenCode config deps installed (`/opt/kortix/opencode-config-deps`) | Cold: install; warm: pre-installed |
| 5 | `opencode-spawned` | OpenCode process spawned | Always (spawn cost) |
| 6 | `proxy-up` | Kortix proxy server (LLM + executor) up | Always |
| 7 | `opencode-ready` | OpenCode reports ready (config loaded, providers initialized) | Always (OpenCode's own boot) |
| 8 | `opencode-session-created` | First OpenCode conversation created (UI-usable) | If `initialOpenCodeSessionRequired` |

In **warm-seed mode** (the fast path), stages run in parallel branches:
`seed-project-materialized` / `seed-scaffold-materialized` → `seed-llm-proxy-started`
→ `seed-executor-proxy-started` → `seed-opencode-spawned` → `seed-proxy-ready`
→ `seed-opencode-ready` → `seed-opencode-session`, then adoption:
`adopt-repo-materialized` → `adopt-gateway-catalog-refreshed` →
`adopt-opencode-hotswapped` → `adopt-executor-proxy-ready` →
`adopt-opencode-restarted`.

## Existing boot-acceleration infrastructure (already built)

- **Warm snapshots** (`apps/api/src/snapshots/builder.ts`,
  `apps/api/src/snapshots/ppwarm-names.ts`): content-addressed snapshots
  pre-baked so sessions boot from a memory-state restore instead of a cold
  build. `apps/api/scripts/bench-session-boot.ts` measures the live
  `create → runtime ready` path.
- **Per-project warm images** (`ppwarm`): per-project pre-baked snapshots
  (`perProjectWarmImageName`), reaped when stale (`ppwarmReapTargets`).
- **Template prebuilds** (`apps/api/src/snapshots/templates.ts`,
  `kickProjectTemplatePrebuilds`): pre-build templates so the first session
  boots from cache. Refresh at most once per interval ("every session boot is
  pure dead time" if we refresh every time — `templates.ts:182`).
- **Long-poll readiness** (`apps/api/src/projects/session-lifecycle/await-stage.ts`):
  server-side bounded wait so the client learns `ready` the instant it flips,
  not on its ~800ms poll tick. Cap well under the 30s web request timeout.
- **Session-lifecycle engine** (`apps/api/src/projects/session-lifecycle/engine.ts`):
  stages a session through `pending → ready`, with a delivery deadline.

## The 1-second threshold — what it means

"1-second threshold" = from the moment the API receives `startSession` to the
moment the sandbox is **runtime-ready** (OpenCode booted, proxy up, can accept
a first agent turn). NOT the time to first token (that's LLM TTFT, separate).
NOT the time to UI-usable (that includes `opencode-session-created`, which is
a UI concern).

The 1s target is aggressive but not arbitrary: it's the threshold below which
a session feels instant to a user (below the ~1s "flow" perception boundary).
Cold-boot today is likely **seconds to tens of seconds** (full clone + deps
install + OpenCode spawn + init). Warm-boot (snapshot restore) is the path
that can plausibly hit 1s.

## Gap analysis — what stands between today and 1s

### Known costs in the warm path (the path that can hit 1s)

1. **Snapshot restore** (stage 3 equivalent) — Daytona/Platinum restores a
   memory-state snapshot. Provider-side cost; we don't control it directly,
   only the snapshot size/content. **Unknown: actual restore time.** First
   thing to measure.
2. **OpenCode spawn + boot** (stages 5-7) — OpenCode is a real process with
   config loading, provider initialization, MCP server startup. This is likely
   the **dominant cost** in the warm path (hundreds of ms to seconds).
   **Unknown: actual OpenCode boot time on a warm snapshot.** Second thing to
   measure.
3. **Proxy up** (stage 6) — Kortix's own LLM + executor proxy. Should be fast
   (in-process Hono server) but has startup work (gateway catalog refresh,
   executor proxy bind). **Likely <100ms** but unmeasured.
4. **Repo materialization** (stage 3) — in warm mode this is a snapshot
   restore (fast); in cold mode it's a full `git clone` (slow, seconds). The
   warm path sidesteps this.
5. **Network round-trips** — the API → sandbox provider → sandbox → API
   callback chain. Each hop is latency. Platinum (Kortix's own microVM) may
   have lower latency than Daytona (external).

### What we DON'T know (and must measure before optimizing)

- **Actual boot timeline numbers** per stage, on warm vs cold, on Daytona vs
  Platinum. The `BootMark[]` is recorded but we have no published benchmarks.
- **P50/P95/P99 distribution** — 1s must be P95 at minimum to feel instant;
  P50 isn't enough.
- **Provider-side snapshot restore latency** — the biggest variable we don't
  control.
- **OpenCode boot breakdown** — what % is config load vs provider init vs MCP
  startup? (OpenCode is third-party; we may need to upstream optimizations or
  pre-warm its state in the snapshot.)

## Attack sequence (proposed, pending measurement)

**Phase 0 — Measure (must come first).** Build a benchmark harness that:
- Boots N sessions (cold + warm, Daytona + Platinum), records the full
  `BootMark[]` timeline per boot.
- Aggregates P50/P95/P99 per stage + total.
- Surfaces the dominant cost(s).
- Runs on a schedule (nightly) so regressions are caught.
The `apps/api/scripts/bench-session-boot.ts` harness records the live
`create → runtime ready` path. Extend its coverage when a new provider or
boot stage lands. **Output: a numbers table. No optimization blind.**

**Phase 1 — Eliminate the dominant cost.** Based on Phase 0's numbers, attack
the stage that dominates the warm-boot P95. Likely candidates:
- If OpenCode boot dominates: pre-bake OpenCode's initialized state into the
  warm snapshot (snapshot is taken AFTER `opencode-ready`, not before — verify
  this is already the case in `warm-bake.ts`).
- If snapshot restore dominates: minimize snapshot size; work with the
  Platinum team on restore-time optimization; consider a warm-pool of
  pre-restored sandboxes (keep N hot, hand one out on session start).
- If repo materialization dominates even in warm mode: the snapshot must
  include the repo already cloned (verify the seed path does this).

**Phase 2 — Parallelize the rest.** Stages that can run concurrently (e.g.,
`proxy-up` doesn't depend on `opencode-spawned`) should. The warm-seed mode
already does some of this (seed + adoption branches); verify no serial
bottleneck remains.

**Phase 3 — Pre-warm pool.** If a single warm boot can't hit 1s (provider
restore latency floor), keep a pool of N pre-booted sandboxes per project
template; hand one out on session start (swap the project repo in via the
adoption path). This turns boot into "already booted, just adopt" — sub-100ms.
The `seed` + `adopt` infrastructure already exists; a pool is the natural
extension.

**Phase 4 — Regression gate.** Add a boot-time assertion to CI: `P95 warm
boot < 1s` on a representative template. The `BootMark[]` timeline makes this
mechanical. Block PRs that regress it.

## What I need from a human before code

- **Confirm the 1s target is warm-boot P95** (not cold, not P50) — this doc
  assumes so but the goal statement doesn't specify.
- **Confirm Platinum is in scope** as the provider that can plausibly hit 1s
  (Daytona's external restore latency may be a floor we can't break).
- **Bless the measurement-first approach** (Phase 0) — no optimization blind.
- **Point at any existing internal benchmarks** I missed (I searched the repo;
  the `BootMark[]` infra exists but I found no published numbers).

## Scope of this doc

Grounded entirely in the current codebase: `apps/kortix-sandbox-agent-server/src/main.ts`
(boot path + stages), `apps/kortix-sandbox-agent-server/src/routes/health.ts`
(`BootMark` type), `apps/api/scripts/bench-session-boot.ts` (live boot
benchmark), `apps/api/src/snapshots/` (builder + templates + ppwarm),
`apps/api/src/projects/session-lifecycle/` (engine + await-stage). No
hallucinated infrastructure — every cited file/stage verified to exist.
