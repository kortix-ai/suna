// Migration: drop_unused_project_user_provider_connections_connection_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.project_user_provider_connections_connection` (btree on
// `connection_id`, built 2026-09-14 by 20260914201549272): the Supabase
// performance advisor flags it as unused (lint unused_index, level INFO,
// observed 2026-10-02). pg_stat_user_indexes on the prod project confirms
// idx_scan = 0, idx_tup_read = 0 since creation (read 2026-10-03). Every
// extra index costs an index write on each INSERT/UPDATE/DELETE of the row,
// for nothing: Postgres plans by shape, never by index name.
//
// The only reads of this table filter on `user_id` (+ `project_id` /
// `provider_id`) or join through `connection_id` together with `user_id`
// (apps/api/src/iam/account-identity.ts), so the planner never picked the
// bare `connection_id` index: every query also constrains `user_id`, and
// the PK (project_id, user_id, provider_id) or a seq scan served them.
//
// The one theoretical consumer is the FK `project_user_provider_connections_owner_fk`
// (ON DELETE cascade): a delete on `user_provider_connections` can scan this
// table for referencing rows. idx_scan = 0 covers those scans too — none has
// ever used the index (the table is empty on prod today; the planner seq-scans
// it instead). If the table ever grows and parent deletes become frequent, a
// covering index is one `pnpm migrate:create <slug> --concurrent` away.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// mixed-version-safe: drops a plain non-unique secondary index. Nothing in
// the repo names it (a grep of both schemas, migrations, apps and packages
// finds only its CREATE and this drop), and no constraint, ON CONFLICT
// clause, view or policy depends on a non-unique index. A still-running
// older image plans the same queries; it only loses an option it never chose
// (idx_scan = 0), so the drop cannot fail or slow a query measurably.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql("set lock_timeout = '180s'");
  pgm.sql("set statement_timeout = '30min'");
  pgm.sql("drop index concurrently if exists kortix.project_user_provider_connections_connection");
};

// Forward-only: the same concurrent flow rebuilds this index if a query ever
// needs it.
export const down = false;
