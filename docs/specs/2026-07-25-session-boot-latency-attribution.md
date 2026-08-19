# Session boot latency — measured attribution (Platinum vs Daytona)

> Phase 0 of `2026-07-19-session-boot-1s-threshold.md`, executed. That doc listed
> every unknown and said "no optimization blind". This fills the table with
> **measured production numbers**, from a live benchmark plus 14 days of
> telemetry, and names the fixes with the win attached to each.
>
> Measured 2026-07-25 against production (`api.kortix.com`).
> Harness: `apps/api/scripts/bench-boot-attribution.ts` (added for this).

## What the phases actually mean

Boot is strictly serial across two machines. Nothing in phase N+1 starts before
phase N finishes.

| Phase | Runs on | From → to |
|---|---|---|
| **API create** | api.kortix.com | `POST /sessions` → HTTP response. DB row, session tokens, git branch push. |
| **Host → VM running** | api.kortix.com → provider | `provider.create()` → provider hands back a **booted VM**. Daytona container / Platinum microVM. Ends when `session_sandboxes.external_id` lands. |
| **In-guest boot** | *inside* the sandbox | The `kortix-sandbox-agent-server` daemon's own boot: clone the repo, install config deps, spawn opencode, wait for opencode, create the first conversation. Ends at `runtimeReady`. |

"In-guest" is everything after we have a running VM — the work *our daemon does
inside it*. That is where ~75% of the wall clock is.

## Live benchmark — 4 boots per provider, production

`math-god` (Daytona, 15.8 MB repo) and `Kortix Company` (Platinum, 6.5 MB repo),
run concurrently so both saw comparable control-plane load.

### Cumulative — t0 = `POST /sessions`

| Milestone | Daytona p50 | Platinum p50 |
|---|---:|---:|
| API create returns | 715 ms | 244 ms |
| **VM running** (`external_id` set) | 2 467 ms | 4 701 ms |
| row → `active` | 2 467 ms | 4 701 ms |
| daemon first answers `/kortix/health` | 13 631 ms | 12 995 ms |
| **RUNTIME READY** | **18 902 ms** | **24 476 ms** |
| worst of 4 | 21 535 ms | 35 977 ms |

### In-guest stages (per-stage cost, from the daemon's own `boot_timeline`)

| Stage | Daytona p50 | Platinum p50 |
|---|---:|---:|
| `static-web` | 5 ms | 20 ms |
| `git-identity` | 14 ms | 43 ms |
| **`repo-materialized`** (git clone) | **6 686 ms** (p90 9 021) | **7 229 ms** (p90 17 125) |
| `config-deps` | 3 ms | 3 ms |
| `opencode-spawned` | 40 ms | 119 ms |
| `proxy-up` | 3 ms | 6 ms |
| **`opencode-session-created`** | **4 730 ms** | **12 066 ms** |
| `opencode-ready` | 0 ms | 0 ms |

### Host stages

| Stage | Daytona p50 | Platinum p50 |
|---|---:|---:|
| `row+tokens` | 258 ms | 222 ms |
| `image-cached` | 3 ms | 3 ms |
| **`provider-create`** | **1 090 ms** | **3 428 ms** |

Two stages are ~95% of the total. Everything else is under 130 ms.

Backed by 14 days of `kortix.provider_events` (4 273 Daytona / 285 Platinum
provisions), whose host-side p50s — 1 151 ms / 3 526 ms `provider-create` — match
the live run closely.

## Finding 1 — the clone is the biggest cost, and it is dominated by the git proxy, not by history

> **Correction.** An earlier revision of this doc claimed `--depth 1` was 22×
> faster (4 288 ms → 191 ms). That 191 ms was a **failed** clone — the run had no
> credential and produced no working tree. Re-measured properly below. Shallow is
> a real but modest win; the actual dominant cost is elsewhere. Every number in
> this section is from a clone that was verified to have produced a working tree
> and the expected commit count.

Same repo (`kortix-ai/company`), verified clones:

| Path | Strategy | Time | Result |
|---|---|---:|---|
| direct → GitHub | full | 5 462 ms | 27 MB, 758 commits |
| direct → GitHub | `--depth 1` | **3 516 ms** | 25 MB, 1 commit |
| **via Kortix git proxy** | full | 7 209 ms | 27 MB, 758 commits |
| **via Kortix git proxy** | `--depth 1` | **6 690 ms** | 25 MB, 1 commit |

Two things fall out, and both contradict the obvious story:

**1. History is not the payload — the working tree is.** Dropping 757 commits
saves 2 MB of a 27 MB clone. `--depth 1` buys ~1.5× (1.9 s direct, 0.5 s
proxied), not an order of magnitude. No depth setting can remove the 25 MB tree.

**2. The proxy costs more than the history does.** Identical depth-1 clone:
3 516 ms direct vs 6 690 ms proxied — the proxy adds **~3.2 s**. It is not
per-request overhead: `GET /info/refs` through the proxy is ~0.45 s, the same as
GitHub direct. The cost is in streaming the pack itself.

The likely reason is geography. Prod runs `KORTIX_URL=https://api.kortix.com`
(ECS, **eu-west-2**) with `DAYTONA_TARGET=us` and `KORTIX_GIT_PROXY=true`, so a
US sandbox cloning a US-hosted GitHub repo pulls **every byte across the Atlantic
twice** — sandbox(US) → API(EU) → GitHub(US) and back. That triangle, not git, is
what makes a 25 MB clone take ~7 s in-guest.

Shallow is still worth shipping (it is free and strictly positive), but the two
changes that would actually collapse this cost are:

- **Terminate the git path near the sandbox** — a region-local proxy/cache, or
  handing the sandbox a scoped credential so the pack streams GitHub→sandbox
  directly. The proxy exists so a real host credential never lands in the
  sandbox, so this is a security trade to make deliberately, not silently.
- **Bake the repo into the image** — which is exactly what warm images do, and
  which is the only option that takes the clone to zero. See Finding 5; this
  raises the priority of the `isShared` gate considerably.

The blobless filter (`blob:none`) remains the wrong tool: measured 6 161 ms —
slower than a full clone — on top of the lazy-fetch stalls that made us disable
it in the first place.

### Tested and NOT demonstrated — clone durability settings

A boot clone is throwaway (a failure re-clones), so `core.fsync=none` +
`gc.auto=0` should in principle help — no durability requirement, and an
opportunistic gc mid-boot is pure waste. Measured on `kortix-ai/company`,
`--depth 1`, 3 runs each, every clone verified `rc=0` with `commits=1`:

| | avg | range |
|---|---:|---|
| baseline | 4 023 ms | 3 181 – 5 423 ms |
| `core.fsync=none -c gc.auto=0` | 3 526 ms | 2 999 – 4 283 ms |

The ranges overlap heavily (baseline's best beats the variant's worst), so the
~12% apparent gain is **not resolvable** — this clone is network-dominated on an
SSD host. It may matter more on Platinum's virtio disk, but that cannot be
measured from outside the guest. **Deliberately not shipped**: the honest read is
"no evidence", and shipping it as a perf win would repeat the retracted-22×
mistake. Retest in-guest once #7's persisted timeline makes `repo-materialized`
comparable across boots.

### Also checked and refuted — HOME mismatch between bake and runtime

If the daemon ran opencode under a different HOME than the bake warmed
(`/home/kortix`), the baked state would be invisible and every boot would pay a
partial cold start — which would neatly explain the residual. It does not:
`apps/sandbox/entrypoint.sh` re-execs as `kortix` with `HOME=/home/kortix`
whenever it starts as root (via `setpriv`, falling back to `sudo -u`), and
backfills `HOME=/home/kortix` when HOME is `/`. `OPENCODE_HOME = homedir()` then
resolves to the same path the warmup baked under.

## Finding 2 — the daemon serves nothing until the clone is done

`daemon-reachable` p50 is **13 s**, while the VM has existed since 2.5 s
(Daytona) / 4.7 s (Platinum). For ~9 s the sandbox is up and answering nothing.

`main.ts` boots in this order:

```
143  await repoMaterializePromise      ← the 7 s clone
155  ensureOpencodeConfigDeps
175  await opencode.start()
186  startProxy(...)                   ← /kortix/health binds HERE
```

The HTTP server — including health — binds **after** the clone and after the
opencode spawn. The proxy already returns a clean 503 when opencode isn't ready
(`proxy.ts:252`), so there is no reason for it to wait. Consequences:

- The API and frontend are blind for 9+ s and cannot show real progress.
- Every readiness poll in that window is a wasted round-trip against a dead port.
- Any future "harvest the boot timeline" hook cannot fire until it's nearly over.

Pure ordering fix. It does not by itself cut time-to-ready, but it is the
prerequisite for measuring and for showing honest progress.

## Finding 3a — opencode's cold start is a ONE-TIME, HOME-SCOPED init that the image already bakes

Measured directly against the pinned opencode binary (not inferred):

| Scenario | port listening | `GET /session` 200 | `POST /session` |
|---|---:|---:|---:|
| **fresh HOME (cold)** | 2 443 ms | **21 086 ms** | 366 ms |
| warm HOME, same directory | 1 951 ms | 2 302 ms | 365 ms |
| warm HOME, **different** directory | 995 ms | 1 463 ms | 395 ms |

The ~18.6 s is **not per-directory work** — warming it makes a *different*
checkout fast too. It is one-time, HOME-scoped state. Creating the session is
~370 ms; it is not the cost.

This is already handled: `apps/sandbox/opencode-warmup.sh` runs a real opencode
instance at bake time under `HOME=/home/kortix`, which matches the runtime HOME.
`templates.ts`'s own layer history records the win — *v10: "6–60s → ~2–4s cold
start"*. That is why production sees 4.7–12.0 s and not 21 s.

Two hypotheses tested and **refuted**, recorded so they are not re-run:

- **Catalog size is irrelevant.** 20 models vs 5 699 (4 KB vs 1.1 MB of
  `OPENCODE_CONFIG`): `GET /session` 200 at 1 118 ms vs 1 208 ms.
- **The `@opencode-ai/plugin` version is in sync**, so the known 5–8 s
  network re-fetch (`templates.ts` layer *v15*) is NOT firing:
  `runtime-versions.json` pins `opencode: 1.17.11`, the starter pins the same,
  and `dockerfile-layer.ts:632` writes the config-deps `package.json` with
  `"@opencode-ai/plugin":"${opencodeVersion}"` by construction.

**What remains unexplained:** a warm opencode is ~1.5 s on a laptop but 4.7 s
(Daytona) / 12.0 s (Platinum) in production. The uniform ~3× Platinum penalty on
stages with nothing to wait on (`static-web` 5→19 ms, `git-identity` 13→44 ms) at
an identical 2-vCPU spec says the guest CPU is simply slower. Whether the residual
is *purely* CPU or partly ineffective baking is **not yet proven** — it needs the
persisted guest timeline (see below). Do not optimize it blind.

### Why the vCPU default was NOT raised

Bumping `KORTIX_DEFAULT_SANDBOX_CPU` 2 → 4 is the obvious lever on a CPU-bound
boot, and it was implemented and then **reverted**. Per-core-second billing makes
it cost-neutral *for the boot seconds only*; across a whole session it is a real
increase, because most session wall-clock is spent waiting on LLM tokens, not
burning CPU:

| Spec | Cost |
|---|---:|
| 2 vCPU / 4 GiB / 20 GiB | **$0.201/hr** |
| 4 vCPU / 4 GiB / 20 GiB | **$0.322/hr** (+60%) |

It would also falsify user-facing copy in four places that state "2 vCPU … about
$0.20/hour" (`pricing/page.tsx` ×2, `compute-credit-calculator.tsx`,
`content/docs/work/runtime.mdx`). It remains available per-deployment via the env
var, but it is a pricing decision, not a perf tweak.

## Finding 3 — opencode's cold start is serialized behind the clone

`opencode-session-created` is 4 730 ms (Daytona) / **12 066 ms (Platinum)**.

That mark is *not* the cost of creating a session. Measured against already-warm
production boxes, through the full public path (laptop → api.kortix.com →
provider edge → sandbox): **`GET /session` p50 = 575 ms (Daytona) / 523 ms
(Platinum)**, and in-guest it is a localhost call. So the HTTP work is
sub-second; the 4.7–12 s is **opencode's own cold start** — Bun runtime boot,
config load, provider init, and its per-directory project init (git scan, file
index, LSP, sqlite).

And it cannot overlap the clone. `main.ts:115-125` spawns opencode only after
the clone because `OPENCODE_CONFIG_DIR` is fixed at spawn time and the config dir
lives *inside the repo* at `<workspace>/.kortix/opencode`. So we pay
`clone (7 s) → opencode cold start (5–12 s)` end to end, when the two are almost
entirely independent.

`opencode-ready` fires **+0 ms** after `opencode-session-created`: runtime-ready
is gated on the initial *conversation* existing, not on opencode being usable.

## Finding 4 — Platinum is slower at every layer

| | Daytona | Platinum | |
|---|---:|---:|---|
| `provider-create` (live) | 1 090 ms | 3 428 ms | **3.1×** |
| `provider-create` (14 d p50) | 1 151 ms | 3 526 ms | **3.1×** |
| `opencode-session-created` | 4 730 ms | 12 066 ms | **2.6×** |
| `static-web` / `git-identity` | 5 / 14 ms | 20 / 43 ms | ~3× |

Platinum's create time is remarkably *consistent* (4 581–4 771 ms cumulative
across all 4 boots) — a fixed cost, not contention. The `platinum.ts:236-244`
comment claiming create returns in ~1 s describes the **removed** stateful-restore
path, not what runs today.

The uniform ~3× on trivial in-guest stages (`static-web`, `git-identity` — pure
CPU/syscall work) says the Platinum guest is simply slower per unit of work. That
is a host/guest-spec question for the Platinum team, not an application fix.

## Finding 5 — warm images are enabled, and never hit for these projects

They are not disabled. `KORTIX_WARM_SNAPSHOT_ENABLED` is on in prod (14 days:
2 781 Daytona ppwarm hits). But **all 8 live benchmark boots missed** — Daytona
got `default-cold` ×4, Platinum `per-project-tpl` ×4.

Two independent reasons:

1. **Platinum can never hit.** `ensureSandboxImage`
   (`snapshots/builder.ts:130-139`) gates the warm image on `template.isShared` —
   the shared default slug only. Platinum sessions boot from per-project
   `kortix-tpl-*` templates, so the branch is skipped **100% of the time**.
   14 days: **0 ppwarm hits out of 274 Platinum sessions**, vs 2 781/4 228 (66%)
   on Daytona.
2. **The key is the branch tip.** The warm image is keyed to the current
   default-branch tip, so *every push to `main` invalidates it* and kicks a
   background bake. On an actively-developed project the cache is perpetually
   cold — and those unpaced bakes are the same behaviour behind the Daytona 429
   storm.

So the mechanism that would remove the clone exists, works, and is structurally
unavailable exactly where it is needed most.

## Finding 6 — a gateway fetch can block opencode spawn for 25 s

`buildOpencodeConfigContent` awaits `fetchGatewayModels` (`opencode.ts:339`)
before `opencode serve` can spawn: 6 s timeout × 4 attempts with 500/1000/2000 ms
backoff ≈ **25 s worst case on the critical path**, for an uncached ~400 KB
`/models` response. Not firing today (`opencode-spawned` is 40–119 ms in every
sample) but it is an unguarded cliff gated on gateway health, on both providers.

## Finding 7 — the fork-from-warm machinery still ships, switched off

`dcc12c252` (*cold-only sandboxes — remove stateful/warm-fork machinery*) and
`d48a5c204` (*Remove sandbox warm pools*) removed the callers. The daemon still
carries the whole implementation — `runWarmSeedMode`, `armSeedAdoption`,
`materializeScaffoldSeed`, `KORTIX_WARM_SEED` (`main.ts:91, 445, 503`) — and
`apps/api` never sets `KORTIX_WARM_SEED`. Unreachable in production.
`session-sandbox.ts:273-276` states it plainly: *"Cold-only … Platinum and
Daytona take the identical cold path."*

## Instrumentation gap

Host marks are persisted (`provider_events.marks`). The daemon's `BootMark[]` is
**not** — it lives in guest memory, readable only by calling `/kortix/health` on
a still-running box (which, per Finding 2, doesn't answer until the expensive
part is nearly over). That is why the 11–15 s was unattributable.

Also: `opencode-listening` (`main.ts:403`) — the one mark that would split
opencode's process start from its app init — sits on the `waitForOpencodeReady`
branch, which the initial-session path always skips. **It has never fired in
production.**

## The plan, with measured wins

Ordered by measured value per unit of risk. Daytona p50 baseline **18.9 s**,
Platinum **24.5 s**.

| # | Change | Expected win | Status | Risk |
|---|---|---:|---|---|
| 1 | **`--depth 1` clone** (`KORTIX_CLONE_DEPTH`, default 1) + background `fetch --unshallow` | **−0.5 to −2 s** | **shipped** | Low. Verified shallow works through the proxy. |
| 2 | **Bind the proxy before the clone** — `startProxy` moved above `await repoMaterializePromise`; supervisor created with the baked config dir and `reconfigure`d before first spawn | 0 s direct; removes the ~9 s blind window | **shipped** | Very low; proxy already 503s correctly |
| 3 | **Bound `fetchGatewayModels`** with a 4 s total wall-clock budget (was per-request only) | 0 s p50; removes a ~25 s cliff | **shipped** | Very low |
| 4 | **Split `opencode-session-created`** into `opencode-answering` / `-root-ready` / `event-loop-connected` | 0 s; makes the largest remaining cost attributable | **shipped** | Very low |
| 4a | **SSE event loop: flat 100 ms retry until first subscribe**, exponential only after. It backed off from attempt one while `maybeCreateInitialOpencodeSession` blocked on `connected`, so an opencode ready at t=5 s went unnoticed until t=7.75 s | **up to −2.7 s** | **shipped** | Low; tests fail under the old regime |
| 4b | **`waitForInitialSessionCreate`: 1 s → 10 s per attempt, and stop resending on timeout.** The call is ~370 ms warm but ~1.1 s on a 3×-slower Platinum guest, so it aborted work about to succeed AND could create a duplicate root (a client abort does not cancel opencode's server-side work) | −1 s + a correctness bug | **shipped** | Low; tests fail under the old regime |
| 4c | **`readRepoInfo`: 3 sequential git subprocesses → concurrent.** Called on EVERY `/kortix/health` request, i.e. on every readiness poll, during the window where the guest is CPU-saturated by index-pack | small but on a hot loop | **shipped** | Very low; read-only plumbing, no index lock |
| 4d | **Daytona: eager preview-link warm at create**, matching Platinum's eager expose. Closes a provider asymmetry where Daytona paid `getPreviewLink` (~179 ms) plus edge cold-routing on its first proxied request | part of Daytona's 0–3.8 s `vm_created`→`daemon_reachable` spread | **shipped** | Very low; best-effort, not awaited |
| 5 | **Kill the transatlantic git triangle** — region-local git termination, or a scoped direct-to-GitHub credential | **−3.2 s** (verified) | **owner: API→US move, tracked separately** | Security trade (see Finding 1) |
| 6 | **Drop the `isShared` gate** on per-project warm images | **−7 s on Platinum** (Daytona already hits 65%) | **shipped** | See below |
| 7 | **Persist `boot_timeline`** server-side (daemon POSTs it at ready) | 0 s; permanent attribution | **shipped** | Low |
| 8 | **Platinum guest + create perf** — 3 428 ms to return a booted microVM, ~3× slower on trivial CPU stages | −2.4 s create, −7 s in-guest | not started | Platinum-team work, not app code |

### #6 — what shipped

Landed in two steps, and the order mattered.

**Step 1 (prerequisite):** the ppwarm name and both reap paths scoped to
`(project, template)`, removing the mutual-deletion hazard where two templates'
bakes would delete each other's tip forever.

**Step 2 (the unlock):** `ensurePerProjectWarmImage` now resolves the *requested*
template instead of hardcoding `DEFAULT_SANDBOX_SLUG`. That is the entire
correctness fix — `computeTemplateIdentity`/`resolveUserDockerfile` were already
generic over the template (shared → the constant `PLATFORM_DEFAULT_USER_DOCKERFILE`
with zero git I/O; custom → its real `dockerfilePath` at the tip), i.e. exactly
what the cold path does, so warm and cold converge on the same Dockerfile bytes.
Two things had to ship in the same change or they'd break: the build-log slug
(`warmBuildSlug(template.slug)`, else Retry-build / Fix-with-agent's round-trip
resolves the wrong template) and the cross-replica cooldown check (else
per-template bakes all match the default's warm slug and fight over one slot).

Safety is in code, not in discipline: the new gate `perProjectWarmEligible`
returns `true` **unconditionally** for a shared template — byte-identical to the
gate it replaces, so Daytona's working 65% path is provably untouched — and
otherwise consults `KORTIX_WARM_SNAPSHOT_CUSTOM_TEMPLATE_PROVIDERS`, default
**`platinum` only**. Daytona custom-template warming stays off until quota-gc's
cache-floor math is re-measured against real Daytona custom-template counts,
because that org has a hard 100-snapshot cap and a storm on record.

Deliberately not extended: `provider-transition-service.ts` (its FIX-M1 decision
that custom templates are *not* warm-prepared before a provider switch stands) and
the push-triggered `prebakeForProvider` (still default-only). Neither is needed
for Platinum to go 0% → warm via session-start.

Accepted residuals, documented where a reader will hit them: `tpl8` has no
collision backstop (32-bit space, 1–3 templates/project; closing it would force a
second warm-image-invalidating migration), and a narrow TOCTOU can bake
`/workspace` at a newer tip than a *custom* template's Dockerfile layer reflects —
self-healing on the next bake, never touching the agent/CLI/opencode runtime.

**This is the only shipped change that removes the clone**, and it only helps
Platinum.

### Platinum capacity — investigated against the live platform, not assumed

> **Correction.** An earlier revision said "expect Platinum's first-ever warm
> bakes — new build load on a provider that has never done them". That was wrong.
> Platinum has been baking warm images all along; what it has never done is *serve*
> one.

Measured against Platinum's own API and its source (`kortix/platinum`, read-only —
no changes made):

| Fact | Value | Source |
|---|---|---|
| Kortix's Platinum role | **`role: "org"`, `orgRole: "owner"` — NOT admin** | `GET /v1/auth/me` |
| Template quota | **used 96 / cap 500** (enterprise tier) | `GET /v1/auth/orgs/quota` |
| Inflight cap | **used 0 / cap 50** | same |
| Sandboxes | 81 / uncapped | same |
| Projects running Platinum sessions (14d) | **2** (277 sessions) | Kortix DB |
| Projects running Daytona sessions (14d) | **537** | Kortix DB |
| ppwarm templates already on Platinum | **63 ready, across 58 distinct projects** | `GET /v1/templates` |
| Platinum ppwarm bake attempts (14d) | **373** (238 ok, 135 failed) | `project_snapshot_builds` |

The quota **does** apply — Kortix is not an admin org, so `pickBuildHost`'s
`org_template_quota_exceeded` (HTTP 429) gate is live
(`platinum/apps/api/src/api/templates.ts`), reached from `/from-build`, which is the
route Kortix's adapter uses. `/derive` would have been quota-exempt — Platinum's own
comment anticipates "a project with many warm seeds would otherwise block real image
builds" — but Kortix does not use it.

At 96/500 there are **404 slots of headroom**, and only **2** projects actually boot
on Platinum, so this change adds roughly 2 templates. Bake concurrency is bounded by
the per-(project, provider) cooldown against an inflight cap of 50.
**Verdict: not a capacity risk.**

Two pre-existing problems this investigation surfaced, neither caused by this change
and both worth their own attention:

1. **Platinum's warm bakes fail 36.2% of the time** (135/373) versus Daytona's 9.4%
   (92/976). 129 of those are an opaque `Platinum template … build failed` with no
   detail surfaced; 6 are `503 no healthy host available for build`, i.e. Platinum
   build capacity genuinely does run out sometimes.
2. **63 ppwarm templates exist on Platinum across 58 projects and, until this
   change, not one was ever read** (0 warm hits in 277 sessions). They come from the
   push-triggered `prebakeForProvider`, which bakes the default template for a
   provider regardless of whether the project ever boots on it. That is ~27 bake
   attempts/day of pure waste plus ~63 consumed template slots. Gating prebake on
   "has this project actually used this provider" would reclaim both.

### The rename burst is now designed away, not merely watched

An earlier revision of this doc said the rename "must be released behind the
warm-bake pacing and watched". That was accepting an avoidable risk. The warm-HIT
lookup now falls back to the **legacy name** (`legacyPerProjectWarmImageName`) for
the shared default template, so an image baked before the scoping change is still
found and served — it is already built, and for the default template it is already
exactly right (same project, same tip, same base identity).

Effect: nothing is invalidated at deploy. A legacy image keeps serving until that
project's default branch actually moves, at which point the new-format name misses
and bakes once. The fleet migrates at the natural rate of pushes rather than all
inside one deploy window, and stale legacy tips age out through quota-gc's
idle/LRU rules (which match both name shapes). Gated on `isShared` because a legacy
name encodes no template, so resolving one for a custom template would hand it a
different template's image.

The paragraph below describes what WOULD have happened without that fallback, and
is kept because it is the reason the fallback exists.

⚠ **Without the legacy fallback, deploying #6's rename would not be free.** The new name adds a `tpl8` segment and
folds the slug into the hash, so no pre-migration name can be recomputed —
including the default template's. With ~66% of Daytona sessions currently booting
warm, the release carrying it makes the first session per project miss, clone cold,
and kick a re-bake: a fleet-wide bake burst against the Daytona org's hard
100-snapshot cap, with old tips lingering until quota-gc ages them out
(~2× tips/project transiently). One-time, steady state unchanged — but it is the
same shape as the 2026-07-22 rebuild storm, so release it behind the existing
warm-bake pacing and watch it.

**Why #6 is blocked, not merely unstarted.** Removing the `isShared` gate is the
single highest-value change left (it takes the clone to zero and is the only
thing that helps Platinum at all) — but it is unsafe today.
`ppwarmReapTargets` (`ppwarm-names.ts`) reaps every `kortix-ppwarm-<proj8>-*`
name that is not the one currently being baked. That is correct only while a
project has **exactly one** warm image. Let per-project templates have warm
images too and a project with two templates enters mutual deletion: baking A
reaps B, baking B reaps A, forever — the same failure mode
`PPWARM_REAP_PROTECT_MS` was added to paper over. The prerequisite is to make the
warm name and the reap scope **template-scoped**
(`kortix-ppwarm-<proj8>-<tpl8>-<hash>`), which invalidates every existing warm
image and therefore has to be sequenced against bake pacing and the Daytona
snapshot quota.

**What was deliberately NOT done.** Spawning opencode in parallel with the clone
was on the original plan at −4 to −5 s. It is dropped: it requires resolving
`OPENCODE_CONFIG_DIR` (which lives *inside* the repo) before the repo exists, and
the payoff shrinks to roughly `min(clone, opencode-start)` — real, but far below
the cost of getting config-dir semantics subtly wrong.

### Expected effect of everything shipped — stated honestly

Summing only what is verified and actually on the critical path:

| Item | Daytona | Platinum |
|---|---:|---:|
| Shallow clone | −0.5 s | −0.5 s |
| SSE loop retry regime (#4a) | up to −2.7 s | up to −2.7 s |
| Session-create no-abort (#4b) | ~0 s | −1 s |
| `readRepoInfo` + eager preview (#4c/#4d) | small | small |
| Per-project warm image (#6) | — (already 65%) | **−7 s** (0% → warm) |
| **Expected p50** | **~15–16 s** (from 18.9 s) | **~13–14 s** (from 24.5 s) |

That is a real but unglamorous ~15%. The two changes that would actually halve
this are #5 (−3.2 s, tracked as the API region move) and #6 (−7 s, Platinum only,
gated on the bake path above). Nothing shipped here touches the biggest single
line item — opencode's warm start — because it is not yet proven what that time is
made of; #7 is what makes it provable.

**Do not report these as measured.** They are the sum of verified per-change
savings, not a re-run of the harness. Re-run `bench-boot-attribution.ts` after
deploy and replace this table with real numbers — that is exactly the mistake
(reasoning past the data) that produced the retracted 22× claim earlier in this
document.

### On "sub one second"

Not reachable by optimizing a cold boot, and the numbers say so plainly: a VM
create alone is 1.1 s (Daytona) / 3.4 s (Platinum), before a single byte is
cloned or a runtime starts. Sub-1 s requires handing out a sandbox that is
**already booted** — a warm pool with the repo present and opencode live, where
session start is an *adopt*, not a boot. That is exactly what `runWarmSeedMode` /
`armSeedAdoption` (Finding 7) were built for; they still ship and are switched
off. Reviving them is a cost decision — holding warm capacity vs. boot latency —
not an engineering unknown.

## Method and limits

- Live benchmark: 4 boots/provider, production, concurrent targets. Small N —
  good enough to rank stages that differ by 10×+, not a trustworthy p95.
- Host-side numbers cross-checked against 14 days of full production traffic
  (4 273 + 285 provisions); live and historical p50s agree.
- The two projects have different repos (15.8 MB vs 6.5 MB), so cross-provider
  clone times are **not** directly comparable — which is why Findings 3 and 4
  compare stages that are repo-independent.
- Warm `GET /session` timings traverse the public path from a laptop and so
  include WAN + proxy latency; they are an **upper bound** on the in-guest cost,
  which strengthens the conclusion that HTTP is not the bottleneck.
- All benchmark sessions were deleted. No production configuration was changed.

### Platinum: three more findings from reading its source

A parallel audit of the Platinum repo (read-only) turned up things the live API
numbers alone did not show:

1. **Kortix retried a 429 that can never clear.** Platinum answers 429 for two
   opposite conditions: `rate_limited` (the per-org mutation-rate bucket,
   `PT_ORG_MUT_RATE` = 20 req/s — genuinely transient) and
   `org_template_quota_exceeded` (the per-org template COUNT cap — permanent until
   something deletes a template). `isRetryablePlatinumBuildError` matched on
   `' 429'` and so burned all `BUILD_ATTEMPTS` against the count cap, adding delay
   in front of a wall and burying the one error an operator needs to see. **Fixed**,
   with a test that fails without the fix.

2. **Kortix has no org-wide GC for Platinum templates.** `snapshots/quota-gc.ts`
   imports `listDaytonaSnapshots`/`deleteDaytonaSnapshotById` exclusively — it is
   Daytona-only. The single cleanup is `reapOldPerProjectWarm`, which deletes a
   project's *prior* tip only after a *new* tip for that same project finishes
   building. A project's first-ever bake is pure net-new, and nothing reclaims
   org-wide. That is why 63 ppwarm templates have accumulated across 58 projects
   while only 2 projects boot on Platinum. Not urgent at 96/500, but the trend is
   monotonic.

3. **Platinum's soft-delete contract is exactly what Kortix assumes.** DELETE
   renames to `<name>__deleted_<id>` (keeping the ppwarm prefix) and sets
   `state='deprecated'`; the row is never removed. `GET /v1/templates` does **not**
   filter tombstones, so Kortix's `n.includes('__deleted')` exclusion is both
   necessary and correct — and because the quota gate counts only
   `state IN ('ready','building')`, deleting an old tip genuinely frees quota.
   Verified on both sides; no change needed.

Also noted for the Platinum team: `OPS.md` documents `PT_ORG_MAX_TEMPLATE_MB=8192`,
which does not exist in the code — the real cap is the hardcoded
`ORG_MAX_SIZE_MB = 20480`. Spend limits fail **open** when unset and a template
build emits no billing event, so a bake burst cannot trip a spend cap.
