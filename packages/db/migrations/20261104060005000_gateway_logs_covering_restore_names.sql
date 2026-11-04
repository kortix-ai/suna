-- Migration: gateway_logs_covering_restore_names
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- KRTX-4023, final step of the replace dance. The two replacement indexes
-- built by 20261104060001000 and 20261104060002000 (old dominated indexes
-- dropped by 20261104060003000 and 20261104060004000) now take back the
-- canonical names the drizzle schema contract declares
-- (packages/db/src/schema/kortix.ts declares both by relation only; INCLUDE
-- lists are inexpressible there).
--
-- mixed-version-safe: this renames indexes 20261104060001000 and
-- 20261104060002000 just built; the planner matches indexes by definition,
-- never by name, and no code references index names, so old and new code are
-- served identically before and after the rename. ALTER INDEX ... RENAME is a
-- catalog-only change under a brief lock on the index itself.

ALTER INDEX IF EXISTS "kortix"."idx_gateway_logs_project_time_covering_llm"
  RENAME TO "idx_gateway_logs_project_time_covering";--> statement-breakpoint
ALTER INDEX IF EXISTS "kortix"."idx_gateway_logs_project_session_time_llm"
  RENAME TO "idx_gateway_logs_project_session_time";
