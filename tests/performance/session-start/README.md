# Session-start latency benchmark

> **Benchmark scope:** The OpenCode timing stages below measure the v2 REST
> compatibility path. The v3 runtime contract also supports OpenCode, Claude
> Code, Codex, and Pi through ACP. Use
> `tests/e2e/scripts/acp-multi-harness-smoke.ts` for harness acceptance.

End-to-end timing for **creating a session in a project** — the "why does a new
session take so long" question. Drives the exact client flow the dashboard uses
against the **running local stack** (real Daytona/Platinum provisioning, real
opencode boot) and attributes every step a user waits on.

## 2026-07-29 baseline

The current comparable starter-project results are in
[`results/2026-07-29`](./results/2026-07-29).

Each environment used five Daytona sessions and five Platinum sessions.
Every session used a `default-cold` image.

| environment | provider | ready p50 | ready p90 | repository p50 | ACP initialize p50 | ACP session p50 |
|---|---:|---:|---:|---:|---:|---:|
| production | Daytona | 22.430 s | 46.467 s | 7.764 s | 7.222 s | 768 ms |
| production | Platinum | 27.279 s | 32.202 s | 6.287 s | 12.973 s | 1.639 s |
| dev | Daytona | 20.573 s | 47.840 s | 5.974 s | 7.610 s | 698 ms |
| dev | Platinum | 29.103 s | 33.167 s | 6.923 s | 12.385 s | 1.651 s |
| local | Daytona | 15.222 s | 17.795 s | 3.978 s | 6.996 s | 820 ms |
| local | Platinum | 20.728 s | 21.770 s | 2.873 s | 11.977 s | 1.602 s |

The historical `opencode-spawned` mark includes `opencode acp` startup and ACP
`initialize`. It does not measure only `spawn(2)`.

OpenCode `1.18.7` local process benchmarks isolate this cost:

| HOME state | ACP initialize p50 | `session/new` p50 | total p50 |
|---|---:|---:|---:|
| fresh | 7.659 s | 186 ms | 7.841 s |
| warmed by `opencode serve` | 556 ms | 166 ms | 722 ms |
| warmed by exact ACP lifecycle | 522 ms | 171 ms | 700 ms |
| persistent ACP-warmed HOME | 513 ms | 166 ms | 679 ms |

The old `serve` warm-up can warm OpenCode on one persistent local workspace.
The provider A/B below tests whether an image-baked HOME produces the same
result in a new guest.

Pi `0.81.1` local results:

| path | p50 |
|---|---:|
| fresh `pi --mode rpc` to `get_state` | 503.195 ms |
| one-time in-process module import | 680.356 ms |
| in-process `createAgentSession()` after import | 3.819 ms |
| third-party `pi-acp` `session/new` | 1.865 s |

These values come from sequential rechecks. The earlier `*-recheck.json` files
ran concurrently. Their values include local CPU contention.

The third-party adapter starts another Pi process for each ACP session. It does
not represent the target in-process architecture.

The exact ACP image warm-up A/B used
`kortix-default-9f0b65e21921`.

| provider | ready | repository | first ACP output | ACP initialize |
|---|---:|---:|---:|---:|
| Daytona | 35.997 s | 5.593 s | 23.314 s | 299 ms |
| Platinum | 41.310 s | 10.749 s | 8.466 s | 631 ms |

Both providers retained the baked OpenCode database under
`/home/kortix/.local/share/opencode`.

The OpenCode log attributed 21.497 seconds on Daytona and 6.324 seconds on
Platinum to project configuration loading. Database persistence does not cache
this process-local work.

The managed runtime path now starts only the selected ACP harness. It no longer
starts legacy OpenCode before Pi, Codex, Claude, or managed OpenCode. A
runtime-slot adoption stops the inherited legacy OpenCode process.

## 2026-07-29 startup-only Pi and OpenCode comparison

The boundary is ACP model selection completion.

The boundary excludes prompt dispatch, model execution, and first-token
latency.

| configuration | samples | runtime ready p50 | `session/new` p50 | session ready p50 |
|---|---:|---:|---:|---:|
| Pi, Daytona repository disk snapshot | 8 | 4.047 s | 2.987 s | 7.784 s |
| Pi, Platinum cold disk snapshot | 6 | 7.132 s | 5.127 s | 12.823 s |
| OpenCode, Platinum cold disk snapshot | 5 | 15.001 s | 641 ms | 16.298 s |

The Platinum rows use the same starter repository and snapshot state.

Pi reaches session readiness 3.475 seconds before OpenCode.

Pi saves 7.869 seconds during runtime boot.

Pi loses 4.486 seconds during `session/new`.

Percentiles are calculated independently. Do not add percentile rows to
reconstruct a total percentile.

### Complete comparable Platinum p50 events

| event | Pi | OpenCode |
|---|---:|---:|
| `POST /sessions` | 33 ms | 33 ms |
| Git authentication | 3 ms | 3 ms |
| Environment variables | 26 ms | 34 ms |
| Background allocation kicked | 48 ms | 47 ms |
| Row and service tokens | 47 ms | 47 ms |
| Cached image resolution | 2.396 s | 1.469 s |
| Platinum sandbox creation | 2.018 s | 2.094 s |
| Static web server | 22 ms | 22 ms |
| Git identity | 32 ms | 34 ms |
| Daemon proxy | 11 ms | 11 ms |
| Repository materialization | 1.645 s | 1.741 s |
| Selected harness configuration | 2 ms | 4 ms |
| Legacy OpenCode supervisor skipped | 4 ms | 4 ms |
| Selected process spawn call | 4 ms | 6 ms |
| Spawn to first ACP output | 417 ms | 8.451 s |
| First ACP output to initialized | 0 ms | 651 ms |
| Create to runtime ready | 7.132 s | 15.001 s |
| ACP stream open | 74 ms | 71 ms |
| ACP initialize | 294 ms | 237 ms |
| ACP `session/new` | 5.127 s | 641 ms |
| ACP model selection | 150 ms | 515 ms |
| Create to session ready | 12.823 s | 16.298 s |

Nested event values overlap with runtime-ready totals.

### Snapshot terminology

The Daytona result uses a repository disk snapshot.

The snapshot contains repository files. It does not preserve these items:

1. VM memory.
2. Running processes.
3. Open sockets.
4. An initialized ACP server.
5. An active Pi or OpenCode session.

A stateful snapshot preserves process memory and the initialized ACP process.

Restoring `pi-acp` before `session/new` does not remove the Pi delay.

`pi-acp` creates a new Pi child process during every `session/new`.

Capturing state after `session/new` preserves a session-specific child process
and session identity. It does not create a reusable blank Pi runtime.

### Why Pi `session/new` is slower

Kortix pins `pi-acp@0.0.31`.

`pi-acp@0.0.31` and `0.0.32` use the same startup sequence:

1. Load slash commands and Pi settings.
2. Spawn `pi --mode rpc --no-themes`.
3. Call `get_state` inside `PiRpcProcess.spawn()`.
4. Call `get_state` inside `SessionManager.create()`.
5. Call `get_state` inside `newSession()`.
6. Call `get_available_models` inside `newSession()`.
7. Construct ACP model, mode, and configuration responses.

One `session/new` therefore starts one child process.

It also performs three `get_state` requests and one
`get_available_models` request.

OpenCode performs `session/new` inside the initialized `opencode acp` process.

The correct Pi design uses one persistent ACP process and an in-process Pi SDK
adapter.

The adapter imports Pi once. It creates sessions with
`createAgentSession()` in the same process.

### Raw evidence

The result directory contains every retained attempt.

This includes valid samples, rejected samples, image-build samples, profiling
samples, and local wire probes.

The primary startup sample sets are:

- `local-pi-daytona-post-fix-01.json` through `08.json`.
- `local-pi-platinum-post-fix-01.json` through `06.json`.
- `local-opencode-platinum-deepseek-post-fix-01.json` through `05.json`.
- `pi-rpc-sequential-recheck.json`.
- `pi-acp-sequential-recheck.json`.
- `pi-in-process-sequential-recheck.json`.

## Run

Prereqs: local stack up (`pnpm dev` → API `:8008`, Supabase `:54321`, Postgres
`:54322`), `psql` on PATH, and the sandbox-agent binary built
(`cd apps/kortix-sandbox-agent-server && bun run build`).

```bash
cd tests/performance/session-start
./run.sh                 # full benchmark (N sessions, default 3)
./run.sh boot-probe      # one session + the daemon's in-container boot_timeline
./run.sh oclog-probe     # one session + opencode.log + baked-vs-runtime dep versions
N=5 POLL_MS=250 ./run.sh # knobs: N, POLL_MS, READY_TIMEOUT_MS, PROVIDER, PROJECT_ID, BENCH_EMAIL, BENCH_UID
```

Analyze one or more raw boot result files:

```bash
node analyze-boot-results.mjs \
  results/2026-07-29/production-starter.json \
  results/2026-07-29/dev-starter.json \
  results/2026-07-29/local-starter.json
```

Run the comparable default starter benchmark against one environment:

```bash
BENCH_API=https://dev-api.kortix.com \
BENCH_TOKEN=... \
BENCH_DB_URL=... \
BENCH_ACCOUNT_ID=... \
BENCH_ENVIRONMENT=dev \
./run-comparable-starter.sh
```

The wrapper creates one default starter project. It runs Daytona and Platinum
against the same repository. It records the project, repository, base commit,
provider, and raw boot timelines. It archives the project on exit.

Inspect the retained OpenCode cache and log after a `BENCH_KEEP=1` run:

```bash
BENCH_API=http://localhost:8008 \
BENCH_TOKEN=... \
BENCH_DB_URL=... \
BENCH_RESULT=results/2026-07-29/local-baked-acp-a-b.json \
./inspect-runtime-cache.sh
```

The inspector creates one short-lived PTY command inside each retained session.
It saves HOME, database metadata, process state, and the OpenCode log tail.

Benchmark OpenCode and Pi harness startup:

```bash
node harness-startup-bench.mjs opencode --scenario fresh --runs 3
node harness-startup-bench.mjs opencode --scenario serve-warmed --runs 3
node harness-startup-bench.mjs opencode --scenario acp-warmed --runs 3
node harness-startup-bench.mjs opencode --scenario persistent-acp-warmed --runs 10
node harness-startup-bench.mjs pi-rpc --runs 15
node harness-startup-bench.mjs pi-in-process --runs 15

# Install the third-party adapter outside the repository.
install_dir="$(mktemp -d /tmp/kortix-pi-acp-install.XXXXXX)"
npm install --prefix "$install_dir" pi-acp@0.0.32
OPENAI_API_KEY=bench-placeholder \
  node harness-startup-bench.mjs generic-acp \
  --command "$install_dir/node_modules/.bin/pi-acp" \
  --runs 10
```

`bench-placeholder` only satisfies the adapter's startup auth check.
The benchmark does not send a model prompt.

Audit the published `pi-acp` `session/new` source path:

```bash
node audit-pi-acp-session-new.mjs 0.0.31 0.0.32
```

The audit downloads npm tarballs into a temporary directory.

It does not install either version into this repository.

Analyze startup through ACP model selection:

```bash
node analyze-startup-ready.mjs \
  results/2026-07-29/local-pi-daytona-post-fix-0[1-8].json

node analyze-startup-ready.mjs \
  results/2026-07-29/local-pi-platinum-post-fix-0[1-6].json

node analyze-startup-ready.mjs \
  results/2026-07-29/local-opencode-platinum-deepseek-post-fix-0[1-5].json
```

`analyze-first-token.mjs` and `create-to-first-token.mjs` preserve the earlier
prompt benchmark technique.

Do not use their first-token metric for the startup-only comparison.

Each iteration provisions and deletes a **real cloud sandbox** — keep `N` small.
`run.sh` resets a throwaway local e2e user's password to sign in; **local dev
only**, never point `BENCH_*` at a real account.

## How it works

Three independent timelines are lined up so the total is attributable:

1. **Client start-poll stages** — `POST /sessions` (201) → poll
   `POST /sessions/:id/start?wait_ms=0` until `stage=ready`, recording the
   `provisioning → starting → ready` transitions and when the sandbox row flips
   to `active` + gets an `external_id`.
2. **Host `provisionTimeline`** (read from `kortix.session_sandboxes.metadata`):
   `row+tokens → image-cached|image-built|warm-base → provider-create`.
3. **In-sandbox `boot_timeline`** (from the daemon `/kortix/health`):
   `static-web → git-identity → repo-materialized → config-deps →
   opencode-spawned → proxy-up → opencode-session-created → opencode-ready`.

`oclog-probe` additionally reads opencode's own `opencode.log` and the baked vs
runtime `@opencode-ai/plugin` versions through the daemon `/file` proxy (which
allows `/opt`, `/home`, `/tmp`, `/workspace`).

## Findings (2026-06-28, Daytona, image cached)

The `POST /sessions` call itself returns **201 in ~15ms** — none of the pain is
in the CRUD/DB layer (READ ~300ms, LIST ~200ms, PATCH/DELETE ~10ms). The wait is
**provisioning a fresh sandbox and cold-booting opencode**, every time:

| step | cost | notes |
|---|---|---|
| host pre-provision + `provider-create` | ~1–6s | Daytona-side; **high variance** (occasional 2× retry → 30s+) |
| in-sandbox `repo-materialized` (clone) | ~2.5s | scaffold delta-fetch; tunnel-inflated locally |
| `opencode-spawned` | ~0.7s | Bun cold start of the opencode binary |
| **`opencode-session-created`** | **~2–8s** | opencode project-init **+ a network plugin install (bug, see below)** |
| image **build** (only when content hash changes) | **30–400s** | full snapshot rebuild — e.g. any sandbox-agent source edit |

### Fixed

- **Baked config-deps were incomplete.** `dockerfile-layer.ts` baked only
  `firecrawl/tavily/replicate` — omitting `@opencode-ai/plugin` — so opencode's
  boot-time `bun install` fetched it (+ `effect`/`zod`/`@opencode-ai/sdk`) over
  the network on every boot. **And** opencode loads the plugin SDK matching its
  **own binary version**, ignoring the config-dir pin — so the baked version must
  equal `RUNTIME_VERSIONS.opencode`, not the (stale) starter pin. Both bake paths
  now pin `@opencode-ai/plugin` to the binary version; a unit test
  (`apps/api/src/snapshots/__tests__/config-deps-version.test.ts`) keeps the
  starter pin in lockstep so it can't drift on the next opencode bump.
- **Catalog fetch fallback.** The full model catalog is baked to
  `/opt/kortix/llm-catalog.json`; the daemon now falls back to it (full picker)
  when the gateway `/models` fetch is slow/down, instead of collapsing to ~13
  models. (The live per-account fetch still runs first for correctness.)

## Runtime comparison: Daytona container vs micro-VM vs Platinum

`runtime-bench.mjs` measures **raw `create → running`** (and `→ executeCommand`)
per Daytona sandbox class/region, isolating the runtime's provisioning speed (our
daemon boots identically once the box is up, so the only runtime-dependent delta
is create→reachable). It needs the Daytona SDK ≥ 0.192 (the repo pins 0.184,
which has no `SandboxClass.LINUX_VM`) — run it from an isolated install:

```bash
mkdir -p /tmp/dtn-bench && cd /tmp/dtn-bench && npm i @daytonaio/sdk@latest
DAYTONA_API_KEY=$(cd <repo>/apps/api && npx dotenvx get DAYTONA_API_KEY) \
DAYTONA_SERVER_URL=https://app.daytona.io/api N=12 \
  node <repo>/tests/performance/session-start/runtime-bench.mjs
```

Results (`create → running`, 2026-06-28):

| runtime | image | n | min | **median** | **max** |
|---|---|---|---|---|---|
| Daytona **container** @us | ubuntu:22.04 | 20 | 0.8s | **~1.7s** | **21.4s** ⚠️ ~10% spike |
| Daytona **linux-vm** microVM @us-west-2 | ubuntu:22.04 | 20 | 0.8s | **~1.1s** | **1.4s** |
| **Platinum** microVM (our platform) @nl-ams | **kortix-default template (our runtime)** | 11 | 0.9s | **~0.96s** | **1.5s** |

- **Platinum is the fastest + most consistent** — and uniquely it ran with OUR
  actual runtime template (the Daytona rows are bare ubuntu, so they'd be slower
  with our heavier image). Platinum (`api.platinum.dev`) is OUR Cloud-Hypervisor
  microVM platform ("14ms warm-start" via CoW fork — not even exercised here; this
  is cold template create). It's reachable, the `pt_live_…` key is valid, and
  `kortix-default-*` templates are `ready`. It's just **deactivated in routing**
  (creates currently land on Daytona). `PLATINUM_TEMPLATE` is empty in env but
  templates exist and resolve by id. Run: `platinum-bench.mjs` (PLATINUM_API_URL/
  PLATINUM_API_KEY from dotenvx).
- **Daytona linux-vm** is ~35% faster than container at the median AND kills the
  tail — the container path produced ~21s `create→running` spikes ~10% of the time
  (the "spike to 30s+ on a 2× retry": our provider's first Daytona `create` hangs
  to `KORTIX_DAYTONA_CREATE_TIMEOUT_SECONDS=30` then retries). Adopting it needs
  SDK ≥0.192 (repo pins 0.184, no `SandboxClass.LINUX_VM`), our image in a
  **registry** (linux-vm has no declarative builder), + a us-west-2 client.

### Still open (the big levers)

- **opencode cold start (~2–6s, high variance)** — Bun loading the opencode
  bundle + project init on a cold Daytona runner. Reducing it further needs a
  patched opencode build (`/usr/local/bin/opencode-kortix`) or a stateful
  process snapshot.
- **Daytona `provider-create` variance / retries** — the largest run-to-run
  swing.
- **repo clone (~2.5s)** — eliminated by repository disk snapshots.
- Persisting `boot_timeline` server-side so this stays attributable in prod.
