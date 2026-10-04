-- Migration: legacy_sandbox_migrations_drop_opencode_archive
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- DROP COLUMN is a catalog-only change: no table rewrite. Only the ops
-- overview reads this table (a GROUP BY status count).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- `opencode_archive` held a legacy sandbox's OpenCode chat archive for 3 days
-- (2026-05-30 to 2026-06-02). Commit 089128c8d6 moved the archive to object
-- storage, and #4592 (2026-07-13) removed the last code that read or wrote the
-- column. Nothing has referenced it since: `apps/api/src/http/ops/index.ts` selects
-- only `status`, and `packages/db/src/schema/kortix.ts` does not declare the
-- table.
--
-- mixed-version-safe: no deployed API version since 2026-07-13 reads or writes opencode_archive; the only reader of this table selects status alone.
-- squawk-ignore ban-drop-column
ALTER TABLE "kortix"."legacy_sandbox_migrations" DROP COLUMN IF EXISTS "opencode_archive";
