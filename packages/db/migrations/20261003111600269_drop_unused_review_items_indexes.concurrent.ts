// Migration: drop_unused_review_items_indexes  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops the three kortix.review_items indexes the Supabase performance advisor
// reports as unused (lint unused_index), plus the same evidence in
// pg_stat_user_indexes on prod (read 2026-10-03): every one has idx_scan = 0.
//
//   idx_review_items_project         (project_id)          0 scans
//   idx_review_items_project_status  (project_id, status)  0 scans
//   idx_review_items_created         (created_at)          0 scans
//
// The kept idx_review_items_project_kind (project_id, kind) serves every read
// (60,830 scans): the review-inbox endpoint is polled every 8-20s and all of
// its queries filter project_id, with kind/status as optional extra predicates
// (apps/api/src/projects/review-items.ts). Its project_id prefix covers
// project-only filters; created_at only ever appears as an ORDER BY inside a
// project filter, so the global created_at index was never usable.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// Three statements, one file (same shape as drop_unused_audit_events_indexes):
// each is IF EXISTS and independent, so a re-run after a partial failure is
// safe and no state needs all-or-nothing. They stay separate pgm.sql() calls:
// a multi-statement string is an implicit transaction and CONCURRENTLY would
// fail inside it.

export const shorthands = undefined;

// mixed-version-safe: read-path only. No application code names these indexes
// (a git grep of the three names over the repo finds only the schema and the
// snapshot). None is unique, backs a constraint, or serves an ON CONFLICT
// target (review_items has no upsert; the only constraint index is
// review_items_pkey, kept). The three foreign keys on review_items point
// outward, so their referential checks use the referenced tables' indexes.
// A still-running older API image plans the same queries through
// idx_review_items_project_kind's project_id prefix after the drop.
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql('drop index concurrently if exists kortix.idx_review_items_project');
  pgm.sql('drop index concurrently if exists kortix.idx_review_items_project_status');
  pgm.sql('drop index concurrently if exists kortix.idx_review_items_created');
};

// Forward-only. Re-creating never-scanned indexes would re-impose their write
// cost on every review-items INSERT/UPDATE.
export const down = false;
