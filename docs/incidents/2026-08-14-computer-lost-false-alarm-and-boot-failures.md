# "Computer was lost" false alarm and nightly new-sandbox boot failures

Date: 2026-08-14 (window 18:14–18:36 UTC = 23:44–00:06 IST)

Environment: local dev stack (`pnpm dev`) against the shared provider org

Status: root-caused; fixes not yet shipped

Severity: local-dev outage window; plus one product defect (misleading loss
classification) and one cross-environment defect (orphan-reaper label
collision) that affect the shared dev fleet

## TL;DR

**Neither computer was lost on the provider side. Both sandboxes are alive.**
The "This session's computer was lost" screen fired for two sandboxes whose
provider control planes report them running at the time of writing:

| Provider | External id | Provider state (verified 2026-08-14 ~18:40Z) |
| --- | --- | --- |
| daytona | `168119c9-e984-4025-aadb-e6aad5f32ee2` | `state: "started"`, `errorReason: null` |
| platinum | `sbx_01M00QP8ZD8BV4DHJACYMR5EH4` | `state: "running"`, agent heartbeating, `deletedAt: null` |

The real failure: the local stack's cloudflared quick tunnel
(`scheduling-tampa-development-patents.trycloudflare.com`) was dead. Every
sandbox is born with `KORTIX_REPO_URL` / `KORTIX_API_URL` pointing at that
tunnel, so the guest could not clone the project repo and never became ready.
After 5 minutes of `not_ready`, the session-open path files this as
`runtime_boot_failed` **and preserves the runtime identity as unavailable** —
which the web UI renders with copy that blames the provider: "Its cloud sandbox
disappeared on the provider side." That copy was false in both cases.

This is distinct from Domagoj's 2026-08-13 prod incident (session `ad4b63ac`,
`sbx_01KZP370WDB8DGYNAQM1B875VR`), where Platinum's reconciler really did
delete a sandbox. That one is a genuine provider-side loss, handled by
PR #6438 and the report in the platinum repo. Tonight's events are not that.

## Observed symptoms

1. ~23:50 IST: a new session's sandbox "never starts" — recurring "every day
   this same time at night ... since 2-3 days".
2. ~23:56–23:58 IST: "This session's computer was lost" for a daytona box and
   a platinum box, from the same project
   (`d4914405-5405-451e-b5a4-208b4ad2d854`).

## Verified chain of events (all times UTC; IST = UTC+5:30)

| Time | Event | Evidence |
| --- | --- | --- |
| 18:14:01 | Platinum box `sbx_01M00QP...` created for session `3b2e5540` | local DB `session_sandboxes.created_at`; Platinum `createdAt: 18:14:02.280Z` |
| 18:19:32 | Daytona box `168119c9` created for session `7f438fca` (warm-pool, provider-create 1.28 s) | DB row + Daytona `createdAt: 18:19:32.397Z` |
| 18:19:51 | Daytona box runtime readiness wait starts, reason `not_ready` — the guest cannot clone through the dead tunnel | DB `metadata.opencodeReadyWaitStartedAt` |
| 18:24:51 | 5-minute stale-boot threshold hit on session open → identity preserved, `stopReason: runtime_boot_failed` → **"computer was lost" screen** (daytona) | DB `metadata.stoppedAt`, `preservedExternalId` |
| ~18:26 | Same for the platinum session (first preserve at 18:27:15) → second "computer was lost" screen | DB metadata (later overwritten by the 18:35:39 re-preserve) |
| 18:26:57–58 | Parked-runtime sweep asks Daytona, gets a settled present state, **heals the daytona row** — clears the "unavailable" flag it had set ~2 min earlier | DB `parkedVerifiedAt: 18:26:57.646`, `runtimeRestoredAt: 18:26:58.421` |
| 18:29:58 | The local stack is restarted (`pnpm dev`); new cloudflared tunnel minted at 18:30:01 | `ps -o lstart` on `dev-local.sh` and `cloudflared` |
| 18:30:36 | Restarted stack re-opens the platinum session; the box still carries the OLD tunnel URL baked into its env, so it still cannot become ready | DB `opencodeReadyWaitStartedAt: 18:30:36.433Z` |
| 18:35:39 | Platinum session preserved again, `runtimeIdentityState: unavailable` — stuck on the "lost" screen while its box runs | DB row |
| ~18:36 | Platinum agent telemetry still heartbeating from the "lost" box: `runtimeReason: "git clone failed after 4 attempt(s): ... fatal: unable to access 'https://scheduling-tampa-development-patents.trycloudflare.com/v1/git/d491440...'"` | `GET https://api.platinum.dev/v1/sandboxes/sbx_01M00QP8ZD8BV4DHJACYMR5EH4` |

The Platinum telemetry line is the provider-side proof Marko asked for — it
records the exact failing operation (git clone) and the exact failing URL (the
dead local tunnel), from inside the supposedly "lost" box, 9 minutes after the
UI declared it gone.

Direct probe of the tunnel: `curl https://scheduling-tampa-development-patents.trycloudflare.com/v1/health`
→ curl exit with HTTP code `000` (unreachable).

## Root causes

### 1. Dead local tunnel → every new sandbox is born broken (trigger)

`scripts/dev-local.sh` mints a trycloudflare quick tunnel once at stack start
and bakes its URL into every sandbox's env (`KORTIX_REPO_URL`,
`KORTIX_API_URL`, `KORTIX_LLM_BASE_URL`). Quick tunnels die server-side while
the local `cloudflared` process stays up. After the tunnel dies:

- every NEW sandbox boots, fails `git clone`, and never reaches ready;
- every EXISTING sandbox keeps the dead URL forever — even after the stack
  restarts with a fresh tunnel, old boxes can never wake into a working state
  (observed: the platinum session re-failed at 18:30–18:35 against the new
  stack).

Nothing monitors the tunnel, nothing restarts it, and provisioning is not
blocked while it is down.

### 2. `runtime_boot_failed` is rendered as a provider-side loss (product defect)

- `apps/api/src/projects/routes/shared.ts:393` — `STALE_OPENCODE_READY_MS = 5 * 60 * 1000`.
- `shared.ts:1074–1082` — a stale `not_ready` boot calls
  `preserveEstablishedRuntimeOnOpen(..., 'runtime_boot_failed')`, which answers
  `reason: runtime_identity_unavailable`, `retriable: false`.
- `apps/web/src/app/(app)/projects/[id]/sessions/[sessionId]/page.tsx:596–603`
  — that reason renders: "Its cloud sandbox disappeared on the provider side,
  so this session cannot be restarted or recovered."

The helper's own comment says it "serves four unrelated populations (a stalled
provision, a failed wake, a failed boot, a real provider removal) and cannot
tell them apart from the inside." No provider status check is made before
showing the "lost" copy. A local tunnel outage is therefore reported to the
user — and to Better Stack/Sentry via the `runtime.lost` event — as a provider
losing a sandbox.

### 3. Preserve closes billing but leaves the box running (compute leak)

`preserveEstablishedRuntime` (`apps/api/src/projects/runtime-identity.ts`)
calls `endComputeSession` and marks the row `stopped`, but never calls
`provider.stop()`. Both "lost" boxes were still running on their providers
~25 minutes later (Daytona `state: started` with `updatedAt` unchanged since
18:19:33 — no stop ever reached it). Backstops that eventually stop them:
Daytona `autoStopInterval` 720 min; the orphan sweep. Until then the box burns
unmetered compute.

### 4. Cross-environment orphan-reaper label collision (secondary, all-day)

`apps/api/.env` sets `INTERNAL_KORTIX_ENV=dev`, so laptop-created boxes carry
the SAME `kortix.env=dev` label as the deployed dev fleet (verified on the live
Daytona box). The orphan sweep (`projects/reaping/orphan-boxes.ts`) stops any
running `kortix.env=dev` box older than 60 min that has no row in ITS OWN
database. Consequences, both directions:

- the deployed dev API stops laptop-created boxes (no rows in the dev DB). Local
  DB fingerprint: boxes reconciled `provider_reconcile` at ages 70, 70, 70, 78
  min — 60-min grace + hourly sweep — some only 2–13 min after last use
  (mid-work);
- the laptop stops deployed-dev users' boxes (no rows in the local DB) on the
  same schedule, whenever `pnpm dev` is running with the shared org keys.

This matches the 2026-08-12 learning "anything created per-deploy needs a
reaper, and the reaper needs a namespace" — the box labels have the namespace,
but local dev squats the `dev` namespace.

## The nightly pattern

Local DB, stop reasons by hour, last 6 days: failures cluster in the 18:00Z
hour (23:30–00:30 IST) on Aug 9 (`runtime_wake_failed`), Aug 12
(`runtime_wake_failed` + 2× `deadline_expired`), and Aug 14 (2×
`runtime_boot_failed`, 4× `provider_reconcile`). This is consistent with the
reported "same time every night since 2-3 days".

**Unverified:** why the tunnel dies in that window. Most plausible: the quick
tunnel's server-side lifetime expiring at a fixed offset from the morning stack
start. No local API/cloudflared logs are persisted, so the exact death time of
the tunnel cannot be recovered. Corrective action 6 closes this gap.

## Impact

- Local dev, 18:14–18:36Z: 2 sessions unrecoverable-by-UI on a healthy provider fleet;
  every new session in the window failed to boot.
- One session (`3b2e5540`, platinum) is still stuck on the "lost" screen while
  its box runs.
- 2 false `runtime.lost` alerts (the event created to catch REAL provider
  losses after #6438) — alert noise that will desensitize us to the genuine
  class.
- Dev-fleet users: hourly risk of mid-session provider stops from any laptop
  running `pnpm dev` (root cause 4). Wake usually recovers these, so the
  symptom is "my sandbox randomly stopped", not data loss.
- No data loss anywhere: repos live in the project git remote; both boxes are
  intact.

## Corrective actions

1. **Truthful classification.** Show the "computer was lost" copy only when a
   fresh `provider.getStatus()` returns `removed` at preserve time. A failed
   boot gets its own screen ("The computer could not start", retriable) and its
   own stop reason surface. Files: `shared.ts` (preserve call sites),
   `page.tsx:596`.

   **Stop-reason surface: shipped.** `stopReason` was already written by every
   path that parks a box, and read by nothing the user could see — so every
   stop, routine or not, rendered the same unexplained "<sandbox> is stopped".
   The catalogue now lives in `@kortix/api-contract` (the server re-exports it,
   so there is one list), is serialized as the typed
   `ProjectSessionSandbox.stop_reason` rather than left in the metadata blob,
   and `features/session/stop-reason-copy.ts` maps every member to its own
   words — exhaustively, so a reason added later is a compile error rather than
   a session that says nothing. A boot failure now reads "Computer could not
   finish starting … the agent runtime never became reachable inside it",
   which is what a dead tunnel actually looks like from the outside.

   The gate half of this action (only a verified `removed` may classify a loss)
   shipped earlier with `runtimeLossVerdict`.
2. **Surface the guest's own reason.** Platinum already reports
   `runtimeReason: "git clone failed ... <url>"` in sandbox metadata; pipe it
   into the boot-failure screen so a dead tunnel names itself.
3. **Stop the box when preserving.** `preserveEstablishedRuntime` must call
   `provider.stop()` (best-effort) after closing metering, or enqueue the box
   for the reaper explicitly.
4. **Tunnel liveness.** `scripts/dev-local.sh`: probe `KORTIX_URL/v1/health`
   through the tunnel every 60 s; on failure restart cloudflared, update
   `KORTIX_URL`, and block new provisions with an explicit "local tunnel down"
   error until it passes. Consider a named tunnel for stability.
5. **Own env namespace for laptops.** Set `INTERNAL_KORTIX_ENV=local` (or
   `local-<user>`) in `apps/api/.env` so laptop boxes never share the deployed
   dev label namespace; audit `orphan-boxes.ts` against the remaining shared
   labels. Kill switch exists today: `KORTIX_ORPHAN_BOX_REAP_ENABLED=false`.
6. **Persist local stack logs.** `dev-local.sh` should tee API + cloudflared
   output to a dated file so the next nightly incident is diagnosable.
7. **Alert hygiene.** `runtime.lost` must carry a `providerVerified` flag;
   alerts route only on verified losses.

After these ship, append the learning to `.claude/skills/learnings/SKILL.md`.
Candidate rule: *"Never render or alert a provider-side loss that the provider
was not asked about — a loss verdict requires a fresh `getStatus() ===
'removed'` at classification time."*

## Verification appendix (exact commands)

```sh
# 1. Daytona control plane — box alive (key from apps/api/.env via dotenvx)
curl -H "Authorization: Bearer $DAYTONA_API_KEY" \
  https://app.daytona.io/api/sandbox/168119c9-e984-4025-aadb-e6aad5f32ee2 \
  | jq '{state, desiredState, errorReason, createdAt, updatedAt, labels}'
# → state "started", desiredState "started", errorReason null,
#   labels {"kortix.env":"dev","kortix.managed":"true", ...}

# 2. Platinum control plane — box alive, telemetry names the real failure
curl -H "Authorization: Bearer $PLATINUM_API_KEY" \
  https://api.platinum.dev/v1/sandboxes/sbx_01M00QP8ZD8BV4DHJACYMR5EH4 \
  | jq '{state, deletedAt, agent: .metadata.agent}'
# → state "running", deletedAt null,
#   agent.runtimeReason "git clone failed after 4 attempt(s): ...
#   unable to access 'https://scheduling-tampa-development-patents.trycloudflare.com/...'"

# 3. The tunnel those boxes were given is dead
curl -s -o /dev/null -w '%{http_code}' \
  https://scheduling-tampa-development-patents.trycloudflare.com/v1/health   # → 000

# 4. Local DB — both rows are runtime_boot_failed, not provider_removed
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "
SELECT provider, external_id, status, metadata->>'stopReason',
       metadata->>'runtimeIdentityState'
FROM kortix.session_sandboxes
WHERE external_id IN ('sbx_01M00QP8ZD8BV4DHJACYMR5EH4',
                      '168119c9-e984-4025-aadb-e6aad5f32ee2');"

# 5. Reaper-collision fingerprint — provider_reconcile at 70/70/70/78 min ages
psql ... -c "SELECT provider, created_at, metadata->>'stoppedAt',
  round(extract(epoch FROM ((metadata->>'stoppedAt')::timestamptz - created_at))/60) AS age_min
  FROM kortix.session_sandboxes
  WHERE metadata->>'stopReason'='provider_reconcile'
  ORDER BY 3 DESC;"
```
