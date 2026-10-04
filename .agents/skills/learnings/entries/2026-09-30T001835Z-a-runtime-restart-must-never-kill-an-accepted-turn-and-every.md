---
recorded: 2026-09-30T00:18:35Z
incident_date: 2026-09-29
---
# A runtime restart must never kill an accepted turn, and every turn end must be relayed by its own identity

**Rule:** Any code path that respawns or kills a session's runtime process
(a `/kortix/env` config push, an agent swap, a config-release converge, a
manual restart) MUST ask a `turnInFlight`/`mayPromote` oracle immediately
before the irreversible kill — never only before starting the work — and
must decline (defer to the next `session.idle` boundary, never a timer) when
the answer is `true` or unknown. Separately: any code that locally finalizes
a turn the runtime lost (an abort against a process that never held the
turn's generation) MUST relay that turn's end to the control plane keyed by
the turn's OWN identity (its prompt message id), never by scanning for "the
newest completed turn" — a process that never held the generation stamps
neither `time.completed` nor an error, so that scan finds the turn BEFORE it,
already relayed, and skips forever. A control-plane record with no identity
at all (no `messageId`) needs its OWN age+identity ceiling, independent of
runtime observation, because the daemon's turn-in-flight oracle deliberately
reads an orphaned-but-open assistant message as "in flight" (to protect a
genuine husk recovery) and can never resolve it to terminal on its own.

**Trigger surface:** Writing or reviewing any of: a daemon route that can
respawn OpenCode (`/kortix/env`, `/kortix/refresh`, agent-swap,
config-release convergence); a turn-end relay path
(`relayTurnEndToApi`/`reconcileFinishedFirstTurn`/orphan finalization); or an
API-side reaper rule that decides whether an `active` turn record still
holds authority.

**Incident:** v0.13.42, deployed 2026-09-29T19:45Z. Five keyed trigger
sessions (company project) and any long-lived session across the deploy hit
it within 30 minutes. `GET .../turn` showed `state:"active"`,
`message_id:null` for hours; OpenCode was idle (`/session/status` -> `{}`);
only `kortix sessions stop` cleared it. Root cause chain:
1. `applyOpencodeRuntimeEnv` (control.ts) compared a pushed
   `KORTIX_SECRET_CAPABILITIES` value against `process.env`, which resets on
   every daemon restart (an agent swap, a redeploy) — the FIRST push after
   any restart read an unchanged value as "changed" and forced a respawn.
2. That respawn's `reloadConfig({ mustRespawn: true })` call had no
   `mayPromote` turn check at all — unlike the agent-swap path
   (`runtime-assets.ts`) and the config-release path (`config-release.ts`),
   which both defer on `turn-in-flight`. A turn accepted 200ms before the
   SIGTERM was killed mid-acceptance.
3. `finalizeOrphanedTurn`'s abort landed on a process that never held that
   turn's generation, so it stamped neither `time.completed` nor an error.
   `relayTurnEndToApi`'s "newest completed turn" scan kept finding the
   PREVIOUS turn, already relayed, and skipped — every 30s, for hours.
4. The stuck record also had no `messageId` (the runtime died before
   `relayTurnBeginToApi` ever ran), so `observeSandboxTurn`'s daemon probe
   was root-scoped, and the daemon's oracle read the orphaned-but-open
   assistant message as "in flight" — the existing reaper's terminal
   branches never fired.

Fixed same-day, one PR, `kortix-ai/suna#8329`, merged `eff89344644a27a`:
(1) persist the applied opencode runtime env to disk and restore it into
`process.env` before OpenCode's first spawn, so a fresh daemon process does
not read its own restart as a config change; (2) thread `mayPromote` through
`reloadConfig` into `reloadVerified`'s existing last-moment gate, deferring a
declined restart to the next `session.idle`; (3) relay an orphaned turn's own
end (`relayOrphanedTurnEndToApi`) keyed by its own prompt id; (4) an
API-side backstop, `turnNoBeginRelayMaxMs()` (default 30 min): an `active`
turn past this ceiling with no `messageId` is settled `runtime_gone` on
age+identity alone.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/env-restart-defers-live-turn.test.ts`
(a `mustRespawn` reload always carries `mayPromote`, and a declined restart
retries at the next idle boundary);
`apps/kortix-sandbox-agent-server/src/__tests__/opencode-runtime-env-survives-daemon-restart.test.ts`
(a byte-identical push after a simulated daemon restart does not respawn,
with a negative control proving the amnesia reproduces without the fix);
`apps/kortix-sandbox-agent-server/src/__tests__/orphaned-turn-relay-identity.test.ts`
(an orphaned turn relays its own end even though the previous turn's
signature is already relayed, at most once across repeated finalize calls);
`apps/api/src/services/sandboxes/sandbox-reaper.test.ts` (3 cases for the no-messageId
ceiling: settles past 30 min even while the daemon insists active, leaves a
young record alone, and a `delivering` record is not settled by this path).
