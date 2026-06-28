# Session-start latency benchmark

End-to-end timing for **creating a session in a project** — the "why does a new
session take so long" question. Drives the exact client flow the dashboard uses
against the **running local stack** (real Daytona/Platinum provisioning, real
opencode boot) and attributes every step a user waits on.

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
  patched opencode build (`/usr/local/bin/opencode-kortix`) or more bake-time
  initialization in the warm snapshot.
- **Daytona `provider-create` variance / retries** — the largest run-to-run
  swing.
- **repo clone (~2.5s)** — eliminated by warm/baked-repo snapshots.
- Persisting `boot_timeline` server-side so this stays attributable in prod.
