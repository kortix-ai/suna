-- Migration: session_sandboxes_wake_fence_stats
--
-- Extended statistics on the two jsonb expressions that decide whether a
-- stopped sandbox row is a runtime-wake candidate. Without them the planner
-- defaults both `metadata->>'runtimeWakeId' IS NOT NULL` and the
-- `runtimeWakeCleanupUntilAt` regex match to ~50 % selectivity, so the wake
-- reconciliation scan (apps/api/src/projects/session-lifecycle/
-- runtime-wake-maintenance.ts `reconcileRuntimeWakeFences`) is costed as
-- "57k of 65k rows match" and the planner keeps its seq scan even after the
-- partial index of the next migration exists: under `LIMIT 100` a scan that
-- believes it fills the limit after ~1/540th of the table always looks free.
-- With real counts (~600 of 65450 rows on prod carry either key) the index
-- path wins and the statement drops from a full-table scan (mean 1540 ms over
-- 11572 calls on the pre-KRTX-267 shape, 3943 ms over 1278 calls on the
-- current shape — pg_stat_statements, 2026-10-03) to ~600 candidate rows.
--
-- Only the two keys of the index predicate itself: the remaining wake-lease
-- quals only filter candidates the index already found, so their selectivity
-- does not change the plan choice. Analysis runs here (not left to
-- autovacuum) so the estimate is real the moment the migration commits.

set lock_timeout = '2s';
set statement_timeout = '30s';

create statistics if not exists kortix.session_sandboxes_wake_fence_stats (mcv)
  on (metadata->>'runtimeWakeId'), (metadata->>'runtimeWakeCleanupUntilAt')
  from kortix.session_sandboxes;

analyze kortix.session_sandboxes;
