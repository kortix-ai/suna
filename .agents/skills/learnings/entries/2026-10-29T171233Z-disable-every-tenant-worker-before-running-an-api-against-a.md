---
recorded: 2026-10-29T17:12:33Z
incident_date: 2026-10-29
---
# Disable tenant startup workers before running an API against a branch database

**Rule:** Start branch-database verification with `KORTIX_WORKERS_ENABLED=false` and
`KORTIX_SKIP_STARTUP_PREBUILD=true`. Disable replica consumers, singleton workers,
connector warmers, unscoped tunnel cleanup, and snapshot builds before accepting requests.
Keep relay-owned RPC transport; copied-queue Apps request kicks still need a separate ownership enforcer.
**Trigger surface:** `pnpm worktree start` against a copied branch database with real provider credentials.
**Incident:** 2026-10-29, PR #11098 verification. Two API launches processed 14 account cleanups:
8 own fixtures and 6 inherited synthetic users already deleted from shared auth before branch creation.
Branch queries found 0 retained job, lifecycle, event-poll, subscription, or session rows updated in either window.
Workers logged 6 successful volume DELETEs: 4 fixture names and 2 names with unproven ownership.
DELETE used `missing_ok=true`; retained logs cannot prove whether the last 2 removed existing volumes.
Snapshot startup attempted 5 context uploads across 4 build names. Both API processes were stopped.
**Enforcement:** `unit-bootstrap-workers.test.ts` exercises real API-only boot; `tunnel-worker.test.ts`
advances timers, keeps RPC transport, and rejects tenant cleanup. `scripts/worktree/__tests__/launch-env.test.ts`
pins workers-off branch defaults. Prove API-only startup and `/v1/health` before starting a synthetic flow.
