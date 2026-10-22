// Migration: session_sandboxes_parked_verified_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds the index the parked-runtime verification sweep scans with. The
// Supabase slow-query collector (KRTX-1307) reports the statement of
// `verifyParkedRuntimes` (apps/api/src/projects/reaping/
// parked-runtime-verification.ts) at a mean of 3027 ms over 1704 calls: every
// pass read every `stopped` row with an external id (~45.6k) and sorted them
// by `metadata->>'parkedVerifiedAt'` to hand back LIMIT 60 — a parallel Seq
// Scan + Sort in the prod plan. This index lets the planner walk the
// `stopped` entries already in that exact order and stop after 60.
//
// Declared in packages/db/src/schema/kortix.ts (schema contract requires
// every built index to be declared there). Shape notes:
//   - `status` is the leading KEY, not a partial-index predicate: the app
//     binds it as a query parameter, and a generic plan cannot prove
//     `status = $1` implies `status = 'stopped'`, so a partial index on the
//     status would fall out of the plan after the first few executions.
//     `external_id IS NOT NULL` is static in the statement, so it CAN stay a
//     partial predicate.
//   - The expression is declared `ASC NULLS FIRST` to match the query's
//     `order by … asc nulls first` exactly (Postgres's ASC default is
//     NULLS LAST, which would leave the sort in the plan).
//
// House .concurrent.ts rules (lint-enforced): ONE concurrent operation, IF NOT
// EXISTS so a re-run is safe, lock_timeout 180s (never the 2-5s plain-migration
// value: CONCURRENTLY waits on every older transaction and lock_timeout governs
// that wait), generous statement_timeout.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string.
  // Postgres's simple query protocol treats a single query string containing
  // multiple ;-separated statements as an IMPLICIT transaction block -- which
  // silently defeats pgm.noTransaction() (CONCURRENTLY still fails with
  // "cannot run inside a transaction block") even though noTransaction() IS
  // working correctly at the node-pg-migrate level. One statement per call.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_session_sandboxes_parked_verified
      on kortix.session_sandboxes (status, (metadata ->> 'parkedVerifiedAt') asc nulls first)
      where external_id is not null
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
