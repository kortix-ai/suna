# Harness / worker split — implementation plan

**Status:** planning · **Date:** 2026-08-26 · **Source:** huddle 2026-08-26 (Marko, Jay), architecture read

## What this changes

Today one sandbox is the harness, the compute, and the message store at once.
`session_id == sandbox_id`, the image is 6–8 GB, and the boot path is serial:
restore rootfs → `git clone` → resolve `OPENCODE_CONFIG_DIR` from the checkout →
spawn `opencode serve` → wait to listen → wait for its session API.

After the split there are three planes:

- **Control plane (Kortix API)** gains a build step: read `kortix.yaml` at a
  commit, compile one bundled agent server, cache it by sha.
- **Worker** — a minimal Alpine micro-VM running only the harness. Fetches one
  artifact. No compiler, no Python, no browsers, no shell.
- **Environment** — today's fat sandbox, demoted to lazily-started compute.

The inversion everything follows from: **the worker is where the agent thinks;
the environment is where it acts.** Every default tool (`bash`, read, write,
edit, glob, grep) is a Kortix SDK client targeting an environment. None of them
touch the worker's disk.

## Non-goals for phases 0–1

Explicitly out of scope, to keep the first landing small:

- Durable Objects / WASM workers. Micro-VM only.
- Shared volumes and volume versioning.
- More than one environment per worker.
- User-authored Pi extensions loaded at runtime.
- Migrating existing sessions or projects.
- Replacing the frontend. `runtime: opencode` stays the default everywhere.

## The hard constraint

> **Phase 0 and Phase 1 are additive. No PR in them may change the behaviour of
> the `runtime: opencode` path.**

Essentia is live and Libra Max is going out. The call assigned one person to
this architecture and two to production stability; that division survives
exactly as long as this work never edits the OpenCode boot path. Every PR below
states what it must not touch. A PR that cannot honour that is a signal to
re-scope, not to proceed.

---

## Phase 0 — the Pi spike

Local, scratch directory, **zero Kortix code changed**. Five proofs, in this
order. Each is a kill switch: if one fails, the plan changes before anything is
committed to.

Sequencing note: build the Alpine image *last*, not first. Shrinking an image is
bounded work with a known outcome. Every unknown lives in the Pi integration.

### S0.1 — Tool replacement holds

Run `createAgentSession` headless with builtin tools off and three
`defineTool` wrappers (`bash`, `read`, `write`) that RPC into an **existing**
Kortix sandbox through the API proxy (`/v1/p/<external_id>/8000/...`).

Prompt the agent to create a file, then read it back.

- **Pass:** the file exists in the sandbox (verified independently through the
  daemon file API), *and* a before/after `find` diff of the local working
  directory shows zero files created outside Pi's own session store.
- **The negative assertion is the test.** "It worked" is not the result; "it
  worked and touched nothing locally" is.
- **Kill:** builtin tools cannot be fully disabled, or Pi writes outside its
  declared session directory.

### S0.2 — Model credentials route through the Kortix gateway

Point `ModelRuntime` at the Kortix LLM gateway rather than raw provider keys.

Second, deliberately: it is the least visible integration and it invalidates the
most downstream if it fights back.

- **Pass:** a completed turn whose usage appears in the gateway's log with
  correct attribution.
- **Kill / fallback:** if Pi's provider config admits no base-URL override, the
  fallback is the pattern the daemon already uses — run an in-worker LLM proxy
  (`apps/kortix-sandbox-agent-server/src/llm-proxy.ts`) and point Pi at
  localhost. Record which of the two we are on; it changes the worker image.

### S0.3 — It bundles, and it boots fast

Bundle the server to a single `.mjs` with everything inlined (no external
resolution at runtime). Run it cold; measure process start → listening →
accepting a prompt.

- **Pass:** one file, nothing resolved at runtime, well under a second to
  listening.
- **Kill:** `jiti`-based extension discovery forces runtime module resolution.
  If user extensions cannot be compiled in at build time, extensions become a
  Phase 2 feature and v1 ships with compiled-in tools only. Decide this here,
  not during Phase 1.

### S0.4 — History survives the process

Custom `SessionManager` writing to a store we own. Run a three-turn conversation
with tool calls. Kill the process. Read the whole conversation back with a
separate script that never imports Pi's runtime.

- **Pass:** full fidelity — text, thinking, tool calls, tool results —
  reconstructable with no Pi process anywhere.
- **Kill / fallback:** if the on-disk format needs Pi to interpret, we write our
  own message projection at `turn_end` instead. That is acceptable; discovering
  it in Phase 1 is not.

### S0.5 — The event stream is enough for the frontend we already have

Map `session.subscribe` events (`message_update`/`text_delta`,
`tool_execution_start`/`_end`, `turn_end`, lifecycle) against every field the
current web SSE consumer reads.

- **Pass:** a mapping table with no unmapped consumer.
- **Kill:** any gap here is frontend work hiding inside a backend change. Scope
  it into Phase 1 explicitly or drop the affected UI.

**Phase 0 output:** a short findings doc — pass/fail per proof, the two
fallbacks above resolved either way, and the cold-boot number for the bundled
server.

---

## Gate G0 — the RPC tax. Runs after Phase 0, before P1.1.

Phase 0 answers "can this be built". G0 answers "should it be", and it is the
only question that can still kill the design after Phase 0 passes.

Splitting the harness from the environment turns every tool call into a network
round trip. `bash` is a local fork today: about a millisecond. A tool-heavy turn
makes hundreds of calls. If the per-call cost is high enough, the tax on every
turn exceeds the one-off boot saving the whole split is justified by — and no
amount of Phase 1 makes it not so.

### Threshold

| verdict | p50 per call | 200-call turn | meaning |
|---|---|---|---|
| pass | ≤ 10 ms | ≤ 2 s | comfortably under the boot saving. Net win everywhere. |
| warn | ≤ 25 ms | ≤ 5 s | net win except for tool-heavy work. Ship, but scope reduction before tool-heavy agents move over. |
| fail | > 25 ms | > 5 s | costs more than the split saves. Do not write P1.1 against this transport. |

Measured from inside the worker sandbox, worker → provider edge → environment,
which is the shape production uses (worker → Kortix proxy → sandbox daemon).

### Result: WARN

`spikes/pi-worker/bench/rpc-tax.ts`, 200 calls per transport on Daytona:

| transport | p50 | p95 | per 200-call turn |
|---|---|---|---|
| `fetch` per call | 20.3 ms | 26.8 ms | 4.1 s |
| pooled keep-alive | 19.2 ms | 23.9 ms | 3.8 s |
| multiplexed WebSocket | **16.0 ms** | 17.9 ms | **3.2 s** |

Two things follow, and the second is the important one.

1. **The transport choice is worth 21%, not an order of magnitude.** A
   multiplexed socket beats naive per-call `fetch` by 4 ms. Worth taking — it is
   also more robust, since per-call HTTP already produced a correctness bug in
   the spike when a keep-alive socket was retired between calls — but it is not
   the lever.
2. **The tax is dominated by the provider's network topology, not by us.**
   Both sandboxes sit in one Daytona region, yet traffic leaves through the
   public edge because Daytona isolates sandboxes from each other
   (`EHOSTUNREACH` on the private IP, verified). The lever that matters is
   **co-location**, not protocol. Any provider that lets a worker reach its
   environment over a private network should collapse this number, and that is
   a provider-selection criterion the plan did not previously have.

### Sensitivity — who actually pays

| tool calls in a turn | added latency at 16 ms |
|---|---|
| 5 | 0.08 s |
| 30 | 0.5 s |
| 100 | 1.6 s |
| 200 | 3.2 s |

Against boot savings of 1.3 s (create) and 2.8 s (archived resume), the split is
a clear win up to roughly 100 tool calls per turn and roughly break-even beyond
that. Most sessions are nowhere near 200 calls; coding agents on large refactors
are.

### What WARN obliges us to do

- Ship P1.7 with the multiplexed transport from the start. Per-call HTTP is not
  an acceptable interim: it is both slower and, demonstrably, less correct.
- Add a co-location requirement to the provider criteria, and measure the same
  gate on Platinum and E2B before committing tool-heavy agents.
- Keep this gate as a regression test. If p50 crosses 25 ms the split stops
  paying, and that must fail loudly rather than be discovered by a customer.

---

## Phase 1 — the worker

One PR at a time, in this order. Each names what it must not touch.

### P1.0 — Session-start clock (do this first)

`bootMark()` in `kortixd` stamps every mark as `Date.now() - bootTime`, where
`bootTime` is **process start inside the guest** (`main.ts:105`). VM allocation
and rootfs restore both finish before that clock starts — so the existing boot
timeline is blind to the single largest cost the Alpine image removes.

Add an API-side clock: `POST /sessions` → first streamed token.

- **Touches:** API session start + stream instrumentation only.
- **Must not touch:** any boot behaviour.
- **Proof:** baseline numbers on dev for today's **cold** path and today's
  **warm-pool hit**, 10 runs each. Both matter — see "What we measure".

### P1.1 — `apps/kortix-worker`, standalone

> Blocked on gate G0 above. G0 returned WARN, so P1.1 proceeds with the
> multiplexed transport mandatory rather than optional.

The HTTP + SSE server wrapping Pi. Runs from a local config file with no Kortix
API dependency. Minimum surface: `POST /prompt`, `GET /events` (SSE),
`GET /health`, `POST /interrupt`.

- **Touches:** new app only.
- **Must not touch:** `apps/api`, `apps/sandbox`, `kortixd`.
- **Proof:** `curl` a prompt, receive streamed tokens, interrupt mid-turn.

### P1.2 — Kortix SDK tool pack

`bash`, `read`, `write`, `edit`, `glob`, `grep` as Pi tool definitions that
target an environment through `@kortix/sdk`. Per repo rules, this logic lives in
the SDK, not in the worker.

- **Read first:** `packages/sdk/AGENTS.md` and `packages/sdk/PROGRESS.md`. TDD is
  mandatory there, exported *types* are a public API contract, adding an export
  needs three synchronised edits, and there is a framework-free import-graph
  tripwire.
- **Proof:** each tool exercised against a real sandbox — assert the effect
  inside the sandbox *and* assert no local write.

### P1.3 — The bundle compiler

Extend the existing resolution layer
(`apps/api/src/projects/lib/compile-agent-config.ts` already reads a v2 manifest
plus each agent's `.md` from git at a commit, pure, no sandbox I/O) into a
bundle spec, then add the build step that emits the `.mjs`.

Keep the two halves separate: resolution stays pure and unit-testable; bundling
is the I/O half.

- **Proof:** given a real project and sha, emit a `.mjs`; run it under P1.1;
  confirm the agent answers with the manifest's system prompt and model.

### P1.4 — The bundle store

Content-addressed by sha256, keyed `(project, sha, agent)`. Served with `ETag` /
`If-None-Match` → 304.

Two existing precedents to follow rather than invent against:
`apps/api/src/apps/artifacts.ts` (Supabase Storage, tar, sha256, size ceilings,
retries — note this is **Supabase Storage, not AWS S3**; there is no S3 client
in the repo) and `apps/api/src/runtime-assets/index.ts` (cheap manifest, large
payload routes, content-addressed ETags).

- **Proof:** build twice → second is a cache hit; re-fetch → 304.

### P1.5 — Worker image + template row

New `apps/worker-sandbox/Dockerfile`: Alpine + the runtime S0.2 settled on + a
supervisor that fetches the bundle and `exec`s it. Nothing else. New template
slug registered in `kortix.sandbox_templates`.

The template service (`apps/api/src/snapshots/templates.ts`) is already
provider-agnostic across Daytona, Platinum and E2B, DB-backed, with per-template
resource specs. **A worker is a template row and a Dockerfile — not new
infrastructure.**

- **Must not touch:** `apps/sandbox/Dockerfile`. That is the live production
  image.
- **Proof:** image size recorded; provision-to-listening measured against the
  fat template on the same provider.

### P1.6 — Session start branches on `runtime: pi`

`packages/manifest-schema/src/index.v2.ts:59` declares
`type RuntimeV2 = 'opencode'` with the comment *"reserved so `runtime: claude`
is a one-line project change later"*. The extension point is designed in: add
`'pi'` to `V2_RUNTIME_VALUES` and the union, then branch the session boot path —
worker template, no environment, no clone.

- **Must not touch:** behaviour when `runtime` is absent or `'opencode'`.
- **Proof:** two projects side by side on dev, one per runtime, both working;
  plus a test asserting the opencode start path is unchanged.

### P1.7 — Lazy environment provisioning

The first compute tool call provisions or resumes an environment, over one
persistent multiplexed connection (never per-call HTTP — see "What we measure").

- **Proof:** a session that never calls a compute tool provisions **zero**
  sandboxes, asserted against the DB. One that does provisions exactly one.

> **Shipped 2026-08-27** in two slices. E1 (PR #6986): `session_environments`
> table + `POST /v1/projects/:pid/sessions/:sid/environment/ensure` — the env
> box is the full daemon image on the session branch, booted with the SESSION's
> own service key and `KORTIX_BOOTSTRAP_OPENCODE_SESSION=0`; the response hands
> the worker a provider-edge origin + token, so worker↔environment traffic
> never transits the session proxy. E2: the daemon gains `/kortix/env-rpc`
> (ExecutionEnv ops, self-authenticated like `/pty`) and the worker gains
> `LazyKortixEnv` — pi's built-in bash/read/write/edit tools attach on first
> use.
>
> **Two recorded deviations from the letter of this plan.** (1) *P1.2's "tools
> live in `@kortix/sdk`"*: the worker speaks the daemon surface directly. The
> worker is platform infrastructure (like the daemon, which also consumes no
> SDK), it is workspace-excluded with npm-pinned deps and cannot depend on
> unpublished SDK changes, and pi's own tools already carry the ExecutionEnv
> seam — reimplementing them as SDK clients would have bought a package
> boundary at the cost of the tools' ergonomics. The SDK tool pack remains the
> right shape for HOST-side consumers and stays on the backlog. (2) *"one
> persistent multiplexed connection"*: v1 ships the keep-alive transport with
> the retirement-retry guard over the provider edge (the G0 measurement path);
> the ws multiplex upgrade slots in behind the same `RpcTransport` interface.

### P1.6b — Worker pool (added 2026-08-27, shipped as "P1.8" in PRs #6981/#6985)

Not in the original plan; the cold-boot decomposition demanded it. Parked
worker boxes (park-mode entrypoint + single-accept claim server) claimed at
session create; Daytona labels are the registry; pure accelerator with cold
fallback. Measured on dev: create→ready 6.5–7.7 s claimed vs 8.5–10 s cold.
Note the PR titles say "P1.8" — that name collided with this plan's
history-without-runtime item, which remains OPEN below.

### P1.8 — History readable with nothing running

Serve session history without touching a runtime.

- **Proof:** stop every runtime, `GET` history, full fidelity, p95 compared with
  today's wake-the-box path.

---

## Schema: a new table, not a column

`kortix.session_sandboxes` declares `sessionId: text('session_id').notNull().unique()`
— **one row per session, enforced by the database.** Around it sit a DB trigger
(`session_sandboxes_anchor_guard()`), compute-metering/billing, the reaper's
deadline math over `metadata.activeTurns`, and 59 files in `apps/api` that
reference the table.

Adding a `kind` column and dropping that unique constraint silently changes the
meaning of every existing query against it. That is the opposite of additive.

**Decision: Phase 1 adds a separate `session_workers` table.** Purely additive,
zero risk to the OpenCode path, and it can be merged into a unified runtime
table later once the worker path has earned it.

Migrations in this repo are Drizzle-generated (`bun scripts/generate.ts <slug>`,
then house-style the SQL — hand-written files fail the "Schema matches
migrations" CI check). Read `.claude/skills/learnings/SKILL.md` before writing
it.

---

## What we measure

The headline number is **worker cold start vs today's warm-pool hit** — not vs
today's cold start. Warm pools, snapshots and fork adoption already exist and
already produce sub-second in-guest starts on a hit; benchmarking against a cold
sandbox flatters the worker and proves nothing anyone will feel.

The argument survives the harder comparison anyway, in a stronger form: the
worker makes warm-path latency the *default and deterministic* case instead of a
probabilistic cache hit, and it decouples harness upgrades from image turnover.

Three numbers, on dev, same prompt, same provider, 10 runs each:

1. Time to first token — today cold, today warm, worker.
2. Per-tool-call round trip, worker → environment. **This is the regression
   risk.** `bash` is a local fork today, roughly a millisecond. At +30 ms per
   call, a 200-call turn pays +6 s on *every* turn, forever — which can exceed a
   one-time ten-second boot saving inside a single session. Measure it in
   Phase 0, not after.
3. Bundle fetch time — a cost that does not exist today, now on the critical
   path. It must be cached and co-located or it eats the gain it enables.

## Rollback

`runtime: pi` is a line in a project's `kortix.yaml`. Reverting the manifest
reverts the project. Add a server-side kill switch alongside it so a bad worker
rollout can be stopped centrally without asking every project to commit.

## Definition of done for Phase 1

A session on dev that streams its first token from a worker which has never
provisioned a sandbox, on a project whose agent came out of `kortix.yaml` at a
commit — with the before/after numbers beside it.

Not a demo of the worker booting. A demo of the **agent answering** before the
old architecture would have finished restoring its rootfs.

## Open decisions carried in from the architecture read

These do not block Phase 0 or Phase 1, but Phase 2 cannot start without answers:
one worker to N environments; where a skill's script executes (environment,
always); whether the worker gets any shell (no); where messages ultimately live;
and the honest naming — the worker is **stateful**, and the docs must say "your
work is not stored here", never "this is stateless".
