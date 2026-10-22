---
recorded: 2026-10-02T16:48:22Z
incident_date: 2026-10-02
---
# Restart the dev API before you measure it: every bun --hot reload keeps the previous instance's database connections and worker loops

**Rule:** Restart the local stack (`pnpm worktree stop <name>`, then `start`) before a
latency benchmark, a statement trace, or any timing claim. Do not edit a file under
`apps/api/src`, `packages/db/src` or `packages/sdk/src` while a measurement runs: the dev
API runs `bun --hot src/index.ts` and re-evaluates on every save. Each reload keeps the
previous module instance's request pool, its LISTEN connection, its leader-election
connection and its worker loops. Run agents that edit those trees before or after the
measurement, never during it.

**Trigger surface:** Running `apps/api/scripts/prompt-latency-bench.ts` or any
`Server-Timing` comparison on a worktree stack; several agents or people editing one
worktree while its stack is up; a local Postgres that answers
`remaining connection slots are reserved` during `tests/bin/db-suites.ts`.

**Incident:** 2026-10-02, the hot-path performance branch, local only. Four writers
edited one worktree for about 1 h with the stack running. The API held 95 of the local
Postgres's 100 connections (about 58 leader-election, 31 LISTEN, the rest pools of dead
instances). The tunnel forwarder loop ran once per reload, 2,300 statements per minute
instead of 380. Each statement took 300 to 850 ms instead of 105 ms at 50 ms RTT, so a
prompt delivery read 12 to 17 s instead of 4.3 s, and `db-suites` could not build its
template. Two agents took before/after numbers in that window and had to repeat them.
No deployed environment runs `--hot`.

**Enforcement:** `apps/api/scripts/prompt-latency-bench.ts` reads `started_at` from
`GET /v1/health` before and after a run and fails when it changed, so a run that crossed
a reload produces no table. The runbook
(`.agents/skills/testing/references/api-latency-baseline.md`) starts every arm with a
stack restart. Not enforced: a reload BEFORE the run. The enforcer to build is a
dev-only teardown of the previous instance's connections and loops on hot reload
(`shared/leader-election.ts`, `shared/pg-broadcast.ts`, `shared/db.ts`, the worker loops
in `bootstrap.ts`), with a test that reloads twice and counts `pg_stat_activity`.
