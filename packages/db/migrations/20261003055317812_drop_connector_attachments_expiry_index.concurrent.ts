// Migration: drop_connector_attachments_expiry_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_connector_attachments_expiry` (btree (expires_at) on
// `kortix.connector_attachments`), reported by the Supabase performance
// advisor (lint unused_index) and confirmed unused on the prod database:
// `pg_stat_user_indexes.idx_scan = 0` since the index was created, while its
// sibling `idx_connector_attachments_scope` shows scans (2026-10-03).
//
// The index also cannot serve its only candidate consumer. The expiry sweeper
// (`cleanupExpiredConnectorAttachments` in apps/api/src/connectors/attachments.ts)
// filters `expires_at < now OR (status = 'consumed' AND consumed_at < grace)`.
// The second branch has no index, so Postgres cannot build the BitmapOr the
// first branch's index would need: EXPLAIN on prod plans the exact predicate
// as a Seq Scan. Rows are transient by design (the sweeper deletes them after
// the TTL or the consumed grace), so the table stays small and a seq scan
// stays the right plan as it grows.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// mixed-version-safe: the index is plain, non-unique, and backs no constraint,
// ON CONFLICT clause, view or policy (pg_depend on prod shows only the
// automatic table dependency). No code names it (a repo grep finds it only in
// the kortix.ts declaration this PR removes and the drizzle snapshots), and
// dropping it cannot change any query plan: it was never scanned. A
// still-running older image plans the sweeper through the same Seq Scan as
// before.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql('drop index concurrently if exists kortix.idx_connector_attachments_expiry');
};

// Forward-only: a future sweeper that can use an expires_at index re-declares
// and re-builds it (create index concurrently).
export const down = false;
