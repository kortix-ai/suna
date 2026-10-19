---
recorded: 2026-10-19T23:03:38Z
incident_date: 2026-10-19
---
# Compare a uuid column to a ::uuid parameter, never through ::text, and keep a partial index's predicate columns as SQL literals

**Rule:** Write `col = ${x}::uuid` for a uuid column, never `col::text = ${x}`. Check `isUuid(x)` first when `x` is user input, because a bad uuid raises `22P02`. When a query must use a partial index, write the predicate's columns as SQL literals (`status = 'queued'`), not as bound parameters: a generic prepared plan cannot prove `status = $n` implies the index predicate.

**Trigger surface:** Writing raw `sql` that filters a uuid column, or adding a partial index for a query that Drizzle builds with `eq()`.

**Incident:** 2026-10-19, prod `pg_stat_statements`. The IAM principal resolve compared `auth.users.id::text` and seq-scanned ~411k rows: 1.1M calls at 140 ms mean, 153,651 s in total (fixed in #10327). `isPersonalAccount` had the same cast: 483 ms per call. The lifecycle claim drain (`claimDueLifecycleCommands`, ~3 calls/s) used `(status, available_at)` and detoasted the payload of each held inbox prompt (up to ~10 MB) on every tick: 87 ms mean, ~4,000 buffers, ~28% of one DB core. A partial index fixes it only when `status` is a literal.

**Enforcement:** `apps/api/src/__tests__/unit-no-uuid-text-cast.test.ts` fails on a new `<col>id::text = ${` outside its allowlist. The partial-index rule has none yet: a DB-suite plan assertion under `plan_cache_mode = force_generic_plan` would enforce it.
