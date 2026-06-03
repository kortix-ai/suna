# Per-project warm sandbox pool

Status: SPEC / proposed. Owner: boot-latency. Related: session boot profile
(opencode bun-install fix shipped `ab314366c`).

## Goal

Cut session create→usable by keeping N pre-booted sandboxes per project, ready
to **claim** instantly instead of calling `daytona.create()` + clone + opencode
boot on the request path.

The **operator** turns the feature on and sets the default size + cost bounds
via env; **per project**, the user opts in/out and picks a size from the UI
(Customize → Sandbox). There is deliberately **no `kortix.toml` config** — warm
pool isn't project-as-code, so it's DB-only (`projects.metadata.warm_pool`).

```
KORTIX_WARM_POOL_ENABLED=true        # master switch (off by default)
KORTIX_WARM_POOL_SIZE=1              # default boxes per project (UI overrides)
KORTIX_WARM_POOL_MAX_TOTAL=50        # global cap (idle cost + Daytona quota)
KORTIX_WARM_POOL_PRESENCE_MINUTES=15 # only warm projects a user is present in
```

Cost is contained by **presence gating**: a pool is held only while a user is
actively in the project (authenticated portal activity), and reaped when they
leave — so no idle boxes 24/7.

## What a warm sandbox can pre-do — the crux

A boot has three costs (prod-real, after the bun-install fix):

| phase | ~cost | session-specific? |
|---|---|---|
| `daytona.create()` → started | ~1.3s warm (up to ~10s cold-runner) | no — same default snapshot for all sessions |
| clone base branch | ~2–4s | **no** — every session branches from the same base |
| opencode boot (binary + plugins) | ~1.5s | no — config dir is the same base checkout |
| create session branch from base | ~0.1s | **yes** |
| inject session identity + initial prompt | — | **yes** |

The first three (≈5–7s) are **identical for every session of a project** — that's
exactly what a warm sandbox can do ahead of time. Only the last two are
per-session. So warm pool is worth it **only if the warm sandbox pre-clones the
base branch and warms opencode** (option B below), not just the container.

### What is baked per-session today (from `session-sandbox.ts` + `buildSessionSandboxEnvVars`)

Session-specific, set at provider create-time:
`KORTIX_TOKEN` (per-sandbox API key), executor token, LLM gateway key,
`KORTIX_SESSION_ID`, `KORTIX_BRANCH_NAME`, `KORTIX_INITIAL_PROMPT`,
`KORTIX_OPENCODE_MODEL`, and the launching user's **per-user** secret view.

Project-level (identical across a project's sessions):
`KORTIX_REPO_URL` (proxy URL by projectId), `KORTIX_BASE_REF`,
`KORTIX_PROJECT_ID`, `KORTIX_API_URL`, `KORTIX_PROJECT_AUTO_CLONE`.

Daytona bakes envVars at create time and they can't be edited on a running
sandbox without a restart — so session identity must reach a pre-booted sandbox
**after** boot, via a claim protocol (not env).

## Architecture options

**Option A — container-warm only.** Pre-create sandboxes (started, generic), and
at claim set session env (Daytona env update) + restart the daemon to do clone +
opencode. Saves only `daytona.create()` (~1.3s). Simple, but the smallest win and
still pays clone+opencode on the request path. **Not recommended** — create is
already cheap; the clone+opencode are the seconds.

**Option B — pre-booted against base (recommended).** Warm sandbox boots with
project-level env + a project-scoped token + `KORTIX_AWAIT_CLAIM=1`, clones the
base branch, warms opencode against the base config dir, then **parks**: polls the
control plane for a claim. On session-create we atomically claim a parked sandbox
and hand the daemon its session identity; the daemon creates the session branch
locally from the already-cloned base (~0.1s), injects the per-session tokens,
optionally bootstraps the initial opencode session, and reports ready. Request-path
cost ≈ claim round-trip + branch create ≈ **<1s**.

## Claim protocol (option B)

Daemon (`kortix-sandbox-agent-server`) gains an **await-claim mode**:
- When `KORTIX_AWAIT_CLAIM=1` and no `KORTIX_SESSION_ID`, after repo
  materialize + opencode-ready it does NOT create a session branch. It marks
  `parked` in `/kortix/health` and long-polls `GET {KORTIX_API_URL}/internal/
  sandbox-claim?externalId=…` (auth: its project token) until assigned.
- Claim payload returns `{ sessionId, branchName, initialPrompt?, opencodeModel?,
  executorToken?, llmApiKey?, secretsRevision? }`.
- On receipt the daemon: creates `branchName` from base locally, records the
  session id, writes any per-session secrets/tokens into the opencode env, and
  (if prompt) bootstraps the opencode session. Flips health → ready.

Control plane:
- `claimWarmSandbox(projectId, …)` — atomic `UPDATE … WHERE status='warm' AND
  project_id=… LIMIT 1 RETURNING` (SKIP LOCKED) → returns a sandbox or null.
- On claim it writes the `project_sessions` + `session_sandboxes` mapping to the
  claimed `externalId`, stashes the claim payload for the daemon's poll, and
  returns immediately. Pool-miss → fall back to today's `provisionSessionSandbox`.

The session-scoped `KORTIX_TOKEN` question: the warm boot uses a **project-scoped**
token (sufficient for the git proxy clone-credential + router, per the two-var
contract). Per-session executor/LLM tokens are minted at claim and handed to the
daemon in the claim payload (not via env). If a use case truly needs a
per-sandbox `KORTIX_TOKEN`, mint it at claim and have the daemon adopt it.

## Config

- **Operator env** (see top): master flag, default size, global cap, presence window.
- **Per-project UI** (Customize → Sandbox `WarmPoolCard`): toggle + size stepper,
  gated on `warm_pool_available` (the platform flag). Persists via
  `PATCH /projects/:id/warm-pool` → `projects.metadata.warm_pool = { enabled, size }`.
  `resolveWarmConfig(metadata)` resolves the UI value over the operator default.
- **No `kortix.toml`** — warm pool is not project-as-code. `serializeProject`
  exposes `warm_pool` (effective) + `warm_pool_available`.
- `projects.metadata.warm_pool_seen_at` is a runtime *presence* timestamp written
  by `notePoolPresence`, not user config.

## Data model

Reuse `session_sandboxes` with a new `status='warm'` (no `session_id` yet) +
`pool_state` ('booting'|'parked'|'claimed') and `claimed_at`, OR a dedicated
`sandbox_pool` table. Reuse is lighter and keeps the snapshot/externalId plumbing.

## Pool manager (background sweep, workers-gated)

- **Refill**: per project with `warm_pool.enabled`, ensure `parked + booting >=
  size`; create the shortfall via the existing provision path in await-claim
  mode. Respects the global Daytona quota + a platform max-total cap.
- **Reap**: drop warm sandboxes whose default snapshot hash drifted (a rebuild
  invalidated them), exceeded a max age, or leaked (claimed-but-never-finalized).
- **Keep-alive**: warm sandboxes must NOT autoStop (or be touched within the
  interval) or they go cold and defeat the pool.

## Cost — the thing to decide

`default ON, size 1, every project` = **one always-running Daytona sandbox per
project, indefinitely**. That is a continuous, fleet-wide cost (idle runners +
no autoStop). Levers: default size 1 but only refill projects **active in the
last N days**; cap global warm total; per-plan gating (e.g. paid only). Without
one of these, default-on-everywhere is expensive.

## Edge cases

- **Per-user secrets**: warm boot can't know the launching user. Warm against the
  project-default secret view; if the claiming user has personal overrides that
  differ, either inject at claim (revision check → daemon refreshes) or skip the
  pool for that session. V1: project-default view + claim-time refresh.
- **Claim race**: atomic `UPDATE … SKIP LOCKED`; double-claim impossible.
- **Snapshot rebuild** (e.g. the `RUNTIME_LAYER_VERSION` bump): reap warm
  sandboxes built from a stale hash; refill rebuilds against the new one.
- **Leak/orphan**: claimed-but-never-finalized → reap after timeout; maintenance
  sweep already exists for stuck rows.
- **Billing**: warm time is platform overhead, not user session time — don't
  meter it against the user until claim.
- **Provider**: Daytona-only for v1 (local_docker pool is trivial/irrelevant).

## Staged rollout

1. Config schema + metadata sync + UI toggle (no behavior yet). Low risk.
2. DB fields + pool manager refill/reap (creates parked sandboxes; not yet
   claimed) behind a global `KORTIX_WARM_POOL_ENABLED` flag, off by default.
3. Daemon await-claim mode + claim API + claim path in `createProjectSession`
   with pool-miss fallback. Behind the flag.
4. Flip default on (after cost gating from the "Cost" section is in place).

## Open decisions (need sign-off before stage 3)

1. **Warmth**: option B (pre-boot, ~5–7s saved) vs A (container-only, ~1.3s).
   Recommend B.
2. **Default-on cost**: accept one idle sandbox per active project? Gate by
   recent-activity / plan / global cap? This gates flipping the default.
